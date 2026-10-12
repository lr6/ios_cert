/**
 * OpenSSL 独立校验辅助工具。
 *
 * 为什么需要它：CSR / PKCS#12 如果只用生成它们的同一个库去校验，等于自己验自己。
 * 这里直接调用外部 OpenSSL 二进制做交叉验证。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const CANDIDATES = [
  process.env.OPENSSL_BIN,
  'openssl',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
  '/usr/bin/openssl',
  '/usr/local/bin/openssl'
].filter((candidate): candidate is string => Boolean(candidate))

export function resolveOpenSsl(): string | null {
  for (const candidate of CANDIDATES) {
    try {
      if (candidate.includes('\\') || candidate.includes('/')) {
        if (!existsSync(candidate)) continue
      }
      const version = execFileSync(candidate, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (/OpenSSL/i.test(version)) return candidate
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null
}

export interface OpenSslResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** 执行 openssl 命令；失败不抛错，返回 ok=false */
export function runOpenSsl(binary: string, args: string[], options: { input?: string } = {}): OpenSslResult {
  try {
    const stdout = execFileSync(binary, args, {
      encoding: 'utf8',
      input: options.input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' }
    })
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    const err = error as { stdout?: string | Buffer; stderr?: string | Buffer }
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(error)
    }
  }
}

export function opensslVersion(binary: string): string {
  return runOpenSsl(binary, ['version']).stdout.trim()
}
