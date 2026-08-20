// Local vision server plugin: a same-origin HTTP endpoint that runs the
// recognition pipeline server-side — sharp downscaling, the vision model
// (scene answer), and optionally the OCR model (precise text) — so the
// browser only makes one same-origin POST. This avoids cross-origin fetches
// from embedded WebViews (which can hang) and moves all heavy work onto the
// reliable Node network stack.
//
// Endpoint: POST /vision/recognize
//   body: {
//     model?: string,            // vision model (default qwen3-vl:4b)
//     ocrModel?: string,         // OCR model (default deepseek-ocr)
//     ocrEnabled?: boolean,      // run the OCR pass (default false)
//     question?: string,         // user's question about the image
//     maxImageEdge?: number,     // downscale longest edge (default 1280)
//     images: [{ data: string, mediaType: string }]   // base64 payloads
//   }
//   response: { results: [{ scene: string, text?: string }] }
//
// Deploy by inserting into the web profile's cordis.patch.yml:
//   - id: vision-server
//     name: ./vision-server.mjs
import sharp from 'sharp'

export const name = 'vision-server'
export const inject = ['webServer']

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
const DEFAULT_SYSTEM_PROMPT = '你是图像识别助手。如果用户提出了具体问题，请优先直接回答该问题（不确定的名称如实说明，不要编造）；然后补充必要的画面细节。不要使用任何工具。'
const DEFAULT_OCR_PROMPT = '请提取这张图片中的全部文字内容，按阅读顺序列出，不要描述画面。'

/** Accept only practical per-image budgets from the browser configuration. */
function recognitionTimeoutMs(value, fallback) {
  return Number.isSafeInteger(value) && value >= 10_000 && value <= 600_000
    ? value
    : fallback
}

/** Read the whole request body as a string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** One chat-completion call against the local OpenAI-compatible endpoint. */
async function chatCompletion(baseURL, model, messages, maxTokens, signal) {
  const response = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      num_ctx: 32768,
      temperature: 0,
      messages,
      max_tokens: maxTokens,
      stream: false,
    }),
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`模型 ${model} 请求失败 HTTP ${response.status}${detail === '' ? '' : `：${detail.slice(0, 200)}`}`)
  }
  const payload = await response.json()
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error(`模型 ${model} 返回为空`)
  }
  return content.trim()
}

/** Strip DeepSeek-OCR structural noise. */
function cleanOcrText(text) {
  const lines = []
  for (const raw of String(text).split('\n')) {
    let line = raw.trim()
    if (line.length === 0 || /^<\|.*\|>$/.test(line) || line.startsWith('<|im_')) continue
    line = line
      .replace(/<\|im_start\|>/g, '')
      .replace(/<\|im_end\|>/g, '')
      .replace(/<\|user\|>/g, '')
      .replace(/<\|file:[^>]*\|>/g, '')
      .replace(/<\|[^>]*\|>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\*\*/g, '')
      .replace(/^助理[:：]\s*/, '')
      .replace(/^assistant[:：]\s*/i, '')
      .trim()
    if (line.length > 0 && (lines.length === 0 || lines[lines.length - 1] !== line)) lines.push(line)
  }
  return lines.join('\n')
}

/** Downscale an image buffer with sharp; returns { data, mediaType }. */
async function downscale(data, mediaType, maxEdge) {
  let pipeline = sharp(data, { failOn: 'none' })
  const meta = await pipeline.metadata()
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0)
  if (longest === 0) throw new Error('无法读取图片')
  if (longest <= maxEdge) return { data, mediaType }
  const scale = maxEdge / longest
  const width = Math.max(1, Math.round((meta.width ?? 1) * scale))
  const height = Math.max(1, Math.round((meta.height ?? 1) * scale))
  const resized = await sharp(data, { failOn: 'none' })
    .resize(width, height)
    .jpeg({ quality: 90 })
    .toBuffer()
  return { data: resized, mediaType: 'image/jpeg' }
}

export function apply(ctx, config) {
  const baseURL = config?.baseURL ?? DEFAULT_BASE_URL
  const model = config?.model ?? 'qwen3-vl:4b'
  const ocrModel = config?.ocrModel ?? 'deepseek-ocr'
  const ocrEnabled = config?.ocrEnabled ?? false
  const maxEdge = config?.maxImageEdge ?? 1280
  const perImageTimeoutMs = config?.timeoutMs ?? 240_000

  // attachmentId -> full ref, so GET /vision/image/<id> can read it back.
  // In-memory: refs vanish on restart, and old message image links degrade
  // to their alt text, which is acceptable for pasted-draft attachments.
  const attachmentRefs = new Map()

  ctx.webServer.register({
    kind: 'prefix',
    path: '/vision',
    handler: async (req, res) => {
      const respond = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      const url = (req.url ?? '').split('?')[0]

      // POST /vision/attach — durably store one pasted image and return its id.
      if (url === '/vision/attach' && req.method === 'POST') {
        let parsed
        try {
          parsed = JSON.parse(await readBody(req))
        } catch {
          respond(400, { error: 'invalid json body' })
          return
        }
        if (typeof parsed?.data !== 'string' || parsed.data.length === 0) {
          respond(400, { error: 'data required' })
          return
        }
        const attachments = ctx.get('attachments')
        if (attachments === undefined) {
          respond(503, { error: 'attachment store unavailable' })
          return
        }
        const mediaType = typeof parsed.mediaType === 'string' && parsed.mediaType.length > 0
          ? parsed.mediaType
          : 'image/png'
        try {
          const ref = await attachments.saveImage({
            data: Buffer.from(parsed.data, 'base64'),
            mediaType,
            ...(typeof parsed.name === 'string' && parsed.name.length > 0 ? { name: parsed.name } : {}),
          })
          attachmentRefs.set(ref.attachmentId, ref)
          respond(200, { attachmentId: ref.attachmentId })
        } catch (error) {
          respond(400, { error: error?.message ?? String(error) })
        }
        return
      }

      // GET /vision/image/<attachmentId> — serve the stored image bytes so
      // messages can reference the original picture with a same-origin URL.
      if (url.startsWith('/vision/image/') && req.method === 'GET') {
        const id = decodeURIComponent(url.slice('/vision/image/'.length))
        const ref = attachmentRefs.get(id)
        if (ref === undefined) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('attachment not found')
          return
        }
        const attachments = ctx.get('attachments')
        if (attachments === undefined) {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('attachment store unavailable')
          return
        }
        try {
          const stored = await attachments.readImage(ref)
          res.writeHead(200, { 'Content-Type': ref.mediaType })
          res.end(Buffer.from(stored.data))
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('attachment read failed')
        }
        return
      }

      // POST /vision/recognize — downscale and recognize the images.
      if (url !== '/vision/recognize' || req.method !== 'POST') {
        respond(404, { error: 'not found' })
        return
      }
      let parsed
      try {
        parsed = JSON.parse(await readBody(req))
      } catch {
        respond(400, { error: 'invalid json body' })
        return
      }
      const images = Array.isArray(parsed?.images) ? parsed.images : []
      if (images.length === 0) {
        respond(400, { error: 'images required' })
        return
      }
      const question = typeof parsed.question === 'string' && parsed.question.trim().length > 0
        ? parsed.question.trim()
        : undefined
      const activeModel = typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : model
      const useOcr = (parsed.ocrEnabled ?? ocrEnabled) && ocrModel !== ''
      const recognitionTimeout = recognitionTimeoutMs(parsed.timeoutMs, perImageTimeoutMs)
      const questionPrompt = question === undefined
        ? '请描述这张图片的画面内容：物体、场景、颜色、文字（如有）。'
        : question

      const results = []
      const attachmentIds = []
      try {
        const attachments = ctx.get('attachments')
        for (let index = 0; index < images.length; index += 1) {
          const image = images[index]
          if (typeof image?.data !== 'string' || image.data.length === 0) {
            results.push({ scene: '⚠️ 图片缺少图像数据，无法识别' })
            attachmentIds.push(undefined)
            continue
          }
          const mediaType = typeof image.mediaType === 'string' && image.mediaType.length > 0
            ? image.mediaType
            : 'image/png'
          const buffer = Buffer.from(image.data, 'base64')

          // Store the (already browser-downscaled) image so the conversation
          // can show the original picture via /vision/image/<id>.
          let attachmentId
          if (attachments !== undefined) {
            try {
              const ref = await attachments.saveImage({ data: buffer, mediaType })
              attachmentRefs.set(ref.attachmentId, ref)
              attachmentId = ref.attachmentId
            } catch {
              attachmentId = undefined
            }
          }
          attachmentIds.push(attachmentId)

          const downscaled = await downscale(buffer, mediaType, maxEdge)
          const dataUrl = `data:${downscaled.mediaType};base64,${downscaled.data.toString('base64')}`

          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), recognitionTimeout)
          try {
            // Scene answer from the vision model.
            const scene = await chatCompletion(baseURL, activeModel, [
              { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  { type: 'text', text: questionPrompt },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ], 1500, controller.signal)
            let text
            if (useOcr) {
              const raw = await chatCompletion(baseURL, ocrModel, [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: DEFAULT_OCR_PROMPT },
                    { type: 'image_url', image_url: { url: dataUrl } },
                  ],
                },
              ], 2000, controller.signal)
              const cleaned = cleanOcrText(raw)
              text = cleaned.length > 0 ? cleaned : undefined
            }
            results.push(text === undefined ? { scene } : { scene, text })
          } catch (error) {
            const aborted = error?.name === 'AbortError'
            results.push({
              scene: `⚠️ ${aborted ? '识别超时' : '识别失败'}：${aborted ? `超过 ${recognitionTimeout / 1000} 秒` : error?.message ?? String(error)}`,
            })
          } finally {
            clearTimeout(timer)
          }
        }
        respond(200, { results, attachmentIds })
      } catch (error) {
        respond(500, { error: error?.message ?? String(error) })
      }
    },
  })
}
