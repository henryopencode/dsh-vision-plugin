# dsh-vision-plugin

**Paste an image into the DeepSeek Harness conversation composer and get it recognized — powered by a local Ollama vision model. Works on Windows, macOS, and Linux.**

English | [中文](README.zh.md)

## What it does

- Paste an image (`Ctrl/Cmd+V`) into the chat input → preview appears (native DSH UI)
- On send, the image is recognized locally: **no cloud API, images never leave your machine**
- The message shows **both the recognition result and the original image**
- Works with any chat model — even text-only ones like `deepseek-chat` — because the picture is converted to text before the model sees it
- A status pill (top center of the page) shows online/offline/recognizing; click it to toggle

## Architecture

```
paste image → browser plugin (ui-vision-bridge)
  ├─ downscale to 1280px (20 MB → ~300 KB)
  ├─ same-origin POST /vision/recognize
  │     └─ server plugin (vision-server):
  │           ├─ sharp downscale (safety net)
  │           ├─ store original as attachment (shown in chat)
  │           ├─ recognize with local Ollama model (default qwen2.5vl:3b)
  │           └─ return text + attachment id
  └─ message = user text + 【recognition result】 + ![原图](/vision/image/<id>)
```

Two components:
1. **Browser plugin** (`browser/dsh-client-ui-vision-bridge/`) — a regular DSH client plugin (built bundle included)
2. **Server plugin** (`server/vision-server.mjs`) — a same-origin endpoint inside your DSH web profile

## Requirements

| Component | Requirement |
|---|---|
| DeepSeek Harness | installed, `dsh web` run at least once |
| Ollama | [ollama.com/download](https://ollama.com/download) (Windows/macOS/Linux) |
| Vision model | `qwen2.5vl:3b` (default, ~2 GB) — installed by the script |

## Install

### Windows

1. Install DSH and run `dsh web` once (creates `%USERPROFILE%\.dsh\profiles\web`)
2. Download this repo (green "Code" → Download ZIP) and extract
3. **Double-click `install/install.bat`** (or run PowerShell):
   ```powershell
   powershell -ExecutionPolicy Bypass -File install\install.ps1
   ```
   The script: installs Ollama via winget if missing → pulls the vision model → copies plugin files → registers them
4. Restart `dsh web` (or the DSH app), then open **http://127.0.0.1:3080** in Edge/Chrome and refresh

### macOS / Linux

```bash
bash install/install.sh            # or: bash install/install.sh qwen3-vl:4b
# restart dsh web, open http://127.0.0.1:3080, refresh
```

### Manual install (any platform)

```bash
# 1. model
ollama pull qwen2.5vl:3b

# 2. server plugin → $DSH_HOME/profiles/web/  (macOS/Linux: ~/.dsh/profiles/web/)
cp server/vision-server.mjs ~/.dsh/profiles/web/

# 3. browser plugin → profiles/node_modules/@deepseek-ai/
mkdir -p ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-vision-bridge
cp -R browser/dsh-client-ui-vision-bridge/lib ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-vision-bridge/
cp browser/dsh-client-ui-vision-bridge/package.json ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-vision-bridge/

# 4. register in ~/.dsh/profiles/web/cordis.patch.yml (idempotent):
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'

- insert:
    - id: vision-server
      name: ./vision-server.mjs
      config:
        model: qwen2.5vl:3b
        ocrEnabled: false
        baseURL: http://127.0.0.1:11434/v1
EOF

# 5. restart dsh web, refresh browser
```

## Configuration

Per-user overrides live in `localStorage` (browser console) under `dsh-vision:config`:

```js
localStorage.setItem('dsh-vision:config', JSON.stringify({
  model: 'qwen3-vl:4b',        // more accurate on small text, slower
  ocrEnabled: true,            // enable DeepSeek-OCR text pass (needs: ollama pull deepseek-ocr)
  timeoutMs: 120000,
  maxImageEdge: 1280,
}))
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch (also toggle via the pill) |
| `baseURL` | `http://127.0.0.1:11434/v1` | Ollama endpoint |
| `model` | `qwen2.5vl:3b` | Vision model |
| `ocrModel` | `deepseek-ocr` | OCR model for precise text (`''` disables) |
| `ocrEnabled` | `false` | Run the OCR pass (slower, more precise text) |
| `timeoutMs` | `120000` | Per-engine timeout |
| `keepAlive` | `-1` | Ollama keep-alive sent on each call (Windows Ollama honors it; macOS 0.32.x ignores it — use the `OLLAMA_KEEP_ALIVE` env var there) |
| `maxImageEdge` | `2048` | Recognition resolution (2048 keeps small text legible; 1280 misreads names like 全能王) |
| `maxImages` | `4` | Max images per message |

**Model comparison** (tested):
- `qwen2.5vl:3b` — fast (~15 s), light on RAM; occasionally makes up names
- `qwen3-vl:4b` — accurate on dense small text (~30 s)
- `deepseek-ocr` + vision model — dual engine: precise OCR text + scene description

## Performance: avoid "first recognition times out"

Ollama loads the vision model on demand and, by default, unloads it after 5
minutes idle (`OLLAMA_KEEP_ALIVE=5m0s`). The first image after idle then pays a
cold load — on a CPU-only machine that can feel like a timeout and succeed only
on the second attempt. Two fixes, in order of impact:

1. **Keep the model resident.** This plugin already sends `keep_alive: -1` on
   every recognition call, so once the model is loaded it stays loaded. For
   belt-and-braces (and to cover any other Ollama caller), also set:
   ```powershell
   setx OLLAMA_KEEP_ALIVE -1   # Windows; macOS/Linux: export in your shell profile
   ```
2. **Use the iGPU/GPU.** Ollama drops integrated GPUs by default. If your
   machine has an iGPU (e.g. AMD Radeon 780M), enable it so inference is far
   faster than CPU:
   ```powershell
   setx OLLAMA_IGPU_ENABLE 1   # Windows
   ```
   Then restart Ollama. (A discrete NVIDIA/AMD GPU needs no such flag.)

Optional: warm the model at logon with `scripts/warmup-ollama.ps1` so the very
first recognition of the day is already warm:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\warmup-ollama.ps1
```

Register it in the Windows Startup folder (or a logon task) pointing at the
script's full path.

> Note: `keep_alive` in the request body is honored by the Windows Ollama
> build (verified by the original contributor) but ignored by macOS Ollama
> 0.32.x. The reliable cross-platform way to keep the model resident is the
> `OLLAMA_KEEP_ALIVE=-1` environment variable (then restart Ollama).

## Why not just use native multimodal (DSH v0.1.0-rc.8)?

DSH rc.8 added *configurable native image requests* for the DeepSeek adapter —
but **the DeepSeek API itself rejects image content today**. Verified on
rc.8 with a real request:

```
messages[1]: unknown variant `image_url`, expected `text`
```

So the framework can send images, but the DeepSeek model endpoint only
accepts text. This plugin fills exactly that gap with local recognition, and
stays relevant until DeepSeek ships a vision-capable endpoint.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Pill shows 🔴 识图不可用 | Ollama not running, or model missing (`ollama pull qwen2.5vl:3b`) |
| `⚠️ 本地识图服务不可用` | `vision-server` not deployed, or request timed out; re-run installer, restart `dsh web` |
| Nothing happens on paste | Embedded app WebView may not forward clipboard; use Chrome/Edge/Safari, or drag & drop the image |
| `The operation timed out. (internal)` | App WebView network limits; use a real browser |
| Recognition makes up names | Switch to `qwen3-vl:4b` |

## Development

The browser plugin source lives in `browser/dsh-client-ui-vision-bridge/src` (TypeScript). Rebuild with:

```bash
cd browser/dsh-client-ui-vision-bridge
npm install            # peer deps from the DSH repo
npx tsc -p tsconfig.json --noEmit
npx tsdown             # produces lib/client.js
```

For DSH-repo integration (as a first-class plugin package), see `docs/dsh-integration.md`.

## License

MIT
