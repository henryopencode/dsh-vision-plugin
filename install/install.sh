#!/usr/bin/env bash
# dsh-vision-plugin — macOS/Linux 一键安装脚本
# 用法: bash install.sh [模型名]   (默认 qwen2.5vl:3b)
set -euo pipefail

MODEL="${1:-qwen2.5vl:3b}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="dsh-client-ui-vision-bridge"

echo "=============================================="
echo "  dsh-vision-plugin installer (macOS/Linux)"
echo "=============================================="

# 1. Ollama
if ! command -v ollama >/dev/null 2>&1; then
  echo "[1/4] Ollama 未安装。请先安装：https://ollama.com/download  (或 brew install ollama)"
  exit 1
fi
echo "[1/4] Ollama: OK"

# 2. 拉模型
echo "[2/4] 拉取模型 $MODEL …"
ollama pull "$MODEL"

# 3. 定位 DSH 用户目录
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
WEB_DIR="$DSH_HOME/profiles/web"
if [ ! -d "$WEB_DIR" ]; then
  echo "[3/4] 未找到 DSH web profile: $WEB_DIR"
  echo "     请先安装并运行一次 DSH Web（dsh web），再运行本脚本。"
  exit 1
fi
echo "[3/4] DSH 用户目录: $DSH_HOME"

# 4. 安装文件
echo "[4/4] 安装插件文件…"
cp "$SCRIPT_DIR/../server/vision-server.mjs" "$WEB_DIR/vision-server.mjs"

PKG_DIR="$DSH_HOME/profiles/node_modules/@deepseek-ai/$PLUGIN_NAME"
mkdir -p "$PKG_DIR/lib"
cp -R "$SCRIPT_DIR/../browser/dsh-client-ui-vision-bridge/lib/." "$PKG_DIR/lib/"
cp "$SCRIPT_DIR/../browser/dsh-client-ui-vision-bridge/package.json" "$PKG_DIR/package.json"

PATCH="$WEB_DIR/cordis.patch.yml"
if ! grep -q "vision-server" "$PATCH" 2>/dev/null; then
  cat >> "$PATCH" <<EOF

# dsh-vision-plugin: local vision recognition (installed by install.sh)
- insert:
    - id: vision-server
      name: ./vision-server.mjs
      config:
        model: $MODEL
        ocrEnabled: false
        baseURL: http://127.0.0.1:11434/v1
EOF
  echo "  cordis.patch.yml: 已注册 vision-server"
else
  echo "  cordis.patch.yml: vision-server 已存在，跳过"
fi

echo ""
echo "✔ 安装完成！"
echo "最后一步：重启 DSH Web，然后用 Chrome/Safari 打开 http://127.0.0.1:3080 并刷新页面。"
echo "粘贴图片 → 发送 → 20-30 秒后得到识别结果。"
