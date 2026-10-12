/** 统一把未知异常转成可展示给用户的真实错误信息（不使用“操作失败”这类笼统文案） */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '发生未知错误，请重试'
}
