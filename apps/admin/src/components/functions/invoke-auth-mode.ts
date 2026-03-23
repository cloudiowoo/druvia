export type InvokeAuthMode = 'jwt_required' | 'anon_allowed'

export const INVOKE_AUTH_MODE_OPTIONS: Array<{ value: InvokeAuthMode; label: string }> = [
  { value: 'jwt_required', label: 'JWT Required' },
  { value: 'anon_allowed', label: 'Anonymous Allowed' },
]

export function getInvokeAuthModeLabel(mode: InvokeAuthMode): string {
  return INVOKE_AUTH_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? 'JWT Required'
}

export function getInvokeAuthModeBadgeMeta(mode: InvokeAuthMode): { label: string; className: string } {
  if (mode === 'anon_allowed') {
    return {
      label: 'ANON',
      className: 'bg-amber-50 text-amber-700 border-amber-200',
    }
  }

  return {
    label: 'JWT',
    className: 'bg-gray-100 text-gray-600 border-gray-200',
  }
}

export function getInvokeAuthModeWarning(mode: InvokeAuthMode): string | null {
  if (mode !== 'anon_allowed') {
    return null
  }

  return '仅对登录前函数开放匿名调用，例如 wx-silent-login、wx-login-register。上传、用户态和后台函数应保持 JWT Required。'
}
