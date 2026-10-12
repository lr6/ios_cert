#!/usr/bin/env node
/**
 * 本地静态服务器：用于在“接近 Cloudflare Pages 的环境”下验证构建产物。
 * - 读取 public/_headers 中的 CSP 等安全响应头并实际下发；
 * - 实现 SPA 回退（未命中的路径返回 index.html），
 *   等价于 Workers 静态资源的 not_found_handling = "single-page-application"。
 *
 * 用法：npm run build && node scripts/serve-dist.mjs [port]
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const DIST = 'dist'
const port = Number(process.argv[2] ?? 4174)

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('[serve-dist] 未找到 dist/index.html，请先执行 npm run build')
  process.exit(1)
}

const headers = parseHeaders(readFileSync('public/_headers', 'utf8'))
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  const safePath = normalize(urlPath).replace(/^([/\\])+/, '')
  let filePath = join(DIST, safePath)

  if (!safePath || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA 回退：交给前端路由处理（等价于 Workers 静态资源的 not_found_handling）
    filePath = join(DIST, 'index.html')
  }

  const body = readFileSync(filePath)
  const applyHeaders = { ...headers.global, ...(headers.byPath[urlPath] ?? {}) }
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream', ...applyHeaders })
  res.end(body)
}).listen(port, () => {
  console.log(`[serve-dist] http://localhost:${port}/ （已应用 _headers 中的安全响应头）`)
})

function parseHeaders(text) {
  const global = {}
  const byPath = {}
  let current = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      current = null
      continue
    }
    if (!/^\s/.test(line)) {
      current = line.trim()
      if (current !== '/*') byPath[current] = byPath[current] ?? {}
      continue
    }
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!current || current === '/*') global[key] = value
    else byPath[current][key] = value
  }
  return { global, byPath }
}
