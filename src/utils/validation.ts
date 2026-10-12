/**
 * 输入校验。校验函数返回错误信息字符串或 null（null 表示通过），便于界面直接展示真实原因。
 */

export const MAX_CERTIFICATE_NAME_LENGTH = 128
export const MIN_P12_PASSWORD_LENGTH = 8
export const MIN_BACKUP_PASSWORD_LENGTH = 10
/** CER 文件大小上限（正常 Apple 证书约 1~2KB） */
export const MAX_CER_BYTES = 256 * 1024
/** 备份文件大小上限 */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024

export function validateCertificateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return '证书名称不能为空'
  if (trimmed.length > MAX_CERTIFICATE_NAME_LENGTH) {
    return `证书名称过长（最多 ${MAX_CERTIFICATE_NAME_LENGTH} 个字符）`
  }
  // 控制字符不允许出现在名称中（会被写入 CSR subject）
  // eslint-disable-next-line no-control-regex -- 目的就是拒绝控制字符
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return '证书名称不能包含控制字符'
  }
  return null
}

export function validateP12Password(password: string): string | null {
  if (!password) return '请设置 P12 导出密码'
  if (password.length < MIN_P12_PASSWORD_LENGTH) {
    return `P12 密码至少 ${MIN_P12_PASSWORD_LENGTH} 位`
  }
  if (/^\s+$/.test(password)) return 'P12 密码不能全为空白字符'
  return null
}

export function validateBackupPassword(password: string): string | null {
  if (!password) return '请设置备份密码'
  if (password.length < MIN_BACKUP_PASSWORD_LENGTH) {
    return `备份密码至少 ${MIN_BACKUP_PASSWORD_LENGTH} 位`
  }
  if (/^\s+$/.test(password)) return '备份密码不能全为空白字符'
  return null
}

export function validatePasswordConfirmation(password: string, confirmation: string): string | null {
  if (password !== confirmation) return '两次输入的密码不一致'
  return null
}

export function validateCerFileSize(byteLength: number): string | null {
  if (byteLength === 0) return '所选文件内容为空'
  if (byteLength > MAX_CER_BYTES) {
    return `文件过大（${formatBytes(byteLength)}），已超过 ${formatBytes(MAX_CER_BYTES)} 上限`
  }
  return null
}

export function validateBackupFileSize(byteLength: number): string | null {
  if (byteLength === 0) return '备份文件内容为空'
  if (byteLength > MAX_BACKUP_BYTES) {
    return `备份文件过大（${formatBytes(byteLength)}），已超过 ${formatBytes(MAX_BACKUP_BYTES)} 上限`
  }
  return null
}

/** 生成安全的下载文件名，去除路径分隔符与保留字符 */
export function sanitizeFileName(name: string, fallback = 'certificate'): string {
  const cleaned = name
    .trim()
    // eslint-disable-next-line no-control-regex -- 需要过滤文件名中的控制字符
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  return cleaned || fallback
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
