#!/usr/bin/env node
// Login gateway for DSH web: serves an HTML login form (no browser alert),
// issues a session cookie, proxies every other request to the DSH upstream,
// and supports changing the account password. Zero external dependencies.
//
// Users are stored in $DSH_HOME/auth-users.json as scrypt hashes.
// Sessions live in memory (random token, httpOnly cookie).

import { createServer } from 'node:http'
import { request } from 'node:http'
import { connect } from 'node:net'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const USERS_FILE = join(DSH_HOME, 'auth-users.json')
const UPSTREAM_HOST = process.env.DSH_UPSTREAM_HOST || '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.DSH_UPSTREAM_PORT || 3100)
const PORT = Number(process.env.LOGIN_PORT || 3090)
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000 // 7 days
const COOKIE_NAME = 'dsh_session'

const sessions = new Map() // token -> { username, expiresAt }
let users = {} // username -> { salt, hash }

function loadUsers() {
  return readFile(USERS_FILE, 'utf8')
    .then((text) => { users = JSON.parse(text); return true })
    .catch(() => false)
}

async function saveUsers() {
  await mkdir(dirname(USERS_FILE), { recursive: true })
  await writeFile(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 })
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 32).toString('hex')
  return { salt, hash }
}

function verifyPassword(password, record) {
  if (!record) return false
  const test = scryptSync(password, record.salt, 32)
  const expected = Buffer.from(record.hash, 'hex')
  return test.length === expected.length && timingSafeEqual(test, expected)
}

function readSession(req) {
  const header = req.headers.cookie ?? ''
  const token = header.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1)
  if (!token) return undefined
  const session = sessions.get(token)
  if (session === undefined) return undefined
  if (session.expiresAt < Date.now()) {
    sessions.delete(token)
    return undefined
  }
  return { token, ...session }
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · DeepSeek Harness</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #101014; color: #e8e8ec;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .card {
    width: 340px; background: #1a1a20; border: 1px solid #2e2e36;
    border-radius: 14px; padding: 32px 28px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
  }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .sub { color: #8a8a94; font-size: 12px; margin-bottom: 24px; }
  label { display: block; font-size: 12px; color: #a8a8b2; margin: 14px 0 6px; }
  input {
    width: 100%; background: #121218; color: #eee; border: 1px solid #33333e;
    border-radius: 8px; padding: 10px 12px; font-size: 14px; outline: none;
  }
  input:focus { border-color: #4a6cf7; }
  button {
    width: 100%; margin-top: 20px; background: #4a6cf7; color: #fff; border: none;
    border-radius: 8px; padding: 11px; font-size: 14px; cursor: pointer;
  }
  button:hover { background: #5b7bf8; }
  button.secondary { background: transparent; color: #8a8a94; border: 1px solid #33333e; margin-top: 10px; }
  button.secondary:hover { color: #d0d0d8; }
  .msg { margin-top: 14px; font-size: 12px; color: #f87171; min-height: 18px; }
  .msg.ok { color: #34d399; }
  a.switch { display: block; text-align: center; margin-top: 16px; font-size: 12px; color: #6a8aff; cursor: pointer; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <h1 id="title">登录</h1>
  <div class="sub" id="subtitle">DeepSeek Harness Web</div>
  <form id="form">
    <label for="username">账号</label>
    <input id="username" name="username" autocomplete="username" autofocus>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password">
    <div id="changeFields" style="display:none">
      <label for="new1">新密码</label>
      <input id="new1" type="password" autocomplete="new-password">
      <label for="new2">确认新密码</label>
      <input id="new2" type="password" autocomplete="new-password">
    </div>
    <div class="msg" id="msg"></div>
    <button type="submit" id="submit">登录</button>
  </form>
  <a class="switch" id="switch">修改密码</a>
</div>
<script>
let mode = 'login';
const title = document.getElementById('title');
const subtitle = document.getElementById('subtitle');
const msg = document.getElementById('msg');
const form = document.getElementById('form');
const password = document.getElementById('password');
const submit = document.getElementById('submit');
const sw = document.getElementById('switch');
const changeFields = document.getElementById('changeFields');

function show(text, ok) { msg.textContent = text; msg.className = 'msg' + (ok ? ' ok' : ''); }

function setMode(m) {
  mode = m;
  title.textContent = m === 'login' ? '登录' : '修改密码';
  subtitle.textContent = m === 'login' ? 'DeepSeek Harness Web' : '输入旧密码并设置新密码';
  submit.textContent = m === 'login' ? '登录' : '确认修改';
  sw.textContent = m === 'login' ? '修改密码' : '返回登录';
  password.placeholder = m === 'login' ? '请输入密码' : '请输入旧密码';
  changeFields.style.display = m === 'change' ? 'block' : 'none';
  msg.textContent = '';
}
sw.addEventListener('click', () => setMode(mode === 'login' ? 'change' : 'login'));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const oldPassword = password.value;
  const new1 = document.getElementById('new1').value;
  const new2 = document.getElementById('new2').value;
  submit.disabled = true;
  try {
    if (mode === 'login') {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: oldPassword }),
      });
      const data = await res.json();
      if (res.ok) { show('登录成功，正在进入…', true); location.href = '/'; }
      else show(data.error || '登录失败');
    } else {
      if (new1.length < 6) { show('新密码至少 6 位'); submit.disabled = false; return; }
      if (new1 !== new2) { show('两次输入的新密码不一致'); submit.disabled = false; return; }
      const res = await fetch('/api/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, oldPassword, newPassword: new1 }),
      });
      const data = await res.json();
      if (res.ok) { show('密码已修改，请重新登录', true); setTimeout(() => { setMode('login'); password.value = ''; }, 1200); }
      else show(data.error || '修改失败');
    }
  } catch { show('网络错误'); }
  submit.disabled = false;
});
</script>
</body>
</html>`

function serveLoginPage(res, status = 401) {
  const body = LOGIN_PAGE
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function handleAuthApi(req, res) {
  const url = (req.url ?? '').split('?')[0]
  if (url === '/api/login' && req.method === 'POST') {
    let body
    try { body = JSON.parse(await readBody(req)) } catch { return sendText(res, 400, '{"error":"无效请求"}') }
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    if (!users[username] || !verifyPassword(password, users[username])) {
      return sendText(res, 401, JSON.stringify({ error: '账号或密码错误' }))
    }
    const token = randomBytes(32).toString('hex')
    sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS })
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
    })
    return res.end(JSON.stringify({ ok: true }))
  }
  if (url === '/api/change-password' && req.method === 'POST') {
    const session = readSession(req)
    if (session === undefined) return sendText(res, 401, JSON.stringify({ error: '请先登录' }))
    let body
    try { body = JSON.parse(await readBody(req)) } catch { return sendText(res, 400, '{"error":"无效请求"}') }
    const username = String(body.username ?? '').trim()
    const oldPassword = String(body.oldPassword ?? '')
    const newPassword = String(body.newPassword ?? '')
    if (session.username !== username) return sendText(res, 403, JSON.stringify({ error: '只能修改当前登录账号的密码' }))
    if (!users[username] || !verifyPassword(oldPassword, users[username])) {
      return sendText(res, 401, JSON.stringify({ error: '旧密码错误' }))
    }
    if (newPassword.length < 6) return sendText(res, 400, JSON.stringify({ error: '新密码至少 6 位' }))
    users[username] = hashPassword(newPassword)
    try {
      await saveUsers()
    } catch (error) {
      return sendText(res, 500, JSON.stringify({ error: `保存失败：${error?.message ?? error}` }))
    }
    // Invalidate all sessions for this user.
    for (const [token, s] of sessions) {
      if (s.username === username) sessions.delete(token)
    }
    return sendText(res, 200, JSON.stringify({ ok: true }))
  }
  sendText(res, 404, '{"error":"not found"}')
}

function proxy(req, res) {
  const headers = { ...req.headers, connection: 'keep-alive' }
  const proxyReq = request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: req.url,
    method: req.method,
    headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  })
  proxyReq.on('error', (error) => {
    if (!res.headersSent) sendText(res, 502, `上游不可达：${error?.message ?? error}`)
    else res.destroy()
  })
  req.pipe(proxyReq)
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0]
  // Auth API always reachable (no session required for login).
  if (url.startsWith('/api/login') || url.startsWith('/api/change-password')) {
    return handleAuthApi(req, res)
  }
  const session = readSession(req)
  if (session === undefined) {
    // HTML navigation → show the login page; API/fetch → 401 JSON.
    const acceptsHtml = (req.headers.accept ?? '').includes('text/html')
    if (acceptsHtml) return serveLoginPage(res, 401)
    return sendText(res, 401, '{"error":"unauthorized"}')
  }
  proxy(req, res)
})

// WebSocket upgrade passthrough (DSH events streams), gated by the cookie.
server.on('upgrade', (req, socket, head) => {
  const session = readSession(req)
  if (session === undefined) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const upstream = connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`)
    for (const [key, value] of Object.entries(req.headers)) {
      if (key !== 'host' && value !== undefined) upstream.write(`${key}: ${value}\r\n`)
    }
    upstream.write(`Host: ${req.headers.host}\r\n\r\n`)
    if (head && head.length > 0) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })
  socket.on('error', () => {})
})

await loadUsers()
// Seed a default admin when the user store does not exist yet.
if (Object.keys(users).length === 0) {
  const username = process.env.DSH_ADMIN_USER || 'dshadmin'
  const password = process.env.DSH_ADMIN_PASSWORD || 'dsh-ac04e4e722bdf8390ebb8d25f1357fae'
  users[username] = hashPassword(password)
  try { await saveUsers() } catch (error) {
    console.error('无法写入用户文件:', error?.message ?? error)
    process.exit(1)
  }
  console.error(`[login-server] 已创建默认用户 ${username}（密码：${password}）——首次登录后请修改`)
}
server.listen(PORT, '127.0.0.1', () => {
  console.error(`[login-server] 监听 127.0.0.1:${PORT}，上游 ${UPSTREAM_HOST}:${UPSTREAM_PORT}`)
})
