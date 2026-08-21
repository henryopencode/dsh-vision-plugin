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
   * Bearer API key for remote vision providers (Zhipu glm-4v-flash etc.).
   * Empty string = local Ollama (no auth header). Editable in the settings
   * dialog opened from the status pill.
   */
  apiKey: '',
  /**
   * Whether the user explicitly saved endpoint settings (baseURL/apiKey) in
   * the dialog. Only then does the browser send them per-request, overriding
   * the server's own patch config; otherwise the server config is used.
   */
  overrideEndpoint: false,
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
    sessionId?: string
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
        // Only send endpoint overrides when the user explicitly saved them;
        // otherwise the server's own patch config is used.
        ...(config.overrideEndpoint
          ? { baseURL: config.baseURL, apiKey: config.apiKey }
          : {}),
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
 * Mount the pill inside the composer card (top row) so it sits in the
 * layout, anchored to the composer — never window-fixed, so it cannot end up
 * in the wrong place across sessions/scroll.
 * @param el - the indicator element.
 */
function positionIndicator(el: HTMLElement): void {
  el.style.position = 'static'
  el.style.zIndex = ''
  el.style.top = ''
  el.style.left = ''
  el.style.right = ''
  el.style.bottom = ''
  el.style.transform = ''
  el.style.margin = 'auto 0'
  const composer = document.querySelector('[data-composer-card]')
  if (composer === null) {
    if (el.parentElement !== document.body) document.body.appendChild(el)
    return
  }
  // Top of the composer card: a toolbar row above the input, never inside it.
  const rail = document.getElementById('dsh-vision-ui-rail')
  if (rail !== null) {
    if (el.parentElement !== rail || rail.firstChild !== el) {
      rail.insertBefore(el, rail.firstChild)
    }
    return
  }
  if (el.parentElement !== composer) {
    composer.insertBefore(el, composer.firstChild)
  }
}

/**
 * Open a settings dialog for the vision bridge: shows the current endpoint
 * (local baseURL or remote baseURL), the model, and an editable API key.
 * Saving persists to localStorage (dsh-vision:config); recognition requests
 * then carry these values to the server plugin, which overrides its own
 * defaults per request.
 */
function openVisionSettings(): void {
  const existing = document.getElementById('dsh-vision-settings')
  existing?.remove()

  const config = readConfig()
  const isRemote = (config.apiKey !== undefined && config.apiKey !== '')
    || !/^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(config.baseURL)

  const overlay = document.createElement('div')
  overlay.id = 'dsh-vision-settings'
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:10001',
    'background:rgba(0,0,0,.5)', 'display:flex',
    'align-items:center', 'justify-content:center',
  ].join(';')
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  const panel = document.createElement('div')
  panel.style.cssText = [
    'width:420px', 'max-width:90vw', 'background:#1a1a20',
    'border:1px solid #33333e', 'border-radius:14px', 'padding:20px',
    'box-shadow:0 12px 40px rgba(0,0,0,.5)',
    'font:13px/1.6 -apple-system,"PingFang SC",sans-serif', 'color:#e8e8ec',
  ].join(';')

  const title = document.createElement('h3')
  title.textContent = '识图设置'
  title.style.cssText = 'margin:0 0 4px;font-size:15px;'

  const modeLine = document.createElement('div')
  modeLine.style.cssText = 'font-size:12px;color:#8a8a94;margin-bottom:14px;'
  modeLine.textContent = isRemote
    ? '当前：远程 API（Bearer 认证）'
    : '当前：本地 Ollama'

  const isLocalURL = (url: string): boolean =>
    /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url.trim())

  const field = (label: string, value: string, placeholder: string, type = 'text'): HTMLInputElement => {
    const l = document.createElement('label')
    l.textContent = label
    l.style.cssText = 'display:block;font-size:12px;color:#a8a8b2;margin:12px 0 4px;'
    const input = document.createElement('input')
    input.type = type
    input.value = value
    input.placeholder = placeholder
    input.spellcheck = false
    input.style.cssText = [
      'width:100%', 'background:#121218', 'color:#eee', 'border:1px solid #33333e',
      'border-radius:8px', 'padding:8px 10px', 'font-size:13px', 'outline:none',
      'box-sizing:border-box',
    ].join(';')
    panel.append(l, input)
    return input
  }

  const modelInput = field('模型', config.model, 'qwen2.5vl:3b 或 glm-4v-flash')
  const baseURLInput = field('Base URL', config.baseURL, 'http://127.0.0.1:11434/v1')

  // API key row: only meaningful for remote providers, hidden for local URLs.
  const keyLabel = document.createElement('label')
  keyLabel.textContent = 'API Key'
  keyLabel.style.cssText = 'display:block;font-size:12px;color:#a8a8b2;margin:12px 0 4px;'
  const apiKeyInput = document.createElement('input')
  apiKeyInput.type = 'password'
  apiKeyInput.value = config.apiKey
  apiKeyInput.placeholder = '远程模型的 API Key（本地 Ollama 不需要）'
  apiKeyInput.spellcheck = false
  apiKeyInput.style.cssText = [
    'width:100%', 'background:#121218', 'color:#eee', 'border:1px solid #33333e',
    'border-radius:8px', 'padding:8px 10px', 'font-size:13px', 'outline:none',
    'box-sizing:border-box',
  ].join(';')
  const keyRow = document.createElement('div')
  keyRow.id = 'dsh-vision-key-row'
  keyRow.style.cssText = 'display:block;'
  keyRow.append(keyLabel, apiKeyInput)
  panel.append(keyRow)

  const updateMode = (): void => {
    const local = isLocalURL(baseURLInput.value)
    keyRow.style.display = local ? 'none' : 'block'
    modeLine.textContent = local ? '当前：本地 Ollama' : '当前：远程 API（Bearer 认证）'
  }
  baseURLInput.addEventListener('input', updateMode)
  updateMode()

  // Unless the user already overrode the endpoint, show the server's actual
  // effective config (from /vision/config) instead of local defaults — e.g. a
  // remote Zhipu setup configured in the server patch must appear as remote.
  if (!config.overrideEndpoint) {
    const originalFetch = window.fetch.bind(window)
    void (async () => {
      try {
        const response = await originalFetch('/vision/config', { method: 'GET', headers: { Accept: 'application/json' } })
        if (!response.ok) return
        const payload = await response.json() as { model?: string; baseURL?: string; apiKeySet?: boolean }
        if (typeof payload.model === 'string' && payload.model.length > 0) modelInput.value = payload.model
        if (typeof payload.baseURL === 'string' && payload.baseURL.length > 0) {
          baseURLInput.value = payload.baseURL
        }
        if (payload.apiKeySet === true) {
          keyRow.style.display = 'block'
          modeLine.textContent = '当前：远程 API（Bearer 认证）'
          apiKeyInput.placeholder = '服务器已配置 Key（留空则沿用服务器配置）'
        }
      } catch {
        // Server config unreachable: keep local defaults.
      }
    })()
  }

  const buttons = document.createElement('div')
  buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:18px;'

  const btn = (text: string, primary: boolean): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = text
    b.style.cssText = [
      'border:none', 'border-radius:8px', 'padding:8px 16px', 'cursor:pointer',
      'font-size:13px',
      primary
        ? 'background:#4a6cf7;color:#fff;'
        : 'background:transparent;color:#a8a8b2;border:1px solid #33333e;',
    ].join(';')
    buttons.append(b)
    return b
  }

  const save = btn('保存', true)
  const cancel = btn('取消', false)

  const close = (): void => overlay.remove()

  save.addEventListener('click', () => {
    const next = {
      ...config,
      model: modelInput.value.trim() || config.model,
      baseURL: baseURLInput.value.trim() || config.baseURL,
      apiKey: apiKeyInput.value.trim(),
      overrideEndpoint: true,
    }
    try {
      window.localStorage.setItem(CONFIG_KEY, JSON.stringify(next))
    } catch {
      // Storage unavailable: applies for this page load only.
    }
    // Refresh the pill label for the new mode.
    updateStatusIndicator(
      next.apiKey !== '' ? 'online' : 'online',
      undefined,
      openVisionSettings,
    )
    close()
    showUploadChip('已保存识图配置，刷新页面后完全生效')
  })

  cancel.addEventListener('click', close)

  panel.append(title, modeLine, buttons)
  overlay.append(panel)
  document.body.appendChild(overlay)
}

/**
 * Update (or create) the status pill. It shows readiness (就绪/不可用/关闭)
 * and opens the settings dialog on click. During recognition the pill keeps
 * saying "识图就绪" — the live "识别中 Xs" feedback lives on the thumbnail
 * overlay.
 * @param state - the state to show.
 * @param detail - optional detail text.
 * @param onToggle - unused; kept for call-site compatibility.
 */
function updateStatusIndicator(state: IndicatorState, detail: string | undefined, onToggle: () => void): void {
  void onToggle
  let el = document.getElementById('dsh-vision-indicator')
  if (el === null) {
    el = document.createElement('button')
    el.id = 'dsh-vision-indicator'
    el.title = '点击打开识图设置'
    el.style.cssText = [
      'border:1px solid rgba(128,128,128,.35)',
      'background:rgba(28,28,32,.85)', 'color:#ddd', 'cursor:pointer',
      'padding:0 12px', 'border-radius:999px', 'height:30px',
      'box-sizing:border-box',
      'font:12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'box-shadow:0 2px 8px rgba(0,0,0,.2)', 'white-space:nowrap',
      'display:inline-flex', 'align-items:center', 'justify-content:center',
    ].join(';')
    const created = el
    el.addEventListener('click', () => {
      if (created.dataset.busy === '1') return
      openVisionSettings()
    })
  }
  if (state === 'busy') {
    // Keep showing "识图就绪"; the ticking counter lives on thumbnails.
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


/** Uploaded files pending attachment to the next outgoing message. */
const pendingUploads: { name: string; path: string }[] = []

/**
 * Images picked via the local "＋" button (not pasted): they ride into the
 * next outgoing message as image parts, exactly like pasted images, so they
 * go through the same recognition path.
 */
const pendingLocalImages: PromptImagePart[] = []

/**
 * The session the user is currently viewing, updated from session.* RPC
 * payloads. The progress card hides while a different session is active and
 * reappears when the user returns to the initiating session.
 */
let activeSessionId: string | undefined

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
  // Render inside the composer card (where DSH shows pasted-image drafts) so
  // the chips participate in the layout instead of floating over the
  // conversation content. Fall back to a fixed bar when the composer is gone.
  const composer = document.querySelector('[data-composer-card]')
  if (composer !== null && composer.firstChild !== null) {
    bar.style.cssText = [
      'display:flex', 'gap:6px', 'flex-wrap:wrap',
      'max-width:70vw', 'padding:8px 12px 0',
    ].join(';')
    composer.insertBefore(bar, composer.firstChild)
  } else {
    document.body.appendChild(bar)
    bar.style.cssText = [
      'position:fixed', 'z-index:9996', 'display:flex', 'gap:6px', 'flex-wrap:wrap',
      'max-width:70vw',
    ].join(';')
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
}

/**
 * Render image thumbnails for images picked via the attachment button,
 * inside the composer like the upload draft. Each thumbnail shows the real
 * image (base64 preview) with a remove button; cleared when the message goes
 * out.
 */
function renderLocalImageDraft(): void {
  const existing = document.getElementById('dsh-vision-local-image-draft')
  existing?.remove()
  if (pendingLocalImages.length === 0) return
  const bar = document.createElement('div')
  bar.id = 'dsh-vision-local-image-draft'
  bar.style.cssText = [
    'display:flex', 'gap:8px', 'flex-wrap:wrap', 'max-width:70vw',
    'padding:8px 12px 0',
  ].join(';')
  for (let index = 0; index < pendingLocalImages.length; index += 1) {
    const image = pendingLocalImages[index]!
    const item = document.createElement('div')
    item.style.cssText = [
      'position:relative', 'width:72px', 'height:72px', 'border-radius:8px',
      'overflow:hidden', 'border:1px solid rgba(128,128,128,.45)',
      'background:rgba(0,0,0,.4)', 'flex:none',
    ].join(';')
    const img = document.createElement('img')
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;'
    img.src = `data:${image.mediaType ?? 'image/png'};base64,${image.data ?? ''}`
    img.alt = image.name ?? `图片 ${index + 1}`
    img.title = image.name ?? `图片 ${index + 1}`
    const remove = document.createElement('button')
    remove.textContent = '×'
    remove.title = '移除'
    remove.style.cssText = [
      'position:absolute', 'top:2px', 'right:2px', 'width:18px', 'height:18px',
      'border:none', 'border-radius:50%', 'background:rgba(0,0,0,.65)',
      'color:#fff', 'cursor:pointer', 'font:12px/1 sans-serif',
      'display:flex', 'align-items:center', 'justify-content:center', 'padding:0',
    ].join(';')
    remove.addEventListener('click', () => {
      pendingLocalImages.splice(index, 1)
      renderLocalImageDraft()
    })
    // Recognition overlay: a translucent mask over the thumbnail while the
    // image is being recognized, with a live seconds counter.
    const overlay = document.createElement('div')
    overlay.className = 'dsh-vision-thumb-overlay'
    overlay.style.cssText = [
      'position:absolute', 'inset:0', 'background:rgba(0,0,0,.55)',
      'display:none', 'align-items:center', 'justify-content:center',
      'color:#fff', 'font:11px/1.4 -apple-system,"PingFang SC",sans-serif',
      'text-align:center', 'padding:4px', 'pointer-events:none',
    ].join(';')
    overlay.textContent = '识别中…'
    item.append(img, overlay, remove)
    bar.append(item)
  }
  const composer = document.querySelector('[data-composer-card]')
  if (composer !== null && composer.firstChild !== null) {
    composer.insertBefore(bar, composer.firstChild)
  } else {
    document.body.appendChild(bar)
  }
}

/**
 * Show a live "识别中 Xs" mask over every pending image thumbnail. Called
 * when recognition starts; the thumbnails are kept on screen until it ends.
 */
function showThumbnailOverlay(): void {
  const startedAt = Date.now()
  const items = Array.from(document.querySelectorAll('.dsh-vision-thumb-overlay'))
  const tick = (): void => {
    const sec = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    for (const el of items) {
      if (el instanceof HTMLElement) {
        el.style.display = 'flex'
        el.textContent = `识别中 ${sec}s`
      }
    }
  }
  tick()
  const timer = window.setInterval(tick, 1000)
  window.setTimeout(() => {
    // Give the interval a bounded life; cleared earlier on completion.
  }, 0)
  document.documentElement.dataset.visionThumbTimer = String(timer)
}

/** Hide thumbnail overlays and clear the live timer. */
function hideThumbnailOverlay(): void {
  const timer = Number(document.documentElement.dataset.visionThumbTimer)
  if (Number.isFinite(timer) && timer > 0) {
    window.clearInterval(timer)
    delete document.documentElement.dataset.visionThumbTimer
  }
  for (const el of document.querySelectorAll('.dsh-vision-thumb-overlay')) {
    if (el instanceof HTMLElement) el.style.display = 'none'
  }
}



/**
 * Handle files chosen via the local "＋" button: images are queued as image
 * parts for the next message (recognition path); other files are uploaded to
 * the session workspace (upload path).
 * @param originalFetch - the unpatched global fetch.
 * @param files - the chosen files.
 */
function addLocalFiles(originalFetch: typeof fetch, files: FileList | File[]): void {
  const recognizeOn = readConfig().recognizeEnabled
  const uploadable: File[] = []
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) {
      if (!recognizeOn) {
        showUploadChip(`当前模型不支持识图，已跳过 ${file.name}`)
        continue
      }
      void (async () => {
        try {
          const data = await readFileAsBase64(file)
          pendingLocalImages.push({
            type: 'image',
            mediaType: file.type || 'image/png',
            data,
            name: file.name,
          })
          renderLocalImageDraft()
        } catch {
          showUploadChip(`⚠️ 无法读取图片 ${file.name}`)
        }
      })()
    } else {
      uploadable.push(file)
    }
  }
  void (async () => {
    for (const file of uploadable) {
      try {
        await uploadFile(originalFetch, file)
      } catch (error) {
        showUploadChip(`⚠️ ${file.name} 上传失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })()
}

/** Read a File as a base64 data string. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
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
 * Upload every file from a paste event (Finder copy → Cmd+V in the
 * composer). The InputBar's own paste handler only accepts images, so we
 * intercept files here. With recognition off, images are dropped too (the
 * chat model can't take image input) — a short notice replaces them instead
 * of a raw image body that trips HTTP 413.
 * @param originalFetch - the unpatched global fetch.
 * @param event - the paste event being handled.
 */
function handleFilePaste(originalFetch: typeof fetch, event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
  if (files.length === 0) return
  const recognizeOn = readConfig().recognizeEnabled
  const uploadable = files.filter(file => !file.type.startsWith('image/'))
  const pastedImages = files.filter(file => file.type.startsWith('image/'))
  // Images (recognition on) are intercepted like the "＋" button: they join
  // our own draft so DSH never sees them as content — the send button stays
  // disabled until the user types text.
  if (uploadable.length === 0 && pastedImages.length === 0) return
  event.preventDefault()
  event.stopPropagation()
  if (recognizeOn && pastedImages.length > 0) {
    for (const file of pastedImages) {
      void (async () => {
        try {
          const data = await readFileAsBase64(file)
          pendingLocalImages.push({
            type: 'image',
            mediaType: file.type || 'image/png',
            data,
            name: file.name,
          })
          renderLocalImageDraft()
        } catch {
          showUploadChip(`⚠️ 无法读取图片 ${file.name}`)
        }
      })()
    }
  }
  if (!recognizeOn && pastedImages.length > 0) {
    showUploadChip(`当前模型不支持识图，已跳过 ${pastedImages.length} 张图片；可粘贴 Word/PDF 文件上传`)
  }
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

/**
 * Upload every file dropped onto the page (drag & drop into the
 * conversation). Always stops propagation so DSH's own drop handler does not
 * try to treat a document as an image draft (it would pop a
 * "仅支持 PNG、JPG、WebP、GIF" error). With recognition off, dropped images
 * are skipped with a notice.
 * @param originalFetch - the unpatched global fetch.
 * @param files - the dropped files.
 */
function handleFileDrop(originalFetch: typeof fetch, files: FileList | File[]): void {
  const all = Array.from(files)
  const recognizeOn = readConfig().recognizeEnabled
  const uploadable = all.filter(file => !file.type.startsWith('image/'))
  const droppedImages = all.filter(file => file.type.startsWith('image/'))
  if (uploadable.length === 0 && droppedImages.length === 0) return
  if (recognizeOn && droppedImages.length > 0) {
    // Images join our own draft (same as paste / "＋") so DSH never treats
    // them as content and the send button stays disabled until text input.
    for (const file of droppedImages) {
      void (async () => {
        try {
          const data = await readFileAsBase64(file)
          pendingLocalImages.push({
            type: 'image',
            mediaType: file.type || 'image/png',
            data,
            name: file.name,
          })
          renderLocalImageDraft()
        } catch {
          showUploadChip(`⚠️ 无法读取图片 ${file.name}`)
        }
      })()
    }
  }
  if (!recognizeOn && droppedImages.length > 0) {
    showUploadChip(`当前模型不支持识图，已跳过 ${droppedImages.length} 张图片；可拖入 Word/PDF 文件上传`)
  }
  void (async () => {
    for (const file of uploadable) {
      try {
        await uploadFile(originalFetch, file)
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
  // When recognition is disabled there is no pill at all and no probe — the
  // probe would warm up the model (memory) for a feature that is off.
  const initial = readConfig()
  if (!initial.enabled || !initial.recognizeEnabled) {
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

    // Track which session the user is currently viewing: switching sessions
    // issues session.* RPCs (session.history, session.read, …) carrying the
    // target session id. The progress card uses this to stay with its own
    // session — hidden while the user is elsewhere, restored on return.
    if (pathname.startsWith('/api/session.') && typeof init?.body === 'string') {
      try {
        const envelope = JSON.parse(init.body) as PromptEnvelope
        const sid = envelope.payload?.sessionId
        if (typeof sid === 'string' && sid.length > 0) activeSessionId = sid
      } catch {
        // Not JSON; ignore.
      }
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
    let content = payload.content
    if (!Array.isArray(content)) return originalFetch(input, init)

    // Local "＋"-picked images join the outgoing message as image parts.
    // The draft thumbnails stay visible during recognition (masked), so they
    // are NOT spliced/cleared here — cleared on completion.
    if (pendingLocalImages.length > 0) {
      const picked = pendingLocalImages.slice(0)
      content = [...picked, ...content]
      payload.content = content
      showThumbnailOverlay()
    }

    // Strip the zero-width send-placeholder (used to enable the send button
    // when only an image was picked) from every text part.
    content = content.map(part =>
      isTextPart(part) ? { type: 'text' as const, text: (part.text ?? '').trim() } : part)
    payload.content = content

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
    if (!readConfig().recognizeEnabled) {
      // Recognition is off: don't forward the image (the chat model can't
      // take image input and a big base64 body trips HTTP 413). Replace the
      // image parts with a short notice, keeping the user's text.
      const note = `【当前模型不支持识图，已跳过 ${images.length} 张图片】`
      const kept: ({ type: 'text'; text: string })[] = texts.trim().length > 0
        ? [{ type: 'text', text: texts.trim() }]
        : []
      payload.content = [...kept, { type: 'text', text: note }]
      return originalFetch(input, { ...init, body: JSON.stringify(envelope) })
    }

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
    // The pill shows a live "识别中 Xs" counter; no separate progress card.
    updateStatusIndicator('busy', undefined, toggleBridge)
    const serverResults = await recognizeViaServer(originalFetch, config, targetImages, userQuestion, undefined)
    const elapsedSec = Math.round((Date.now() - started) / 1000)
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
      // Pill stays "识图就绪" — no status change on completion.
      updateStatusIndicator('online', undefined, toggleBridge)
    } else {
      // Recognition failed (remote rate limit, service down, timeout…). The
      // message still goes out with a notice — the user's flow is never
      // blocked, they just see the picture was not recognized.
      recognized.push(
        `⚠️ 识图服务暂时不可用（${elapsedSec} 秒内未响应，可能被限流）。图片未识别，请稍后重试。`,
      )
      updateStatusIndicator('offline', undefined, toggleBridge)
    }

    // Recognition finished: clear the thumbnail mask and drop the pending
    // image draft (the images already rode into `content` above).
    hideThumbnailOverlay()
    if (pendingLocalImages.length > 0) {
      pendingLocalImages.splice(0)
      renderLocalImageDraft()
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

    // The DSH composer may abort its original request (its own send timeout)
    // while recognition is still running; resending with that aborted signal
    // would fail immediately and drop the message. Drop the signal and resend.
    const { signal: _droppedSignal, ...resendInit } = init
    return originalFetch(input, { ...resendInit, body: JSON.stringify(envelope) })
  }

  window.fetch = patchedFetch
  if (readConfig().uploadEnabled) {
    // Intercept non-image file pastes (Finder copy → Cmd+V) for upload.
    // Capture phase: run before the composer's own paste handler.
    const onPaste = (event: ClipboardEvent): void => handleFilePaste(originalFetch, event)
    document.addEventListener('paste', onPaste, { capture: true })

    // Local "＋" button: pick files/images from disk. Images join the next
    // message (recognition path); other files upload to the workspace.
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    input.addEventListener('change', () => {
      if (input.files !== null && input.files.length > 0) {
        addLocalFiles(originalFetch, input.files)
      }
      input.value = ''
    })
    document.querySelectorAll('#dsh-vision-attach-button').forEach(el => el.remove())
    const addButton = document.createElement('button')
    addButton.id = 'dsh-vision-attach-button'
    addButton.textContent = '📎'
    addButton.title = '添加文件或图片'
    addButton.style.cssText = [
      'width:30px', 'height:30px', 'flex:none', 'border-radius:8px',
      'border:1px solid rgba(128,128,128,.4)', 'box-sizing:border-box',
      'background:rgba(28,28,32,.85)', 'color:#ddd', 'cursor:pointer',
      'font:14px/1 sans-serif', 'display:inline-flex', 'align-items:center',
      'justify-content:center', 'padding:0', 'margin:auto 0',
    ].join(';')
    addButton.addEventListener('click', () => input.click())
    document.body.appendChild(addButton)
    // Anchor inside the composer card (bottom-left, next to the input) so it
    // participates in layout instead of floating over other buttons. Fall
    // back to fixed positioning only when the composer is absent.
    // Mount in a shared rail at the top of the composer (layout flow, never
    // fixed, never inside the input). The rail also hosts the status pill.
    const ensureRail = (): HTMLElement | null => {
      const composer = document.querySelector('[data-composer-card]')
      if (composer === null) return null
      document.querySelectorAll('#dsh-vision-ui-rail').forEach(el => {
        if (el !== document.getElementById('dsh-vision-ui-rail')) el.remove()
      })
      let rail = document.getElementById('dsh-vision-ui-rail')
      if (rail === null) {
        rail = document.createElement('div')
        rail.id = 'dsh-vision-ui-rail'
        rail.style.cssText = [
          'display:flex', 'align-items:center', 'justify-content:flex-start',
          'gap:6px', 'flex-wrap:nowrap',
          'padding:10px 12px', 'min-height:30px',
          'margin-top:-10px', 'margin-bottom:-12px',
          'border-bottom:1px solid rgba(128,128,128,.15)',
          'min-width:0', 'overflow:visible', 'box-sizing:border-box',
        ].join(';')
        composer.insertBefore(rail, composer.firstChild)
      }
      // The status pill belongs first in the rail (it may have been created
      // before the rail existed and ended up on document.body).
      const pill = document.getElementById('dsh-vision-indicator')
      if (pill !== null && pill.parentElement !== rail) {
        rail.insertBefore(pill, rail.firstChild)
      }
      return rail
    }
    const placeAddButton = (): void => {
      document.querySelectorAll('#dsh-vision-attach-button').forEach(el => {
        if (el !== addButton) el.remove()
      })
      const rail = ensureRail()
      if (rail === null) {
        if (addButton.parentElement !== document.body) document.body.appendChild(addButton)
        return
      }
      const pill = document.getElementById('dsh-vision-indicator')
      if (pill !== null && pill.parentElement !== rail) {
        rail.insertBefore(pill, rail.firstChild)
      }
      const expected = pill !== null ? pill.nextSibling : rail.firstChild
      if (addButton.parentElement !== rail || addButton !== expected) {
        if (pill !== null) pill.after(addButton)
        else rail.insertBefore(addButton, rail.firstChild)
      }
    }
    placeAddButton()
    // Poll only. A MutationObserver here caused an infinite loop: moving the
    // pill/button triggers the observer, which moves them again → page freeze.
    const repositionTimer = window.setInterval(placeAddButton, 400)

    // Drag & drop a file onto the page uploads it too. Intercept at the
    // window capture phase (before DSH's own listeners) and stop immediate
    // propagation for EVERY drag event carrying files: DSH shows its native
    // "文件拖动到此处即可添加" overlay on dragenter and hides it on drop —
    // if it only sees the enter it stays stuck over the composer and blocks
    // typing. Never letting it see any drag event avoids that entirely.
    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).some(type => type === 'Files')
    const swallow = (event: DragEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
    const onDragEnter = (event: DragEvent): void => { if (hasFiles(event)) swallow(event) }
    const onDragOver = (event: DragEvent): void => { if (hasFiles(event)) swallow(event) }
    const onDragLeave = (event: DragEvent): void => { if (hasFiles(event)) swallow(event) }
    const onDrop = (event: DragEvent): void => {
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) return
      swallow(event)
      handleFileDrop(originalFetch, files)
    }
    window.addEventListener('dragenter', onDragEnter, { capture: true })
    window.addEventListener('dragover', onDragOver, { capture: true })
    window.addEventListener('dragleave', onDragLeave, { capture: true })
    window.addEventListener('drop', onDrop, { capture: true })
    // Belt & braces: if DSH's overlay ever appears (e.g. a drag that started
    // before this plugin loaded), remove it so the composer stays usable.
    const overlayKiller = window.setInterval(() => {
      document.querySelectorAll('[data-conversation-composer-overlay]').forEach(el => el.remove())
    }, 500)
    ctx.effect(() => () => {
      document.removeEventListener('paste', onPaste, { capture: true })
      window.removeEventListener('dragenter', onDragEnter, { capture: true })
      window.removeEventListener('dragover', onDragOver, { capture: true })
      window.removeEventListener('dragleave', onDragLeave, { capture: true })
      window.removeEventListener('drop', onDrop, { capture: true })
      window.clearInterval(overlayKiller)
      window.clearInterval(repositionTimer)
      addButton.remove()
      input.remove()
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
