# dsh-vision-plugin

**在 DeepSeek Harness 对话输入框直接粘贴图片并自动识别——由本地 Ollama 视觉模型驱动，支持 Windows / macOS / Linux。**

[English](README.md) | 中文

## 功能

- 粘贴图片（`Ctrl/Cmd+V`）→ 输入框显示预览（DSH 原生 UI）
- 发送后**本地识别**：无云端 API，图片不出机器
- 消息中**同时显示识别结果和原图**
- 任何对话模型都可用——即使是 `deepseek-chat` 这类纯文本模型（图片在到达模型前已转为文字）
- 页面顶部中央有状态胶囊：🟢 就绪 / 🔴 不可用 / ⏳ 识别中；点击可开关

## 架构

```
粘贴图片 → 浏览器插件 (ui-vision-bridge)
  ├─ 压缩到 1280px（20MB → ~300KB）
  ├─ 同源 POST /vision/recognize
  │     └─ 服务端插件 (vision-server)：
  │           ├─ sharp 二次压缩（兜底）
  │           ├─ 保存原图为附件（对话回显）
  │           ├─ 调本地 Ollama 模型识别（默认 qwen2.5vl:3b）
  │           └─ 返回 文本 + 附件ID
  └─ 消息 = 用户文字 + 【识别结果】+ ![原图](/vision/image/<id>)
```

两部分组成：
1. **浏览器插件**（`browser/dsh-client-ui-vision-bridge/`）— 正规 DSH 客户端插件（已含构建产物）
2. **服务端插件**（`server/vision-server.mjs`）— DSH web profile 内的同源识别端点

## 环境要求

| 组件 | 要求 |
|---|---|
| DeepSeek Harness | 已安装，且至少运行过一次 `dsh web` |
| Ollama | [ollama.com/download](https://ollama.com/download)（Windows/macOS/Linux）|
| 视觉模型 | `qwen2.5vl:3b`（默认，约 2GB）— 安装脚本自动拉取 |

## 安装

### Windows

1. 安装 DSH 并运行一次 `dsh web`（生成 `%USERPROFILE%\.dsh\profiles\web`）
2. 下载本仓库（绿色 Code → Download ZIP）并解压
3. **双击 `install/install.bat`**（或运行 PowerShell）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File install\install.ps1
   ```
   脚本会自动：缺失时用 winget 安装 Ollama → 拉取视觉模型 → 复制插件文件 → 注册配置
4. 重启 `dsh web`（或 DSH App），用 Edge/Chrome 打开 **http://127.0.0.1:3080** 并刷新

### macOS / Linux

```bash
bash install/install.sh            # 或：bash install/install.sh qwen3-vl:4b
# 重启 dsh web，打开 http://127.0.0.1:3080，刷新
```

### 手动安装（任意平台）

```bash
# 1. 模型
ollama pull qwen2.5vl:3b

# 2. 服务端插件 → ~/.dsh/profiles/web/
cp server/vision-server.mjs ~/.dsh/profiles/web/

# 3. 浏览器插件 → profiles/node_modules/@deepseek-ai/
mkdir -p ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-vision-bridge
cp -R browser/dsh-client-ui-vision-bridge/lib ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-vision-bridge/
cp browser/dsh-client-ui-vision-bridge/package.json ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-vision-bridge/

# 4. 注册（幂等）→ ~/.dsh/profiles/web/cordis.patch.yml
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'

- insert:
    - id: vision-server
      name: ./vision-server.mjs
      config:
        model: qwen2.5vl:3b
        ocrEnabled: false
        baseURL: http://127.0.0.1:11434/v1
EOF

# 5. 重启 dsh web，刷新浏览器
```

## 配置

用户级配置存放在浏览器 `localStorage` 的 `dsh-vision:config`（控制台执行）：

```js
localStorage.setItem('dsh-vision:config', JSON.stringify({
  model: 'qwen3-vl:4b',        // 小字更准，更慢
  ocrEnabled: true,            // 开启 DeepSeek-OCR 文字提取（需 ollama pull deepseek-ocr）
  timeoutMs: 120000,
  maxImageEdge: 1280,
}))
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关（也可点胶囊切换） |
| `baseURL` | `http://127.0.0.1:11434/v1` | Ollama 地址 |
| `model` | `qwen2.5vl:3b` | 识别模型 |
| `ocrModel` | `deepseek-ocr` | OCR 模型（`''` 关闭） |
| `ocrEnabled` | `false` | 是否执行 OCR 提取（更慢但文字精确） |
| `timeoutMs` | `120000` | 单引擎超时 |
| `keepAlive` | `-1` | Ollama keep-alive；`-1` 让模型识别后常驻（下次识别不再冷加载） |
| `maxImageEdge` | `1280` | 上传前压缩边长 |
| `maxImages` | `4` | 单条消息最多图片数 |

**模型对比**（实测）：
- `qwen2.5vl:3b` — 快（约 15 秒）、省内存；偶尔会编造名称
- `qwen3-vl:4b` — 密集小字准确（约 30 秒）
- `deepseek-ocr` + 视觉模型 — 双引擎：精确文字 + 场景描述

## 性能优化：避免「第一次识别超时」

Ollama 按需加载识别模型，默认闲置 5 分钟即卸载（`OLLAMA_KEEP_ALIVE=5m0s`）。闲置后的第一张图要重新冷加载——纯 CPU 机器上这很容易表现为「第一次超时、第二次才成功」。按影响排序，两个修复：

1. **让模型常驻。** 本插件已在每次识别请求里带上 `keep_alive: -1`，模型一旦加载就不再卸载。为稳妥起见（也覆盖其他调用方），再设置：
   ```powershell
   setx OLLAMA_KEEP_ALIVE -1   # Windows；macOS/Linux 写入 shell profile
   ```
2. **启用核显/独显。** Ollama 默认丢弃核显。若你的机器有核显（如 AMD Radeon 780M），启用后推理比 CPU 快得多：
   ```powershell
   setx OLLAMA_IGPU_ENABLE 1   # Windows
   ```
   然后重启 Ollama。（NVIDIA/AMD 独显无需此开关。）

可选：用 `scripts/warmup-ollama.ps1` 在登录时预热模型，让开机后第一张图就是热的：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\warmup-ollama.ps1
```

把它注册到 Windows 启动文件夹（或登录任务）指向脚本完整路径。

## 故障排查

| 现象 | 原因 / 解决 |
|---|---|
| 胶囊 🔴 识图不可用 | Ollama 未启动，或模型缺失（`ollama pull qwen2.5vl:3b`） |
| `⚠️ 本地识图服务不可用` | vision-server 未部署或请求超时；重新运行安装脚本、重启 dsh web |
| 粘贴无反应 | 封装 App 的 WebView 可能不转发剪贴板；用 Chrome/Edge/Safari，或直接拖拽图片 |
| `The operation timed out. (internal)` | App WebView 网络限制；请使用真实浏览器 |
| 识别结果编造名称 | 换 `qwen3-vl:4b` |

## 开发

浏览器插件源码在 `browser/dsh-client-ui-vision-bridge/src`（TypeScript）。重建：

```bash
cd browser/dsh-client-ui-vision-bridge
npm install            # peer 依赖来自 DSH 仓库
npx tsc -p tsconfig.json --noEmit
npx tsdown             # 产出 lib/client.js
```

与 DSH 仓库集成（作为一等插件包）见 `docs/dsh-integration.md`。

## License

MIT
