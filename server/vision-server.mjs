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
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import sharp from 'sharp'

/** DSH user home (~/.dsh on macOS/Linux, %USERPROFILE%\.dsh on Windows). */
function dshHomePath(...segments) {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), ...segments)
}

export const name = 'vision-server'
export const inject = ['webServer']

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
const DEFAULT_SYSTEM_PROMPT = '你是图片内容记录器，只做客观记录。严格依据图片中实际可见的内容作答：①逐项列出画面里的物体、场景、颜色、文字；②图片中的文字必须原样照抄，不要改写或总结；③不要添加任何推断、解释、背景知识、评价或润色；④不确定的内容直接说"看不清/无法确认"，不要猜测；⑤只描述"图片上有什么"，不要回答"这是什么"之外的问题。'
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

/** One chat-completion call against an OpenAI-compatible endpoint. Local
 * Ollama (no apiKey) may pass num_ctx; remote providers (apiKey set) ignore
 * it, so only include it for the local case. Some remote providers cap
 * max_tokens (Zhipu: 1..1024) — clamp to a safe bound when remote.
 * 429 (rate limit) is retried with backoff so a busy free tier does not
 * block the user's flow — by the time we give up the browser still sends
 * the message with a notice instead of dropping it. */
async function chatCompletion(baseURL, model, messages, maxTokens, signal, numCtx = 32768, apiKey) {
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey !== undefined && apiKey !== '') headers.Authorization = `Bearer ${apiKey}`
  const body = {
    model,
    temperature: 0,
    messages,
    max_tokens: apiKey !== undefined && apiKey !== '' ? Math.min(maxTokens, 1024) : maxTokens,
    stream: false,
  }
  if (apiKey === undefined || apiKey === '') body.num_ctx = numCtx
  const attempts = 3
  let lastDetail = ''
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1200 * attempt))
    }
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    if (response.ok) {
      const payload = await response.json()
      const content = payload?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error(`模型 ${model} 返回为空`)
      }
      return content.trim()
    }
    const detail = await response.text().catch(() => '')
    lastDetail = detail
    // Only 429 (rate limit) is worth retrying; anything else fails fast.
    if (response.status !== 429) break
  }
  throw new Error(`模型 ${model} 请求失败 HTTP 429（限流）${lastDetail === '' ? '' : `：${lastDetail.slice(0, 200)}`}`)
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

/** Normalize an image to the recognition size with sharp; returns { data, mediaType }. */
async function downscale(data, mediaType, maxEdge) {
  // autoOrient(): phone photos carry EXIF orientation (rotate 90/270°).
  // Without applying it the pixels are interpreted upright-unrotated, which
  // for portrait shots renders the content outside the canvas — models then
  // report a "blank/white" image. This fixes that before any resize.
  let pipeline = sharp(data, { failOn: 'none' }).autoOrient()
  const meta = await pipeline.metadata()
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0)
  if (longest === 0) throw new Error('无法读取图片')
  // Oversized images shrink to maxEdge; mid-size images (>= 1024) are
  // upscaled to maxEdge so small text stays legible to the vision encoder
  // (verified: nicknames like 全能王 are misread at 1280 and correct at 2048).
  // Small images stay untouched — upscaling them only wastes tokens.
  const target = longest > maxEdge || (longest >= 1024 && longest < maxEdge) ? maxEdge : longest
  // Always re-encode through autoOrient: even when the size is unchanged, the
  // EXIF rotation must be baked into the pixels (else portrait phone shots
  // render blank for the model). Only skip when the source has no EXIF
  // orientation to apply AND is a JPEG/PNG we can pass through safely.
  const orientation = meta.orientation ?? 1
  if (target === longest && orientation === 1) return { data, mediaType }
  const scale = target / longest
  const width = Math.max(1, Math.round((meta.width ?? 1) * scale))
  const height = Math.max(1, Math.round((meta.height ?? 1) * scale))
  const resized = await sharp(data, { failOn: 'none' })
    .autoOrient()
    .resize(width, height)
    .jpeg({ quality: 90 })
    .toBuffer()
  return { data: resized, mediaType: 'image/jpeg' }
}

export function apply(ctx, config) {
  const baseURL = config?.baseURL ?? DEFAULT_BASE_URL
  const model = config?.model ?? 'qwen3-vl:4b'
  const apiKey = config?.apiKey ?? ''
  const ocrModel = config?.ocrModel ?? 'deepseek-ocr'
  const ocrEnabled = config?.ocrEnabled ?? false
  const maxEdge = config?.maxImageEdge ?? 2048
  const perImageTimeoutMs = config?.timeoutMs ?? 240_000
  const maxUploadBytes = config?.maxUploadBytes ?? 50 * 1024 * 1024
  // KV-cache context window. Small servers (4 GB RAM) must keep this low:
  // a big num_ctx (32768) makes Ollama allocate a huge KV cache and the
  // model load gets OOM-killed. 4096 fits recognition prompts comfortably.
  // Remote providers (apiKey set) ignore num_ctx entirely.
  const numCtx = config?.numCtx ?? 32768
  // Remote provider (apiKey): probe should not check local Ollama residency.
  const remote = apiKey !== undefined && apiKey !== ''

  // upload name -> absolute path, so GET /vision/file/<name> can download.
  const uploadedFiles = new Map()

  // attachmentId -> full ref, so GET /vision/image/<id> can read it back.
  // In-memory: refs vanish on restart, and old message image links degrade
  // to their alt text, which is acceptable for pasted-draft attachments.
  const attachmentRefs = new Map()

  // Models whose warm-up request has been fired (avoid re-firing per probe).
  const warmed = new Set()

  /** List models the service serves (OpenAI-compatible listing). */
  async function listModels(signal) {
    const headers = { Accept: 'application/json' }
    if (remote) headers.Authorization = `Bearer ${apiKey}`
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, { method: 'GET', headers, signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    return (payload?.data ?? []).map((entry) => entry?.id ?? '')
  }

  /** Whether the model is currently loaded (Ollama /api/ps); remote: true. */
  async function modelLoaded(modelName) {
    if (remote) return true
    try {
      const base = baseURL.replace(/\/+$/, '').replace(/\/v1$/, '')
      const response = await fetch(`${base}/api/ps`, { method: 'GET', signal: AbortSignal.timeout(5000) })
      if (!response.ok) return false
      const payload = await response.json()
      return (payload?.models ?? []).some((m) => String(m?.name ?? '').split(':')[0] === modelName.split(':')[0])
    } catch {
      return false
    }
  }

  /**
   * Fire-and-forget warm-up: the first recognition on a cold start pays a
   * model load (seconds to a minute+ on CPU-only Windows). Kicking the load
   * off during the pre-send probe means the real request usually finds the
   * model already loaded. Never awaited; errors are swallowed.
   * Remote providers have nothing to warm locally — skipped.
   */
  function warmUpModel(modelName) {
    if (remote || warmed.has(modelName)) return
    warmed.add(modelName)
    void fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      }),
    }).catch(() => { /* warm-up is best-effort */ })
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: '/vision',
    handler: async (req, res) => {
      const respond = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      const url = (req.url ?? '').split('?')[0]

      // GET /vision/config — the server's effective recognition config, so
      // the browser settings dialog can show what actually runs (local
      // Ollama vs remote provider). apiKey is returned in full (user asked
      // for it to be visible/editable in the dialog).
      if (url === '/vision/config' && req.method === 'GET') {
        respond(200, {
          model,
          baseURL,
          apiKey,
          apiKeySet: typeof apiKey === 'string' && apiKey !== '',
          ocrEnabled,
        })
        return
      }

      // /vision/probe — health check. GET uses the server's patch config;
      // POST accepts per-request { model, baseURL, apiKey } overrides so the
      // settings dialog can test an edited endpoint before saving.
      if (url === '/vision/probe' && (req.method === 'GET' || req.method === 'POST')) {
        let ok = true
        let reason
        let known = []
        let loaded = false
        let probeModel = model
        let probeBaseURL = baseURL
        let probeApiKey = apiKey
        let probeRemote = remote
        if (req.method === 'POST') {
          let parsed
          try {
            parsed = JSON.parse(await readBody(req))
          } catch {
            respond(400, { error: 'invalid json body' })
            return
          }
          if (typeof parsed?.model === 'string' && parsed.model.length > 0) probeModel = parsed.model
          if (typeof parsed?.baseURL === 'string' && parsed.baseURL.length > 0) probeBaseURL = parsed.baseURL
          // Empty/absent apiKey keeps the server's own key (the dialog may
          // show a pre-configured server key without the user retyping it).
          if (typeof parsed?.apiKey === 'string' && parsed.apiKey.length > 0) probeApiKey = parsed.apiKey
          probeRemote = probeApiKey !== ''
        }
        // A real end-to-end connectivity check: ask the configured model a
        // trivial question through the configured endpoint. On success the
        // whole chain (baseURL + apiKey + model) is reachable.
        const probeMessages = [{ role: 'user', content: 'ping' }]
        try {
          const content = await chatCompletion(
            probeBaseURL,
            probeModel,
            probeMessages,
            8,
            AbortSignal.timeout(15000),
            numCtx,
            probeApiKey,
          )
          if (typeof content !== 'string' || content.length === 0) {
            ok = false
            reason = '模型返回为空'
          }
          loaded = probeRemote
        } catch (error) {
          ok = false
          reason = error?.message ?? String(error)
        }
        respond(200, { ok, reason, loaded })
        return
      }

      // POST /vision/upload — store a non-image file in the session workspace
      // when supplied, otherwise in the profile-owned upload directory.
      if (url === '/vision/upload' && req.method === 'POST') {
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
        const decoded = Buffer.from(parsed.data, 'base64')
        if (decoded.byteLength > maxUploadBytes) {
          respond(413, { error: `file exceeds ${maxUploadBytes} bytes` })
          return
        }
        const name = typeof parsed.name === 'string' && parsed.name.length > 0
          ? parsed.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
          : `upload-${Date.now()}`
        try {
          const inWorkspace = typeof parsed.dir === 'string'
            && (await stat(parsed.dir).then(info => info.isDirectory()).catch(() => false))
          const uploadsDir = dshHomePath('vision-uploads')
          if (!inWorkspace) await mkdir(uploadsDir, { recursive: true })
          const target = join(inWorkspace ? parsed.dir : uploadsDir, name)
          await writeFile(target, decoded)
          uploadedFiles.set(name, target)
          respond(200, { path: target })
        } catch (error) {
          respond(500, { error: error?.message ?? String(error) })
        }
        return
      }

      // GET /vision/file/<name> — download an uploaded file (chat links).
      if (url.startsWith('/vision/file/') && req.method === 'GET') {
        const name = decodeURIComponent(url.slice('/vision/file/'.length))
        const path = uploadedFiles.get(name)
        if (path === undefined) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('file not found')
          return
        }
        try {
          const { readFile } = await import('node:fs/promises')
          const data = await readFile(path)
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
          })
          res.end(data)
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('file read failed')
        }
        return
      }

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
      // Per-request endpoint overrides: the browser plugin sends the user's
      // configured baseURL/apiKey (editable in the settings dialog) so a
      // remote provider can be used without touching this server's patch.
      const activeBaseURL = typeof parsed.baseURL === 'string' && parsed.baseURL.length > 0
        ? parsed.baseURL
        : baseURL
      const activeApiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : apiKey
      const activeRemote = activeApiKey !== ''
      const useOcr = (parsed.ocrEnabled ?? ocrEnabled) && ocrModel !== ''
      const recognitionTimeout = recognitionTimeoutMs(parsed.timeoutMs, perImageTimeoutMs)
      const questionPrompt = question === undefined
        ? '请只记录图片中实际可见的内容，逐项列出：物体、场景、颜色、文字（文字原样照抄）。不要推断、不要评价、不要补充背景知识。'
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

          // Downscale ladder: 2048px keeps small text legible, but some
          // aspect ratios push past the model's 4096-token window — fall back
          // to smaller edges when the endpoint reports a context overflow.
          const edgeLadder = [maxEdge, 1536, 1024, 768]
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), recognitionTimeout)
          try {
            let scene
            let text
            let lastError
            for (const edge of edgeLadder) {
              try {
                const downscaled = await downscale(buffer, mediaType, edge)
                const dataUrl = `data:${downscaled.mediaType};base64,${downscaled.data.toString('base64')}`
                scene = await chatCompletion(activeBaseURL, activeModel, [
                  { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: questionPrompt },
                      { type: 'image_url', image_url: { url: dataUrl } },
                    ],
                  },
                ], 1500, controller.signal, numCtx, activeApiKey)
                if (useOcr) {
                  const raw = await chatCompletion(activeBaseURL, ocrModel, [
                    {
                      role: 'user',
                      content: [
                        { type: 'text', text: DEFAULT_OCR_PROMPT },
                        { type: 'image_url', image_url: { url: dataUrl } },
                      ],
                    },
                  ], 2000, controller.signal, numCtx, activeApiKey)
                  const cleaned = cleanOcrText(raw)
                  text = cleaned.length > 0 ? cleaned : undefined
                }
                break
              } catch (error) {
                const message = String(error?.message ?? '')
                if (message.includes('exceeds the available context size') || message.includes('返回为空')) {
                  lastError = error
                  continue
                }
                throw error
              }
            }
            if (scene === undefined) {
              throw lastError ?? new Error('识别失败')
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
