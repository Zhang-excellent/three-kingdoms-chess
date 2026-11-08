import { ref } from 'vue';
import type { AuthUser } from './auth.ts';

interface AuthApiSuccess {
  ok: true;
  user: AuthUser | null;
  recoveryCode?: string;
}

interface AuthApiFailure {
  ok: false;
  code: string;
  error: string;
}

type AuthApiResult = AuthApiSuccess | AuthApiFailure;
type AuthActionResult = { ok: true; user: AuthUser; recoveryCode?: string } | AuthApiFailure;

async function request(path: string, body?: Record<string, unknown>): Promise<AuthApiResult> {
  try {
    const response = await fetch(`/three-chess/api/auth/${path}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json() as AuthApiResult;
    if (!response.ok && result.ok) return { ok: false, code: 'INVALID_RESPONSE', error: '账号服务返回了无效响应。' };
    return result;
  } catch {
    return { ok: false, code: 'NETWORK_ERROR', error: '暂时无法连接账号服务，请稍后重试。' };
  }
}

export function useAuth() {
  const user = ref<AuthUser | null>(null);
  const ready = ref(false);
  const busy = ref(false);
  const error = ref('');

  async function refresh(): Promise<void> {
    const result = await request('me');
    if (result.ok) user.value = result.user;
    else error.value = result.error;
    ready.value = true;
  }

  async function run(action: () => Promise<AuthApiResult>): Promise<AuthActionResult> {
    if (busy.value) return { ok: false, code: 'BUSY', error: '正在处理上一项账号操作，请稍候。' };
    busy.value = true; error.value = '';
    try {
      const result = await action();
      if (!result.ok || !result.user) {
        const failure = result.ok ? { ok: false as const, code: 'INVALID_RESPONSE', error: '账号服务没有返回用户信息。' } : result;
        error.value = failure.error;
        return failure;
      }
      user.value = result.user;
      return { ok: true, user: result.user, recoveryCode: result.recoveryCode };
    } finally {
      busy.value = false;
    }
  }

  const login = (username: string, password: string, remember: boolean) =>
    run(() => request('login', { username, password, remember }));
  const register = (username: string, password: string, remember: boolean) =>
    run(() => request('register', { username, password, remember }));
  const changePassword = (currentPassword: string, newPassword: string, remember: boolean) =>
    run(() => request('password', { currentPassword, newPassword, remember }));
  const regenerateRecovery = (password: string) =>
    run(() => request('recovery/regenerate', { password }));
  const resetWithRecovery = (username: string, recoveryCode: string, newPassword: string, remember: boolean) =>
    run(() => request('recovery/reset', { username, recoveryCode, newPassword, remember }));

  async function logout(): Promise<AuthActionResult> {
    if (busy.value) return { ok: false, code: 'BUSY', error: '正在处理上一项账号操作，请稍候。' };
    busy.value = true; error.value = '';
    try {
      const result = await request('logout', {});
      if (!result.ok) { error.value = result.error; return result; }
      user.value = null;
      return { ok: true, user: { id: '', username: '' } };
    } finally {
      busy.value = false;
    }
  }

  function clearError(): void {
    error.value = '';
  }

  function setError(value: string): void {
    error.value = value;
  }

  return { user, ready, busy, error, refresh, login, register, changePassword, regenerateRecovery,
    resetWithRecovery, logout, clearError, setError };
}
