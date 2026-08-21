/**
 * Local vision bridge plugin, browser half: turns pasted images into
 * recognized text before they reach the host.
 *
 * The conversation composer already supports pasting images into the draft
 * rail (ui-conversation's InputBar paste handler). The problem this plugin
 * solves is what happens on send: the host refuses image content unless the
 * routed model declares image input, and a text-only chat model (e.g. the
 * DeepSeek adapter) rejects image blocks outright. Instead of changing any
 * host behavior, the browser half intercepts the outgoing `session.prompt`
 * request, sends each pasted image to a LOCAL Ollama vision model over its
 * OpenAI-compatible endpoint (image bytes never leave the machine), and
 * replaces the image parts with their text descriptions before the request
 * continues to the host. The chat model then sees plain text and answers
 * normally.
 *
 * Patching the global fetch is safe here because `dsh-client-connection`
 * reads `globalThis.fetch` per call (it never caches a reference), and the
 * plugin restores the original on dispose so HMR reloads leave no residue.
 *
 * Configuration lives in `localStorage` under the key `dsh-vision:config`
 * (a JSON object; see {@link DEFAULT_CONFIG}); a future settings surface can
 * own the same values.
 * @module @deepseek-ai/dsh-client-ui-vision-bridge/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Default bridge configuration; overridable per user via localStorage. */
export const DEFAULT_CONFIG = {
  /** Master switch. */
  enabled: true,
  /** Whether pasted images are recognized (needs vision-server + Ollama). */
  recognizeEnabled: true,
  /** Whether the 📎 file-upload button is available (needs upload-server). */
  uploadEnabled: true,
  /** Local vision endpoint (Ollama OpenAI-compatible base URL). */
  baseURL: 'http://127.0.0.1:11434/v1',
  /**
   * Vision model to ask. qwen2.5vl:3b is the fast default; switch to
   * qwen3-vl:4b when dense small-text accuracy matters more than speed.
   */
  model: 'qwen2.5vl:3b',
  /** Per-engine recognition timeout (each OCR/vision call). */
  timeoutMs: 120_000,
  /** Upper bound of images recognized in one message. */
  maxImages: 4,
  /**
   * Longest edge images are downscaled to before recognition. 2048 keeps
   * small text legible (1280 made nicknames like 全能王 unreadable); larger
   * values risk exceeding the model's 4096-token context window.
   */
  maxImageEdge: 2048,
  /** Ollama context window requested for the recognition call. */
  numCtx: 32768,
  /** System prompt for the vision model. */
  systemPrompt: '你是图像识别助手。如果用户提出了具体问题，请优先直接回答该问题（不确定的名称如实说明，不要编造）；然后补充必要的画面细节。不要使用任何工具。',
  /**
   * Dedicated OCR model for precise in-image text extraction (DeepSeek-OCR).
   * Set to `''` to disable OCR and keep only the vision-model description.
   */
  ocrModel: 'deepseek-ocr' as string,
  /**
   * Whether to run the OCR pass. Off by default: the two-model pipeline pays
   * a model-swap load on low-memory machines. Enable it when precise in-image
   * text matters more than speed.
   */
  ocrEnabled: false,
  /** Prompt the OCR engine receives. */
  ocrPrompt: '请提取这张图片中的全部文字内容，按阅读顺序列出，不要描述画面。',
} as const

export type VisionBridgeConfig = typeof DEFAULT_CONFIG

/** Runtime config shape: booleans are mutable (toggled via the indicator). */
export type BridgeConfig = {
  enabled: boolean
  ocrEnabled: boolean
} & Omit<VisionBridgeConfig, 'enabled' | 'ocrEnabled'>

/** The localStorage key carrying user overrides. */
const CONFIG_KEY = 'dsh-vision:config'

/** Extra time for the same-origin response after one recognition budget per image. */
const SERVER_RESPONSE_GRACE_MS = 30_000

/** Largest source image allowed through when browser-side re-encoding fails. */
const MAX_FALLBACK_UPLOAD_BYTES = 2 * 1024 * 1024

/** Read the effective configuration, merging user overrides over defaults. */
export function readConfig(): BridgeConfig {
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        return { ...DEFAULT_CONFIG, ...parsed } as VisionBridgeConfig
      }
    }
  } catch {
    // Malformed user config falls back to defaults.
  }
  return { ...DEFAULT_CONFIG }
}

/** One image part of a `session.prompt` content array. */
interface PromptImagePart {
  type: 'image'
  mediaType?: string
  data?: string
  name?: string
}

/** One text part of a `session.prompt` content array. */
interface PromptTextPart {
  type: 'text'
  text?: string
}

/** The wire envelope shape we care about. */
interface PromptEnvelope {
  type?: string
  method?: string
  payload?: {
    content?: (PromptImagePart | PromptTextPart | Record<string, unknown>)[]
  }
}

/** Whether a prompt content part is an image part. */
function isImagePart(part: unknown): part is PromptImagePart {
  return typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'image'
}

/** Whether a prompt content part is a text part. */
function isTextPart(part: unknown): part is PromptTextPart {
  return typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
}

/**
/** One server-side recognition result for one image. */
interface ServerRecognitionResult {
  scene: string
  text?: string
}

/** A browser-prepared image plus a local refusal reason, when applicable. */
interface PreparedImage {
  data: string
  mediaType: string
  failure?: string
}

/**
 * Return a request budget that covers every sequential recognition plus the
 * same-origin response. Browser-side image preparation runs before this timer.
 * @param config - effective bridge configuration.
 * @param imageCount - number of images included in the request.
 * @returns milliseconds before the browser abandons the same-origin request.
 */
export function recognitionRequestTimeoutMs(config: BridgeConfig, imageCount: number): number {
  return config.timeoutMs * Math.max(1, imageCount) + SERVER_RESPONSE_GRACE_MS
}

/**
 * Whether a source payload is small enough to retry without browser-side
 * conversion.
 * @param data - base64 image payload.
 * @returns whether the estimated decoded bytes fit the fallback upload limit.
 */
export function canUploadUncompressedImage(data: string): boolean {
  return Math.floor(data.length * 3 / 4) <= MAX_FALLBACK_UPLOAD_BYTES
}

/**
 * Downscale an image in the browser so the upload body stays small (embedded
 * WebViews time out on large request bodies). PNG transparency is flattened
 * onto white before JPEG conversion; images already within the edge limit
 * pass through untouched.
 * @param data - base64 image bytes (data URI payload).
 * @param mediaType - original MIME type.
 * @param maxEdge - longest edge limit in pixels.
 * @returns the (possibly re-encoded) base64 payload and its MIME type.
 */
async function downscaleImage(
  data: string,
  mediaType: string,
  maxEdge: number,
): Promise<{ data: string; mediaType: string }> {
  const source = new Image()
  await new Promise<void>((resolve, reject) => {
    source.onload = () => resolve()
    source.onerror = () => reject(new Error('无法解码图片'))
    source.src = `data:${mediaType};base64,${data}`
  })
  const longest = Math.max(source.naturalWidth, source.naturalHeight)
  if (longest <= maxEdge) return { data, mediaType }
  const scale = maxEdge / longest
  const width = Math.max(1, Math.round(source.naturalWidth * scale))
  const height = Math.max(1, Math.round(source.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) return { data, mediaType }
  // Flatten transparency onto white: JPEG has no alpha channel.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(source, 0, 0, width, height)
  const outputType = mediaType === 'image/jpeg' || mediaType === 'image/webp' ? mediaType : 'image/jpeg'
  const url = canvas.toDataURL(outputType, 0.9)
  const comma = url.indexOf(',')
  if (comma === -1) return { data, mediaType }
  return { data: url.slice(comma + 1), mediaType: outputType }
}

/** Outcome of the server-side recognize call plus attached image ids. */
interface ServerRecognizeOutcome {
  results: ServerRecognitionResult[]
  /** Same-origin image ids (for `![原图](/vision/image/<id>)`), per image; '' when attach failed. */
  imageIds: string[]
}

/**
 * Recognize all images through the same-origin server endpoint
 * (`/vision/recognize`, provided by the vision-server profile plugin). The
 * server downscales and runs the models, so the browser never issues a
 * cross-origin fetch — embedded WebViews can hang on those. Images are also
 * attached (`/vision/attach`) so the message can reference the originals.
 * Returns undefined when the endpoint is unavailable so callers can fall
 * back to direct calls.
 * @param originalFetch - the unpatched global fetch.
 * @param config - effective bridge configuration.
 * @param images - image parts to recognize.
 * @param question - the user's question, when provided.
 * @returns per-image results, or undefined when the endpoint is missing.
 */
async function recognizeViaServer(
  originalFetch: typeof fetch,
  config: BridgeConfig,
  images: PromptImagePart[],
  question: string | undefined,
  onStage: ((stage: string) => void) | undefined,
): Promise<ServerRecognizeOutcome | undefined> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Downscale in the browser before upload. A WebView can time out while
    // passing a large body to its network process; if re-encoding a large
    // image fails, omit its bytes rather than retrying the unsafe upload.
    const prepared: PreparedImage[] = []
    for (const image of images) {
      const data = typeof image.data === 'string' ? image.data : ''
      const mediaType = typeof image.mediaType === 'string' && image.mediaType.length > 0
        ? image.mediaType
        : 'image/png'
      if (data === '') {
        prepared.push({ data: '', mediaType })
        continue
      }
      onStage?.('压缩图片…')
      try {
        const downscaled = await downscaleImage(data, mediaType, config.maxImageEdge)
        prepared.push({ data: downscaled.data, mediaType: downscaled.mediaType })
      } catch {
        if (!canUploadUncompressedImage(data)) {
          prepared.push({
            data: '',
            mediaType,
            failure: '图片压缩失败，已停止上传原始大图；请重新粘贴图片或换用较小文件。',
          })
        } else {
          prepared.push({ data, mediaType })
        }
      }
    }
    timer = setTimeout(() => controller.abort(), recognitionRequestTimeoutMs(config, prepared.length))
    onStage?.(config.ocrEnabled && config.ocrModel !== '' ? '画面分析 + 文字提取…' : '画面分析…')
    const response = await originalFetch('/vision/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        ocrModel: config.ocrModel,
        ocrEnabled: config.ocrEnabled,
        maxImageEdge: config.maxImageEdge,
        timeoutMs: config.timeoutMs,
        question,
        images: prepared,
      }),
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const payload = await response.json() as {
      results?: ServerRecognitionResult[]
      attachmentIds?: (string | undefined)[]
    }
    if (!Array.isArray(payload.results) || payload.results.length !== prepared.length) return undefined
    return {
      results: payload.results.map((result, index) => {
        const failure = prepared[index]?.failure
        return failure === undefined ? result : { scene: `⚠️ ${failure}` }
      }),
      imageIds: payload.attachmentIds === undefined
        ? prepared.map(() => '')
        : payload.attachmentIds.map(id => id ?? ''),
    }
  } catch {
    // Endpoint absent (plugin not deployed) or unreachable: fall back.
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
/** Result of probing the local vision service. */
interface ProbeResult {
  ok: boolean
  /** Human-readable reason when not ok. */
  reason?: string
}

/**
 * Probe the local vision service through the same-origin `/vision/probe`
 * endpoint (server plugin): reachable? models installed? loaded? The probe
 * also warms the model on the server, so the first recognition usually finds
 * it already loaded instead of paying a cold-start load inside the request
 * timeout. Called before recognition so a dead service or missing model fails
 * fast with an immediate message instead of a long silent wait.
 * @param originalFetch - the unpatched global fetch.
 * @param config - effective bridge configuration.
 * @returns the probe outcome.
 */
async function probeModels(
  originalFetch: typeof fetch,
  _config: BridgeConfig,
): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await originalFetch('/vision/probe', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      return { ok: false, reason: `本地识图服务 HTTP ${response.status}` }
    }
    const payload = await response.json() as { ok?: boolean; reason?: string }
    if (payload.ok === false) {
      return { ok: false, reason: payload.reason ?? '本地识图服务不可用' }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: '本地视觉服务未运行（请先启动 Ollama）' }
  } finally {
    clearTimeout(timer)
  }
}

/** Indicator states shown in the top-bar pill. */
type IndicatorState = 'online' | 'offline' | 'busy' | 'disabled'

/**
 * Position the pill over the middle content column: horizontally centered on
 * the composer card (the content area's true center, not the page's) and
 * vertically aligned with the view-tab bar ("对话/轨迹", the two lines),
 * nudged slightly down-right. Falls back to page top-center.
 * @param el - the indicator element.
 */
function positionIndicator(el: HTMLElement): void {
  const composer = document.querySelector('[data-composer-card]')
  if (composer !== null) {
    const rect = composer.getBoundingClientRect()
    const width = el.offsetWidth > 0 ? el.offsetWidth : 120
    // Horizontal: content-area center + a small right nudge.
    const centerX = rect.left + rect.width / 2
    // Vertical: the view-tab bar (two lines) when present, else above the
    // composer; plus a small downward nudge.
    const tabs = document.querySelector('[role="tablist"]')
    const tabTop = tabs !== null ? tabs.getBoundingClientRect().top : rect.top - 60
    el.style.left = `${Math.max(4, centerX - width / 2 + 6)}px`
    el.style.top = `${Math.max(4, tabTop - 25)}px`
    el.style.bottom = 'auto'
    el.style.right = 'auto'
    el.style.transform = 'none'
    return
  }
  el.style.top = '10px'
  el.style.left = '50%'
  el.style.right = 'auto'
  el.style.bottom = 'auto'
  el.style.transform = 'translateX(-50%)'
}

/**
 * Update (or create) the status pill over the middle content column: it only
 * reflects readiness (ready / unavailable / disabled) and doubles as the
 * bridge switch. While recognition runs it keeps showing "识图就绪" and
 * clicks are ignored — stage progress lives on the sending card instead.
 * @param state - the state to show.
 * @param detail - optional detail text.
 * @param onToggle - callback for a click (toggle the bridge).
 */
function updateStatusIndicator(state: IndicatorState, detail: string | undefined, onToggle: () => void): void {
  let el = document.getElementById('dsh-vision-indicator')
  if (el === null) {
    el = document.createElement('button')
    el.id = 'dsh-vision-indicator'
    el.title = '点击开启/关闭本地识图'
    el.style.cssText = [
      'position:fixed', 'z-index:9998', 'border:1px solid rgba(128,128,128,.35)',
      'background:rgba(28,28,32,.85)', 'color:#ddd', 'cursor:pointer',
      'padding:4px 12px', 'border-radius:999px',
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'box-shadow:0 2px 8px rgba(0,0,0,.2)', 'white-space:nowrap',
    ].join(';')
    const created = el
    el.addEventListener('click', () => {
      if (created.dataset.busy === '1') return
      onToggle()
    })
    // Re-anchor while the layout settles (composer/tab bar render after the
    // app mounts) and on scroll/resize.
    const pill = el
    const reposition = (): void => positionIndicator(pill)
    window.addEventListener('scroll', reposition, { passive: true })
    window.addEventListener('resize', reposition, { passive: true })
    const ticker = window.setInterval(reposition, 800)
    el.dataset.ticker = String(ticker)
    document.body.appendChild(el)
  }
  if (state === 'busy') {
    // Recognition in progress: pill stays "ready-looking" and non-clickable.
    el.dataset.busy = '1'
    el.textContent = '🟢 识图就绪'
  } else {
    delete el.dataset.busy
    const dot = state === 'online' ? '🟢'
      : state === 'disabled' ? '⚪'
        : '🔴'
    const label = state === 'online' ? '识图就绪'
      : state === 'disabled' ? '识图已关闭（点击开启）'
        : '识图不可用'
    el.textContent = `${dot} ${label}${detail === undefined ? '' : ` · ${detail}`}`
  }
  positionIndicator(el)
}

/**
 * Show (or update) a "sending" card above the composer: the first image with
 * a translucent overlay showing the current recognition stage. Removed when
 * recognition finishes and the real message appears.
 * @param images - image parts (first one is previewed).
 * @param stage - current stage text.
 */
function showProgressCard(images: PromptImagePart[], stage: string): void {
  let card = document.getElementById('dsh-vision-progress')
  if (card === null) {
    card = document.createElement('div')
    card.id = 'dsh-vision-progress'
    card.style.cssText = [
      'position:fixed', 'z-index:9997', 'background:rgba(26,26,30,.94)',
      'border:1px solid rgba(128,128,128,.35)', 'border-radius:12px',
      'padding:8px', 'box-shadow:0 6px 24px rgba(0,0,0,.35)',
    ].join(';')
    const frame = document.createElement('div')
    frame.style.cssText = [
      'position:relative', 'width:180px', 'height:135px', 'overflow:hidden',
      'border-radius:8px',
    ].join(';')
    const img = document.createElement('img')
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;'
    const first = images.find(image => typeof image.data === 'string' && image.data.length > 0)
    img.src = first === undefined || first.data === ''
      ? ''
      : `data:${first.mediaType ?? 'image/png'};base64,${first.data}`
    img.alt = '正在识别的图片'
    const overlay = document.createElement('div')
    overlay.id = 'dsh-vision-progress-overlay'
    overlay.style.cssText = [
      'position:absolute', 'inset:0', 'background:rgba(0,0,0,.55)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'color:#fff', 'font:13px/1.6 -apple-system,"PingFang SC",sans-serif',
      'text-align:center', 'padding:10px',
    ].join(';')
    frame.append(img, overlay)
    card.append(frame)
    document.body.appendChild(card)
  }
  const overlay = document.getElementById('dsh-vision-progress-overlay')
  if (overlay !== null) overlay.textContent = `📷 ${stage}`
  // Anchor above the composer card, centered.
  const composer = document.querySelector('[data-composer-card]')
  if (composer !== null) {
    const rect = composer.getBoundingClientRect()
    card.style.left = `${rect.left + rect.width / 2 - 98}px`
    card.style.top = `${Math.max(4, rect.top - 165)}px`
  } else {
    card.style.left = '50%'
    card.style.top = 'auto'
    card.style.bottom = '96px'
    card.style.transform = 'translateX(-50%)'
  }
}

/** Remove the "sending" progress card. */
function removeProgressCard(): void {
  document.getElementById('dsh-vision-progress')?.remove()
}

/** Uploaded files pending attachment to the next outgoing message. */
const pendingUploads: { name: string; path: string }[] = []

/**
 * Render the upload draft bar above the composer: one chip per pending
 * uploaded file (like the image draft rail), each with a remove button.
 * Removed when empty.
 */
function renderUploadDraft(): void {
  const existing = document.getElementById('dsh-vision-upload-draft')
  existing?.remove()
  if (pendingUploads.length === 0) return
  const bar = document.createElement('div')
  bar.id = 'dsh-vision-upload-draft'
  bar.style.cssText = [
    'position:fixed', 'z-index:9996', 'display:flex', 'gap:6px', 'flex-wrap:wrap',
    'max-width:70vw',
  ].join(';')
  for (let index = 0; index < pendingUploads.length; index += 1) {
    const upload = pendingUploads[index]!
    const chip = document.createElement('span')
    chip.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'background:rgba(28,28,32,.92)', 'border:1px solid rgba(128,128,128,.4)',
      'color:#eee', 'border-radius:999px', 'padding:3px 6px 3px 10px',
      'font:12px/1.5 -apple-system,"PingFang SC",sans-serif',
      'max-width:280px', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
    ].join(';')
    chip.textContent = `${upload.name}`
    const remove = document.createElement('button')
    remove.textContent = '×'
    remove.title = '移除'
    remove.style.cssText = [
      'border:none', 'background:transparent', 'color:#aaa', 'cursor:pointer',
      'font:14px/1 sans-serif', 'padding:0 4px',
    ].join(';')
    remove.addEventListener('click', () => {
      pendingUploads.splice(index, 1)
      renderUploadDraft()
    })
    chip.append(remove)
    bar.append(chip)
  }
  document.body.appendChild(bar)
  // Anchor just above the composer card, left-aligned with it.
  const composer = document.querySelector('[data-composer-card]')
  if (composer !== null) {
    const rect = composer.getBoundingClientRect()
    bar.style.left = `${rect.left + 12}px`
    bar.style.top = `${Math.max(4, rect.top - bar.offsetHeight - 10)}px`
  } else {
    bar.style.left = '50%'
    bar.style.top = '60px'
    bar.style.transform = 'translateX(-50%)'
  }
}

/**
 * Resolve the most recently active session's working directory via the
 * host RPC, so uploaded files land inside the workspace the user is talking
 * in (a project-local copy the agent can open with its file tools).
 * @param originalFetch - the unpatched global fetch.
 * @returns the cwd, or undefined when it cannot be resolved.
 */
async function resolveSessionCwd(originalFetch: typeof fetch): Promise<string | undefined> {
  try {
    const response = await originalFetch('/api/session.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `vision-cwd-${Date.now()}`,
        method: 'session.list',
        payload: {},
      }),
    })
    if (!response.ok) return undefined
    const payload = await response.json() as { result?: { value?: { items?: { cwd?: string; updatedAt?: number }[] } } }
    const items = payload.result?.value?.items ?? []
    let best: string | undefined
    let bestAt = -1
    for (const item of items) {
      const at = item.updatedAt ?? 0
      if (at >= bestAt && typeof item.cwd === 'string' && item.cwd.length > 0) {
        best = item.cwd
        bestAt = at
      }
    }
    return best
  } catch {
    return undefined
  }
}

/**
 * Upload an arbitrary file (Word/PDF/…) to the server so the agent can
 * process it; the path rides along with the next sent message as text.
 * @param originalFetch - the unpatched global fetch.
 * @param file - the file to upload.
 * @returns the server-side absolute path.
 */
async function uploadFile(originalFetch: typeof fetch, file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  const dir = await resolveSessionCwd(originalFetch)
  const response = await originalFetch('/vision/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name,
      data: btoa(binary),
      ...(dir === undefined ? {} : { dir }),
    }),
  })
  if (!response.ok) throw new Error(`上传失败 HTTP ${response.status}`)
  const payload = await response.json() as { path?: string }
  if (typeof payload.path !== 'string') throw new Error('上传失败：服务端未返回路径')
  pendingUploads.push({ name: file.name, path: payload.path })
  renderUploadDraft()
  return payload.path
}

/**
 * Upload every non-image file from a paste event (Finder copy → Cmd+V in the
 * composer). The InputBar's own paste handler only accepts images, so we
 * intercept non-image files here, upload them, and let the next message carry
 * their server paths. Images pass through untouched (recognition path).
 * @param originalFetch - the unpatched global fetch.
 * @param event - the paste event being handled.
 */
function handleFilePaste(originalFetch: typeof fetch, event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
  const uploadable = files.filter(file => !file.type.startsWith('image/'))
  if (uploadable.length === 0) return
  event.preventDefault()
  event.stopPropagation()
  void (async () => {
    for (const file of uploadable) {
      try {
        await uploadFile(originalFetch, file)
        // The upload draft bar already shows the file; no toast needed.
      } catch (error) {
        showUploadChip(`⚠️ ${file.name} 上传失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })()
}

/** Brief confirmation chip for an upload result. */
function showUploadChip(text: string): void {
  let chip = document.getElementById('dsh-vision-upload-chip')
  if (chip === null) {
    chip = document.createElement('div')
    chip.id = 'dsh-vision-upload-chip'
    chip.style.cssText = [
      'position:fixed', 'z-index:9996', 'background:rgba(28,28,32,.95)',
      'color:#fff', 'padding:6px 14px', 'border-radius:8px',
      'font:12px/1.5 -apple-system,"PingFang SC",sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.3)', 'pointer-events:none',
      'max-width:70vw', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
    ].join(';')
    document.body.appendChild(chip)
  }
  chip.textContent = text
  const composer = document.querySelector('[data-composer-card]')
  if (composer !== null) {
    const rect = composer.getBoundingClientRect()
    chip.style.left = `${rect.left + rect.width / 2}px`
    chip.style.top = `${Math.max(4, rect.top - 60)}px`
    chip.style.transform = 'translateX(-50%)'
  } else {
    chip.style.left = '50%'
    chip.style.top = '76px'
    chip.style.transform = 'translateX(-50%)'
  }
  window.setTimeout(() => { chip?.remove() }, 5000)
}

/**
 * Browser half: install the fetch interception for the plugin lifetime.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
  const originalFetch = window.fetch.bind(window)

  /** Persist the bridge on/off switch and refresh the indicator. */
  const toggleBridge = (): void => {
    const config = readConfig()
    const next = { ...config, enabled: !config.enabled }
    try {
      window.localStorage.setItem(CONFIG_KEY, JSON.stringify(next))
    } catch {
      // Storage unavailable: the toggle applies for this page load only.
    }
    if (next.enabled) {
      updateStatusIndicator('busy', '检测中', toggleBridge)
      void probeModels(originalFetch, next).then((probe) => {
        updateStatusIndicator(probe.ok ? 'online' : 'offline', probe.ok ? undefined : probe.reason, toggleBridge)
      })
    } else {
      updateStatusIndicator('disabled', undefined, toggleBridge)
    }
  }

  // Initial indicator state: disabled, or online/offline per a quick probe.
  const initial = readConfig()
  if (!initial.enabled) {
    updateStatusIndicator('disabled', undefined, toggleBridge)
  } else {
    void probeModels(originalFetch, initial).then((probe) => {
      updateStatusIndicator(probe.ok ? 'online' : 'offline', probe.ok ? undefined : probe.reason, toggleBridge)
    })
  }

  const patchedFetch: typeof fetch = async (input, init) => {
    const config = readConfig()
    if (!config.enabled) return originalFetch(input, init)

    // Only POST session.prompt requests carry user image content.
    const requestUrl = typeof input === 'string' ? input
      : input instanceof URL ? input.href
        : input instanceof Request ? input.url
          : String(input)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method !== 'POST') return originalFetch(input, init)
    let pathname: string
    try {
      pathname = new URL(requestUrl, window.location.href).pathname
    } catch {
      return originalFetch(input, init)
    }
    if (!pathname.endsWith('/api/session.prompt')) return originalFetch(input, init)

    // The RPC body is JSON text; anything else passes through untouched.
    if (typeof init?.body !== 'string') return originalFetch(input, init)
    let envelope: PromptEnvelope
    try {
      envelope = JSON.parse(init.body) as PromptEnvelope
    } catch {
      return originalFetch(input, init)
    }
    if (envelope.type !== 'client-request' || envelope.method !== 'session.prompt') {
      return originalFetch(input, init)
    }
    const payload = envelope.payload
    if (payload === undefined) return originalFetch(input, init)
    const content = payload.content
    if (!Array.isArray(content)) return originalFetch(input, init)
    const texts = content.filter(isTextPart).map(part => part.text ?? '').join('')
    // Files attached via paste must ride along on ANY outgoing message, even
    // a pure-text one (no image parts), and the draft bar must clear.
    const uploadBlock = pendingUploads.splice(0).map(upload =>
      `${upload.name}`)
    if (uploadBlock.length > 0) {
      renderUploadDraft()
      const note = `\n\n[已上传文件]\n${uploadBlock.join('\n')}`
      const parts = content.map(part => {
        if (isTextPart(part)) {
          const text = part.text ?? ''
          return { type: 'text' as const, text: `${text}${note}` }
        }
        return part
      })
      payload.content = parts
      return originalFetch(input, { ...init, body: JSON.stringify(envelope) })
    }
    const images = content.filter(isImagePart)
    if (images.length === 0) return originalFetch(input, init)
    if (!readConfig().recognizeEnabled) return originalFetch(input, init)

    const userQuestion = texts.trim().length > 0 ? texts.trim() : undefined

    // Fail fast when the local service is down or a model is missing: probe
    // first (~1s) and rewrite the message with an immediate explanation
    // instead of silently waiting for a long recognition timeout.
    const probe = await probeModels(originalFetch, config)
    if (!probe.ok) {
      updateStatusIndicator('offline', undefined, toggleBridge)
      const note = `【📷 识图不可用】${probe.reason ?? ''}`
      payload.content = texts.trim().length > 0
        ? [{ type: 'text', text: `${texts.trim()}\n\n${note}` }]
        : [{ type: 'text', text: note }]
      return originalFetch(input, { ...init, body: JSON.stringify(envelope) })
    }
    updateStatusIndicator('busy', undefined, toggleBridge)

    const recognized: string[] = []
    const targetImages = images.slice(0, config.maxImages)

    // Preferred path: one same-origin call to the vision-server plugin, which
    // downscales and runs the models on the reliable server network stack.
    const started = Date.now()
    showProgressCard(targetImages, '正在识别…')
    // The pill stays simple ("⏳ 识别中"); stage details live on the
    // sending progress card only — showing both was redundant.
    updateStatusIndicator('busy', undefined, toggleBridge)
    const stageOf = (stage: string): void => {
      const overlay = document.getElementById('dsh-vision-progress-overlay')
      if (overlay !== null) overlay.textContent = `📷 ${stage}`
    }
    const serverResults = await recognizeViaServer(originalFetch, config, targetImages, userQuestion, stageOf)
    const elapsedSec = Math.round((Date.now() - started) / 1000)
    removeProgressCard()
    if (serverResults !== undefined) {
      for (const result of serverResults.results) {
        let text = `【画面】\n${result.scene}`
        if (result.text !== undefined && result.text.length > 0) {
          text += `\n\n【文字】\n${result.text}`
        }
        recognized.push(text)
      }
      if (images.length > config.maxImages) {
        recognized.push(`⚠️ 另有 ${images.length - config.maxImages} 张图片未识别（单条消息最多识别 ${config.maxImages} 张）`)
      }
      // "✅ 完成 13s" briefly, then back to ready.
      updateStatusIndicator('online', `完成 ${elapsedSec}s`, toggleBridge)
      window.setTimeout(() => {
        updateStatusIndicator('online', undefined, toggleBridge)
      }, 2500)
    } else {
      // The same-origin endpoint is absent or unreachable. Fail fast instead
      // of falling back to cross-origin Ollama calls, which hang in embedded
      // WebViews: the message goes out with an explicit note within seconds.
      recognized.push(
        `⚠️ 本地识图服务不可用（${elapsedSec} 秒内未响应）。首次识别需加载模型（无 GPU 时可能 1-2 分钟），请重试；若仍失败请确认 Ollama 已启动、vision-server 已部署。`,
      )
      updateStatusIndicator('offline', undefined, toggleBridge)
    }

    // The user's own text comes first (normal message shape); the recognition
    // result follows as an annotated note for the chat model to answer from,
    // and the original image rides along as a same-origin markdown reference
    // so the conversation keeps the picture (model sees only the URL text).
    const rewritten: { type: 'text'; text: string }[] = []
    if (texts.trim().length > 0) rewritten.push({ type: 'text', text: texts.trim() })
    // Uploaded files ride along as clickable links the agent can open.
    if (pendingUploads.length > 0) {
      const block = pendingUploads.splice(0).map(upload => `${upload.name}`).join('\n')
      rewritten.push({ type: 'text', text: `[已上传文件]\n${block}` })
      renderUploadDraft()
    }
    for (let index = 0; index < recognized.length; index += 1) {
      const label = images.length > 1 ? `图片 ${index + 1}` : '图片'
      rewritten.push({ type: 'text', text: `【📷 ${label}识别结果】\n${recognized[index]}` })
    }
    const imageIds = serverResults === undefined ? undefined : serverResults.imageIds
    if (imageIds !== undefined) {
      for (let index = 0; index < imageIds.length; index += 1) {
        const id = imageIds[index]
        if (id === undefined || id === '') continue
        const label = imageIds.length > 1 ? `原图 ${index + 1}` : '原图'
        rewritten.push({ type: 'text', text: `![${label}](/vision/image/${id})` })
      }
    }
    if (recognized.length > 0) {
      rewritten.push({
        type: 'text',
        text: '（以上是图片识别结果。请结合用户的问题和识别结果，直接回答用户的问题。）',
      })
    }
    payload.content = rewritten

    return originalFetch(input, { ...init, body: JSON.stringify(envelope) })
  }

  window.fetch = patchedFetch
  if (readConfig().uploadEnabled) {
    // Intercept non-image file pastes (Finder copy → Cmd+V) for upload.
    // Capture phase: run before the composer's own paste handler.
    const onPaste = (event: ClipboardEvent): void => handleFilePaste(originalFetch, event)
    document.addEventListener('paste', onPaste, { capture: true })
    ctx.effect(() => () => {
      document.removeEventListener('paste', onPaste, { capture: true })
    })
  }
  ctx.effect(() => () => {
    if (window.fetch === patchedFetch) window.fetch = originalFetch
    const pill = document.getElementById('dsh-vision-indicator')
    if (pill !== null) {
      const ticker = Number(pill.dataset.ticker)
      if (Number.isFinite(ticker) && ticker > 0) window.clearInterval(ticker)
      pill.remove()
    }
    document.getElementById('dsh-vision-upload-chip')?.remove()
  })
}
