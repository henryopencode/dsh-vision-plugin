# DSH Win7 桌面客户端

把远程 DSH Web（`http://122.51.55.180:3080/`）封装成 **Windows 7 可用的独立桌面应用**。

技术栈：**Electron 22（Chromium 108）**——这是最后一个支持 Windows 7 的 Electron 版本（[官方公告](https://www.electronjs.org/zh/blog/windows-7-to-8-1-deprecation-notice)）。

## 功能

- 固定窗口加载远程 DSH Web（登录、识图、文件上传照常工作）
- 单实例（重复打开聚焦已有窗口）
- 外链（非目标站点的链接）用系统默认浏览器打开
- User-Agent 伪装成 Win7 时代的 Chrome 109，避免平台误判
- 关闭硬件加速（Win7 老显卡兼容）

## 在 Windows 上构建（推荐，无交叉编译问题）

```bat
:: 需要 Node.js 16+（Win7 可用 Node 16.20.2）
cd desktop
npm install
npm run dist:win
```

产物在 `dist/` 下：`DSH Setup 1.0.0.exe`（NSIS 安装包，含桌面快捷方式）。

## 在 macOS 上交叉构建

```bash
cd desktop
npm install
# 需要 wine（用于写 exe 图标/版本信息）
brew install wine-stable
npm run dist:win
```

> 不装 wine 时构建也能出包，但 exe 图标和版本信息可能是默认的。

## 配置

默认连接 `http://122.51.55.180:3080/`。要换地址：

```bat
set DSH_URL=http://你的地址:3080/ && npm run dist:win
```

或直接改 `main.js` 里的 `DSH_URL`。

## 注意事项

- **Electron 22 的 Chromium 108 较旧**：识图插件的缩略图蒙层、设置弹窗等新功能在 108 上未充分测试，若异常请反馈（服务端 nginx 已注入 `crypto.randomUUID` polyfill 解决安全上下文限制）。
- 目标机器**无需安装 Chrome**（自带 Chromium 108）。
- Win7 需安装 [KB4474419](https://www.catalog.update.microsoft.com/Search.aspx?q=KB4474419)（SHA-2 支持）才能运行较新安装包——Win7 SP1 且未打全补丁时可能提示"不是有效的 Win32 应用程序"。
