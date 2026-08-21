// Standalone file-upload server plugin: upload arbitrary files (Word/PDF/…)
// to the server so the agent can process them. Works WITHOUT Ollama or any
// vision model — deploy this alone when you only need file upload.
//
// Endpoint: POST /vision/upload
//   body: { name: string, data: string /* base64 */, dir?: string }
//   response: { path: string }  // absolute path on the server
//   dir = the session workspace; the file lands there so the agent can open
//   it with its file tools and a copy stays with the project.
//
// Deploy by inserting into the web profile's cordis.patch.yml:
//   - id: upload-server
//     name: ./upload-server.mjs
//
// (The browser plugin's 📎 button posts here; the path rides along with the
// next message as text, and the agent opens it with its file tools.)
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'upload-server'
export const inject = ['webServer']

/** DSH user home (~/.dsh on macOS/Linux, %USERPROFILE%\.dsh on Windows). */
function dshHomePath(...segments) {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), ...segments)
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

export function apply(_ctx, config) {
  const maxBytes = config?.maxBytes ?? 50 * 1024 * 1024

  // name -> absolute path, so GET /vision/file/<name> can serve downloads.
  // In-memory: links in old messages degrade to plain text after a restart.
  const uploaded = new Map()

  _ctx.webServer.register({
    kind: 'prefix',
    path: '/vision',
    handler: async (req, res) => {
      const respond = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      const url = (req.url ?? '').split('?')[0]

      // GET /vision/file/<name> — download an uploaded file (chat links).
      if (url.startsWith('/vision/file/') && req.method === 'GET') {
        const name = decodeURIComponent(url.slice('/vision/file/'.length))
        const path = uploaded.get(name)
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
        } catch (error) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('file read failed')
        }
        return
      }

      if (url !== '/vision/upload' || req.method !== 'POST') {
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
      if (typeof parsed?.data !== 'string' || parsed.data.length === 0) {
        respond(400, { error: 'data required' })
        return
      }
      const decoded = Buffer.from(parsed.data, 'base64')
      if (decoded.byteLength > maxBytes) {
        respond(413, { error: `file exceeds ${maxBytes} bytes` })
        return
      }
      const name = typeof parsed.name === 'string' && parsed.name.length > 0
        ? parsed.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
        : `upload-${Date.now()}`
      try {
        // Prefer the caller's workspace dir so the file lands inside the
        // session working directory (a project-local copy the agent can read).
        let target
        if (typeof parsed.dir === 'string' && parsed.dir.length > 0) {
          const stat = await import('node:fs/promises').then(fs => fs.stat(parsed.dir)).catch(() => undefined)
          if (stat !== undefined && stat.isDirectory()) {
            target = join(parsed.dir, name)
          }
        }
        if (target === undefined) {
          const uploadsDir = dshHomePath('vision-uploads')
          await mkdir(uploadsDir, { recursive: true })
          target = join(uploadsDir, name)
        }
        await writeFile(target, decoded)
        uploaded.set(name, target)
        respond(200, { path: target })
      } catch (error) {
        respond(500, { error: error?.message ?? String(error) })
      }
    },
  })
}
