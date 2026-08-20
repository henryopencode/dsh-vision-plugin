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
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Default bridge configuration; overridable per user via localStorage. */
export declare const DEFAULT_CONFIG: {
    /** Master switch. */
    readonly enabled: true;
    /** Local vision endpoint (Ollama OpenAI-compatible base URL). */
    readonly baseURL: "http://127.0.0.1:11434/v1";
    /**
     * Vision model to ask. qwen2.5vl:3b is the fast default; switch to
     * qwen3-vl:4b when dense small-text accuracy matters more than speed.
     */
    readonly model: "qwen2.5vl:3b";
    /** Per-engine recognition timeout (each OCR/vision call). */
    readonly timeoutMs: 120000;
    /** Upper bound of images recognized in one message. */
    readonly maxImages: 4;
    /**
     * Longest edge images are downscaled to before recognition. High-resolution
     * pastes (screenshots, photos) otherwise exceed the model's default context
     * window because the vision encoder tiles them into many tokens.
     */
    readonly maxImageEdge: 1280;
    /** Ollama context window requested for the recognition call. */
    readonly numCtx: 32768;
    /** System prompt for the vision model. */
    readonly systemPrompt: "你是图像识别助手。如果用户提出了具体问题，请优先直接回答该问题（不确定的名称如实说明，不要编造）；然后补充必要的画面细节。不要使用任何工具。";
    /**
     * Dedicated OCR model for precise in-image text extraction (DeepSeek-OCR).
     * Set to `''` to disable OCR and keep only the vision-model description.
     */
    readonly ocrModel: string;
    /**
     * Whether to run the OCR pass. Off by default: the two-model pipeline pays
     * a model-swap load on low-memory machines. Enable it when precise in-image
     * text matters more than speed.
     */
    readonly ocrEnabled: false;
    /** Prompt the OCR engine receives. */
    readonly ocrPrompt: "请提取这张图片中的全部文字内容，按阅读顺序列出，不要描述画面。";
};
export type VisionBridgeConfig = typeof DEFAULT_CONFIG;
/** Runtime config shape: booleans are mutable (toggled via the indicator). */
export type BridgeConfig = {
    enabled: boolean;
    ocrEnabled: boolean;
} & Omit<VisionBridgeConfig, 'enabled' | 'ocrEnabled'>;
/** Read the effective configuration, merging user overrides over defaults. */
export declare function readConfig(): BridgeConfig;
/**
 * Return a request budget that covers every sequential recognition plus the
 * same-origin response. Browser-side image preparation runs before this timer.
 * @param config - effective bridge configuration.
 * @param imageCount - number of images included in the request.
 * @returns milliseconds before the browser abandons the same-origin request.
 */
export declare function recognitionRequestTimeoutMs(config: BridgeConfig, imageCount: number): number;
/**
 * Whether a source payload is small enough to retry without browser-side
 * conversion.
 * @param data - base64 image payload.
 * @returns whether the estimated decoded bytes fit the fallback upload limit.
 */
export declare function canUploadUncompressedImage(data: string): boolean;
/**
 * Browser half: install the fetch interception for the plugin lifetime.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map