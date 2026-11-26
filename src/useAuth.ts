import { ref } from 'vue';
import type { AuthUser } from './auth.ts';
import type { ArchivedGameRecord, RecentGameSummary } from './game-history.ts';
import type { ArchivedMistGameRecord, RecentMistGameSummary } from './mist-game-history.ts';
import type { ArchivedChineseGameRecord, RecentChineseGameSummary } from './chinese-game-history.ts';
import { apiRequestCredentials, apiUrl } from './network-config.ts';

interface ApiFailure {
  ok: false;
  code: string;
  error: string;
}

type ApiResult<T> = ({ ok: true } & T) | ApiFailure;
type UserResult = ApiResult<{ user: AuthUser }>;

async function request<T>(path: string, body?: Record<string, unknown>): Promise<ApiResult<T>> {
  try {
    const response = await fetch(apiUrl(path), {
      method: body ? 'POST' : 'GET',
      credentials: apiRequestCredentials(),
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json() as ApiResult<T>;
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
  const recentGames = ref<RecentGameSummary[]>([]);
  const recentLoading = ref(false);
  const recentError = ref('');
  const mistRecentGames = ref<RecentMistGameSummary[]>([]);
  const mistRecentLoading = ref(false);
  const mistRecentError = ref('');
  const chineseRecentGames = ref<RecentChineseGameSummary[]>([]);
  const chineseRecentLoading = ref(false);
  const chineseRecentError = ref('');

  async function refresh(): Promise<void> {
    const result = await request<{ user: AuthUser | null }>('auth/me');
    if (result.ok) user.value = result.user;
    else error.value = result.error;
    ready.value = true;
    if (user.value) await Promise.all([loadRecent(), loadMistRecent(), loadChineseRecent()]);
  }

  async function run(action: () => Promise<UserResult>): Promise<UserResult> {
    if (busy.value) return { ok: false, code: 'BUSY', error: '正在处理上一项账号操作，请稍候。' };
    busy.value = true; error.value = '';
    try {
      const result = await action();
      if (!result.ok) error.value = result.error;
      else {
        user.value = result.user;
        await Promise.all([loadRecent(), loadMistRecent(), loadChineseRecent()]);
      }
      return result;
    } finally {
      busy.value = false;
    }
  }

  const login = (username: string, password: string, remember: boolean) =>
    run(() => request<{ user: AuthUser }>('auth/login', { username, password, remember }));
  const register = (username: string, password: string, remember: boolean) =>
    run(() => request<{ user: AuthUser }>('auth/register', { username, password, remember }));
  const changePassword = (currentPassword: string, newPassword: string, remember: boolean) =>
    run(() => request<{ user: AuthUser }>('auth/password', { currentPassword, newPassword, remember }));
  const uploadAvatar = (avatarData: string | null) =>
    run(() => request<{ user: AuthUser }>('auth/avatar', { avatarData }));

  async function loadRecent(): Promise<void> {
    if (!user.value) {
      recentGames.value = [];
      recentError.value = '';
      return;
    }
    recentLoading.value = true; recentError.value = '';
    try {
      const result = await request<{ games: RecentGameSummary[] }>('games/recent');
      if (result.ok) recentGames.value = result.games.slice(0, 5);
      else recentError.value = result.error;
    } finally {
      recentLoading.value = false;
    }
  }

  async function loadGame(gameId: string): Promise<ApiResult<{ game: ArchivedGameRecord }>> {
    return request<{ game: ArchivedGameRecord }>(`games/${encodeURIComponent(gameId)}`);
  }

  async function loadMistRecent(): Promise<void> {
    if (!user.value) {
      mistRecentGames.value = [];
      mistRecentError.value = '';
      return;
    }
    mistRecentLoading.value = true;
    mistRecentError.value = '';
    try {
      const result = await request<{ games: RecentMistGameSummary[] }>('games/mist/recent');
      if (result.ok) mistRecentGames.value = result.games.slice(0, 5);
      else mistRecentError.value = result.error;
    } finally {
      mistRecentLoading.value = false;
    }
  }

  async function loadMistGame(gameId: string): Promise<ApiResult<{ game: ArchivedMistGameRecord }>> {
    return request<{ game: ArchivedMistGameRecord }>(`games/mist/${encodeURIComponent(gameId)}`);
  }

  async function loadChineseRecent(): Promise<void> {
    if (!user.value) {
      chineseRecentGames.value = [];
      chineseRecentError.value = '';
      return;
    }
    chineseRecentLoading.value = true;
    chineseRecentError.value = '';
    try {
      const result = await request<{ games: RecentChineseGameSummary[] }>('games/chinese/recent');
      if (result.ok) chineseRecentGames.value = result.games.slice(0, 5);
      else chineseRecentError.value = result.error;
    } finally {
      chineseRecentLoading.value = false;
    }
  }

  async function loadChineseGame(gameId: string): Promise<ApiResult<{ game: ArchivedChineseGameRecord }>> {
    return request<{ game: ArchivedChineseGameRecord }>(`games/chinese/${encodeURIComponent(gameId)}`);
  }

  async function logout(): Promise<ApiResult<Record<string, never>>> {
    if (busy.value) return { ok: false, code: 'BUSY', error: '正在处理上一项账号操作，请稍候。' };
    busy.value = true; error.value = '';
    try {
      const result = await request<Record<string, never>>('auth/logout', {});
      if (!result.ok) { error.value = result.error; return result; }
      user.value = null;
      recentGames.value = [];
      recentError.value = '';
      mistRecentGames.value = [];
      mistRecentError.value = '';
      chineseRecentGames.value = [];
      chineseRecentError.value = '';
      return result;
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

  return {
    user, ready, busy, error, recentGames, recentLoading, recentError,
    mistRecentGames, mistRecentLoading, mistRecentError,
    chineseRecentGames, chineseRecentLoading, chineseRecentError,
    refresh, login, register, changePassword, uploadAvatar, loadRecent, loadMistRecent,
    loadChineseRecent, loadGame, loadMistGame, loadChineseGame, logout, clearError, setError,
  };
}
