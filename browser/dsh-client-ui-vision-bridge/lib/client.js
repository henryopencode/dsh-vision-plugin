window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-vision-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region lib/types/client/index.js
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
		/** Default bridge configuration; overridable per user via localStorage. */
		const DEFAULT_CONFIG = {
			/** Master switch. */
			enabled: true,
			/** Local vision endpoint (Ollama OpenAI-compatible base URL). */
			baseURL: "http://127.0.0.1:11434/v1",
			/**
			* Vision model to ask. qwen2.5vl:3b is the fast default; switch to
			* qwen3-vl:4b when dense small-text accuracy matters more than speed.
			*/
			model: "qwen2.5vl:3b",
			/** Per-engine recognition timeout (each OCR/vision call). */
			timeoutMs: 12e4,
			/** Upper bound of images recognized in one message. */
			maxImages: 4,
			/**
			* Longest edge images are downscaled to before recognition. High-resolution
			* pastes (screenshots, photos) otherwise exceed the model's default context
			* window because the vision encoder tiles them into many tokens.
			*/
			maxImageEdge: 1280,
			/** Ollama context window requested for the recognition call. */
			numCtx: 32768,
			/** System prompt for the vision model. */
			systemPrompt: "你是图像识别助手。如果用户提出了具体问题，请优先直接回答该问题（不确定的名称如实说明，不要编造）；然后补充必要的画面细节。不要使用任何工具。",
			/**
			* Dedicated OCR model for precise in-image text extraction (DeepSeek-OCR).
			* Set to `''` to disable OCR and keep only the vision-model description.
			*/
			ocrModel: "deepseek-ocr",
			/**
			* Whether to run the OCR pass. Off by default: the two-model pipeline pays
			* a model-swap load on low-memory machines. Enable it when precise in-image
			* text matters more than speed.
			*/
			ocrEnabled: false,
			/** Prompt the OCR engine receives. */
			ocrPrompt: "请提取这张图片中的全部文字内容，按阅读顺序列出，不要描述画面。"
		};
		/** The localStorage key carrying user overrides. */
		const CONFIG_KEY = "dsh-vision:config";
		/** Extra time for the same-origin response after one recognition budget per image. */
		const SERVER_RESPONSE_GRACE_MS = 3e4;
		/** Largest source image allowed through when browser-side re-encoding fails. */
		const MAX_FALLBACK_UPLOAD_BYTES = 2 * 1024 * 1024;
		/** Read the effective configuration, merging user overrides over defaults. */
		function readConfig() {
			try {
				const raw = window.localStorage.getItem(CONFIG_KEY);
				if (raw !== null) {
					const parsed = JSON.parse(raw);
					if (typeof parsed === "object" && parsed !== null) return {
						...DEFAULT_CONFIG,
						...parsed
					};
				}
			} catch {}
			return { ...DEFAULT_CONFIG };
		}
		/** Whether a prompt content part is an image part. */
		function isImagePart(part) {
			return typeof part === "object" && part !== null && part.type === "image";
		}
		/** Whether a prompt content part is a text part. */
		function isTextPart(part) {
			return typeof part === "object" && part !== null && part.type === "text";
		}
		/**
		* Return a request budget that covers every sequential recognition plus the
		* same-origin response. Browser-side image preparation runs before this timer.
		* @param config - effective bridge configuration.
		* @param imageCount - number of images included in the request.
		* @returns milliseconds before the browser abandons the same-origin request.
		*/
		function recognitionRequestTimeoutMs(config, imageCount) {
			return config.timeoutMs * Math.max(1, imageCount) + SERVER_RESPONSE_GRACE_MS;
		}
		/**
		* Whether a source payload is small enough to retry without browser-side
		* conversion.
		* @param data - base64 image payload.
		* @returns whether the estimated decoded bytes fit the fallback upload limit.
		*/
		function canUploadUncompressedImage(data) {
			return Math.floor(data.length * 3 / 4) <= MAX_FALLBACK_UPLOAD_BYTES;
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
		async function downscaleImage(data, mediaType, maxEdge) {
			const source = new Image();
			await new Promise((resolve, reject) => {
				source.onload = () => resolve();
				source.onerror = () => reject(/* @__PURE__ */ new Error("无法解码图片"));
				source.src = `data:${mediaType};base64,${data}`;
			});
			const longest = Math.max(source.naturalWidth, source.naturalHeight);
			if (longest <= maxEdge) return {
				data,
				mediaType
			};
			const scale = maxEdge / longest;
			const width = Math.max(1, Math.round(source.naturalWidth * scale));
			const height = Math.max(1, Math.round(source.naturalHeight * scale));
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			if (context === null) return {
				data,
				mediaType
			};
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, width, height);
			context.drawImage(source, 0, 0, width, height);
			const outputType = mediaType === "image/jpeg" || mediaType === "image/webp" ? mediaType : "image/jpeg";
			const url = canvas.toDataURL(outputType, .9);
			const comma = url.indexOf(",");
			if (comma === -1) return {
				data,
				mediaType
			};
			return {
				data: url.slice(comma + 1),
				mediaType: outputType
			};
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
		async function recognizeViaServer(originalFetch, config, images, question) {
			const controller = new AbortController();
			let timer;
			try {
				const prepared = [];
				for (const image of images) {
					const data = typeof image.data === "string" ? image.data : "";
					const mediaType = typeof image.mediaType === "string" && image.mediaType.length > 0 ? image.mediaType : "image/png";
					if (data === "") {
						prepared.push({
							data: "",
							mediaType
						});
						continue;
					}
					try {
						const downscaled = await downscaleImage(data, mediaType, config.maxImageEdge);
						prepared.push({
							data: downscaled.data,
							mediaType: downscaled.mediaType
						});
					} catch {
						if (!canUploadUncompressedImage(data)) prepared.push({
							data: "",
							mediaType,
							failure: "图片压缩失败，已停止上传原始大图；请重新粘贴图片或换用较小文件。"
						});
						else prepared.push({
							data,
							mediaType
						});
					}
				}
				timer = setTimeout(() => controller.abort(), recognitionRequestTimeoutMs(config, prepared.length));
				const response = await originalFetch("/vision/recognize", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: config.model,
						ocrModel: config.ocrModel,
						ocrEnabled: config.ocrEnabled,
						maxImageEdge: config.maxImageEdge,
						timeoutMs: config.timeoutMs,
						question,
						images: prepared
					}),
					signal: controller.signal
				});
				if (!response.ok) return void 0;
				const payload = await response.json();
				if (!Array.isArray(payload.results) || payload.results.length !== prepared.length) return void 0;
				return {
					results: payload.results.map((result, index) => {
						const failure = prepared[index]?.failure;
						return failure === void 0 ? result : { scene: `⚠️ ${failure}` };
					}),
					imageIds: payload.attachmentIds === void 0 ? prepared.map(() => "") : payload.attachmentIds.map((id) => id ?? "")
				};
			} catch {
				return;
			} finally {
				if (timer !== void 0) clearTimeout(timer);
			}
		}
		/**
		* Probe the local vision service: reachable? are the configured models
		* installed? Called before recognition so a dead service or missing model
		* fails fast with an immediate message instead of a long silent wait.
		* @param originalFetch - the unpatched global fetch.
		* @param config - effective bridge configuration.
		* @returns the probe outcome.
		*/
		async function probeModels(originalFetch, config) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 8e3);
			try {
				const response = await originalFetch(`${config.baseURL.replace(/\/+$/, "")}/models`, {
					method: "GET",
					headers: { Accept: "application/json" },
					signal: controller.signal
				});
				if (!response.ok) return {
					ok: false,
					reason: `本地视觉服务 HTTP ${response.status}`
				};
				const payload = await response.json();
				const known = new Set((payload.data ?? []).map((entry) => entry.id ?? ""));
				const matches = (name) => known.has(name) || known.has(`${name}:latest`) || known.has(name.split(":")[0]);
				const missing = [];
				if (!matches(config.model)) missing.push(config.model);
				if (config.ocrEnabled && config.ocrModel !== "" && !matches(config.ocrModel)) missing.push(config.ocrModel);
				if (missing.length > 0) return {
					ok: false,
					reason: `模型未安装：${missing.join("、")}（请运行 ollama pull ${missing.join(" 和 ollama pull ")}）`
				};
				return { ok: true };
			} catch {
				return {
					ok: false,
					reason: "本地视觉服务未运行（请先启动 Ollama）"
				};
			} finally {
				clearTimeout(timer);
			}
		}
		/**
		* Position the pill over the middle content column: horizontally centered on
		* the composer card (the content area's true center, not the page's) and
		* vertically aligned with the view-tab bar ("对话/轨迹", the two lines),
		* nudged slightly down-right. Falls back to page top-center.
		* @param el - the indicator element.
		*/
		function positionIndicator(el) {
			const composer = document.querySelector("[data-composer-card]");
			if (composer !== null) {
				const rect = composer.getBoundingClientRect();
				const width = el.offsetWidth > 0 ? el.offsetWidth : 120;
				const centerX = rect.left + rect.width / 2;
				const tabs = document.querySelector("[role=\"tablist\"]");
				const tabTop = tabs !== null ? tabs.getBoundingClientRect().top : rect.top - 60;
				el.style.left = `${Math.max(4, centerX - width / 2 + 6)}px`;
				el.style.top = `${Math.max(4, tabTop - 25)}px`;
				el.style.bottom = "auto";
				el.style.right = "auto";
				el.style.transform = "none";
				return;
			}
			el.style.top = "10px";
			el.style.left = "50%";
			el.style.right = "auto";
			el.style.bottom = "auto";
			el.style.transform = "translateX(-50%)";
		}
		/**
		* Update (or create) the status pill over the middle content column.
		* Clicking the pill toggles the whole bridge.
		* @param state - the state to show.
		* @param detail - optional detail text (e.g. the recognition stage).
		* @param onToggle - callback for a click (toggle the bridge).
		*/
		function updateStatusIndicator(state, detail, onToggle) {
			let el = document.getElementById("dsh-vision-indicator");
			if (el === null) {
				el = document.createElement("button");
				el.id = "dsh-vision-indicator";
				el.title = "点击开启/关闭本地识图";
				el.style.cssText = [
					"position:fixed",
					"z-index:9998",
					"border:1px solid rgba(128,128,128,.35)",
					"background:rgba(28,28,32,.85)",
					"color:#ddd",
					"cursor:pointer",
					"padding:4px 12px",
					"border-radius:999px",
					"font:12px/1.4 -apple-system,BlinkMacSystemFont,\"PingFang SC\",sans-serif",
					"box-shadow:0 2px 8px rgba(0,0,0,.2)",
					"white-space:nowrap"
				].join(";");
				el.addEventListener("click", onToggle);
				const reposition = () => positionIndicator(el);
				window.addEventListener("scroll", reposition, { passive: true });
				window.addEventListener("resize", reposition, { passive: true });
				const ticker = window.setInterval(reposition, 800);
				el.dataset.ticker = String(ticker);
				document.body.appendChild(el);
			}
			el.textContent = `${state === "online" ? "🟢" : state === "busy" ? "⏳" : state === "disabled" ? "⚪" : "🔴"} ${state === "online" ? "识图就绪" : state === "busy" ? "识别中" : state === "disabled" ? "识图已关闭（点击开启）" : "识图不可用"}${detail === void 0 ? "" : ` · ${detail}`}`;
			positionIndicator(el);
		}
		/**
		* Browser half: install the fetch interception for the plugin lifetime.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			if (typeof window === "undefined" || typeof window.fetch !== "function") return;
			const originalFetch = window.fetch.bind(window);
			/** Persist the bridge on/off switch and refresh the indicator. */
			const toggleBridge = () => {
				const config = readConfig();
				const next = {
					...config,
					enabled: !config.enabled
				};
				try {
					window.localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
				} catch {}
				if (next.enabled) {
					updateStatusIndicator("busy", "检测中", toggleBridge);
					probeModels(originalFetch, next).then((probe) => {
						updateStatusIndicator(probe.ok ? "online" : "offline", probe.ok ? void 0 : probe.reason, toggleBridge);
					});
				} else updateStatusIndicator("disabled", void 0, toggleBridge);
			};
			const initial = readConfig();
			if (!initial.enabled) updateStatusIndicator("disabled", void 0, toggleBridge);
			else probeModels(originalFetch, initial).then((probe) => {
				updateStatusIndicator(probe.ok ? "online" : "offline", probe.ok ? void 0 : probe.reason, toggleBridge);
			});
			const patchedFetch = async (input, init) => {
				const config = readConfig();
				if (!config.enabled) return originalFetch(input, init);
				const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
				if ((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() !== "POST") return originalFetch(input, init);
				let pathname;
				try {
					pathname = new URL(requestUrl, window.location.href).pathname;
				} catch {
					return originalFetch(input, init);
				}
				if (!pathname.endsWith("/api/session.prompt")) return originalFetch(input, init);
				if (typeof init?.body !== "string") return originalFetch(input, init);
				let envelope;
				try {
					envelope = JSON.parse(init.body);
				} catch {
					return originalFetch(input, init);
				}
				if (envelope.type !== "client-request" || envelope.method !== "session.prompt") return originalFetch(input, init);
				const payload = envelope.payload;
				const content = payload?.content;
				if (!Array.isArray(content)) return originalFetch(input, init);
				const images = content.filter(isImagePart);
				if (images.length === 0) return originalFetch(input, init);
				const texts = content.filter(isTextPart).map((part) => part.text ?? "").join("");
				const userQuestion = texts.trim().length > 0 ? texts.trim() : void 0;
				const probe = await probeModels(originalFetch, config);
				if (!probe.ok) {
					updateStatusIndicator("offline", void 0, toggleBridge);
					const note = `【📷 识图不可用】${probe.reason ?? ""}`;
					payload.content = texts.trim().length > 0 ? [{
						type: "text",
						text: `${texts.trim()}\n\n${note}`
					}] : [{
						type: "text",
						text: note
					}];
					return originalFetch(input, {
						...init,
						body: JSON.stringify(envelope)
					});
				}
				updateStatusIndicator("busy", void 0, toggleBridge);
				const recognized = [];
				const targetImages = images.slice(0, config.maxImages);
				const started = Date.now();
				const serverResults = await recognizeViaServer(originalFetch, config, targetImages, userQuestion);
				const elapsedSec = Math.round((Date.now() - started) / 1e3);
				if (serverResults !== void 0) {
					for (let index = 0; index < serverResults.results.length; index += 1) {
						const result = serverResults.results[index];
						let text = `【画面】\n${result.scene}`;
						if (result.text !== void 0 && result.text.length > 0) text += `\n\n【文字】\n${result.text}`;
						recognized.push(text);
					}
					if (images.length > config.maxImages) recognized.push(`⚠️ 另有 ${images.length - config.maxImages} 张图片未识别（单条消息最多识别 ${config.maxImages} 张）`);
					updateStatusIndicator("online", void 0, toggleBridge);
				} else {
					recognized.push(`⚠️ 本地识图服务不可用（${elapsedSec} 秒内未响应）。请确认 vision-server 插件已部署、Ollama 已启动。`);
					updateStatusIndicator("offline", void 0, toggleBridge);
				}
				const rewritten = [];
				if (texts.trim().length > 0) rewritten.push({
					type: "text",
					text: texts.trim()
				});
				for (let index = 0; index < recognized.length; index += 1) {
					const label = images.length > 1 ? `图片 ${index + 1}` : "图片";
					rewritten.push({
						type: "text",
						text: `【📷 ${label}识别结果】\n${recognized[index]}`
					});
				}
				const imageIds = serverResults === void 0 ? void 0 : serverResults.imageIds;
				if (imageIds !== void 0) for (let index = 0; index < imageIds.length; index += 1) {
					const id = imageIds[index];
					if (id === void 0 || id === "") continue;
					const label = imageIds.length > 1 ? `原图 ${index + 1}` : "原图";
					rewritten.push({
						type: "text",
						text: `![${label}](/vision/image/${id})`
					});
				}
				if (recognized.length > 0) rewritten.push({
					type: "text",
					text: "（以上是图片识别结果。请结合用户的问题和识别结果，直接回答用户的问题。）"
				});
				payload.content = rewritten;
				return originalFetch(input, {
					...init,
					body: JSON.stringify(envelope)
				});
			};
			window.fetch = patchedFetch;
			ctx.effect(() => () => {
				if (window.fetch === patchedFetch) window.fetch = originalFetch;
				const pill = document.getElementById("dsh-vision-indicator");
				if (pill !== null) {
					const ticker = Number(pill.dataset.ticker);
					if (Number.isFinite(ticker) && ticker > 0) window.clearInterval(ticker);
					pill.remove();
				}
			});
		}
		//#endregion
		exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
		exports.apply = apply;
		exports.canUploadUncompressedImage = canUploadUncompressedImage;
		exports.readConfig = readConfig;
		exports.recognitionRequestTimeoutMs = recognitionRequestTimeoutMs;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map