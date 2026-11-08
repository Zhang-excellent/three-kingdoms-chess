export interface AuthUser {
  id: string;
  username: string;
}

export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 16;
export const PASSWORD_MIN_LENGTH = 4;
export const PASSWORD_MAX_LENGTH = 64;
export const SHORT_SESSION_SECONDS = 12 * 60 * 60;
export const REMEMBER_SESSION_SECONDS = 7 * 24 * 60 * 60;

export function normalizeUsername(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

export function usernameKey(value: unknown): string {
  return normalizeUsername(value).toLowerCase();
}

export function usernameError(value: unknown): string | null {
  const username = normalizeUsername(value);
  const length = Array.from(username).length;
  if (length < USERNAME_MIN_LENGTH || length > USERNAME_MAX_LENGTH)
    return `用户名需要 ${USERNAME_MIN_LENGTH}～${USERNAME_MAX_LENGTH} 个字符。`;
  if (!/^[\p{Script=Han}A-Za-z0-9_]+$/u.test(username))
    return '用户名只能包含中文、英文字母、数字和下划线。';
  return null;
}

export function passwordError(value: unknown): string | null {
  if (typeof value !== 'string') return '请输入密码。';
  const length = Array.from(value).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH)
    return `密码需要 ${PASSWORD_MIN_LENGTH}～${PASSWORD_MAX_LENGTH} 个字符。`;
  return null;
}

export function recoveryCodeKey(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

export function recoveryCodeError(value: unknown): string | null {
  return recoveryCodeKey(value).length >= 20 ? null : '请输入完整恢复码。';
}
