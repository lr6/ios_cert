#!/usr/bin/env node
/**
 * 构建产物敏感信息检查（说明书 9.13）。
 *
 * 检查 dist/ 中是否意外打包了私钥、证书、P12 文件或测试用密码。
 * 用法：npm run build && npm run check:dist
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const DIST = 'dist'
/** 明确不允许出现在产物中的测试密码（tests/ 中的常量） */
const FORBIDDEN_LITERALS = [
  'Independent-Verify-2026!',
  'Backup-Pass-2026!',
  'Str0ng-Test-Passw0rd!',
  'correct horse battery staple'
]
/**
 * 真实 PEM 结构检查。
 * 注意：源码里本来就会出现 "-----BEGIN CERTIFICATE-----" 这样的字面量（解析用），
 * 因此要求 PEM 头后面紧跟足够长的 base64 主体，才算“真的打包了一份密钥/证书”。
 */
const FORBIDDEN_PATTERNS = [
  { name: 'PEM 私钥', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{80,}/ },
  { name: 'PEM 证书', regex: /-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=]{80,}/ }
]
const FORBIDDEN_FILES = [/\.p12$/i, /\.pfx$/i, /\.cer$/i, /\.mobileprovision$/i, /test-key/i, /test-cert/i, /\.pem$/i]

let files = []
try {
  files = walk(DIST)
} catch {
  console.error(`[check:dist] 未找到 ${DIST}/ 目录，请先执行 npm run build`)
  process.exit(1)
}

const problems = []
let totalBytes = 0

for (const file of files) {
  const size = statSync(file).size
  totalBytes += size
  const rel = relative(DIST, file)

  if (FORBIDDEN_FILES.some((pattern) => pattern.test(rel))) {
    problems.push(`${rel}: 文件名疑似敏感文件，不应出现在构建产物中`)
  }

  const content = readFileSync(file)
  for (const { name, regex } of FORBIDDEN_PATTERNS) {
    if (regex.test(content.toString('latin1'))) {
      problems.push(`${rel}: 命中「${name}」结构`)
    }
  }
  const text = content.toString('utf8')
  for (const literal of FORBIDDEN_LITERALS) {
    if (text.includes(literal)) {
      problems.push(`${rel}: 包含测试密码字面量（${literal.slice(0, 6)}…）`)
    }
  }
}

console.log(`[check:dist] 已检查 ${files.length} 个文件，合计 ${(totalBytes / 1024).toFixed(1)} KB`)
if (problems.length > 0) {
  console.error('[check:dist] 发现敏感内容：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('[check:dist] 未发现私钥、证书、P12 或测试密码等敏感内容')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}
