export type AppPage = 'home' | 'lobby' | 'friends' | 'local' | 'room' | 'spectate';

export interface AppRoute {
  page: AppPage;
  roomCode: string | null;
}

export function parseAppRoute(value: string | URL): AppRoute {
  const url = typeof value === 'string' ? new URL(value) : value;
  const roomCode = url.searchParams.get('room')?.trim().toUpperCase() || null;
  const mode = url.searchParams.get('mode');
  if (mode === 'spectate') return { page: 'spectate', roomCode };
  if (mode === 'local') return { page: 'local', roomCode: null };
  if (mode === 'lobby') return { page: 'lobby', roomCode: null };
  if (roomCode) return { page: 'room', roomCode };
  if (mode === 'online') return { page: 'friends', roomCode: null };
  return { page: 'home', roomCode: null };
}

export function appRouteUrl(value: string | URL, page: AppPage, roomCode?: string | null): string {
  const url = new URL(typeof value === 'string' ? value : value.href);
  url.search = '';
  url.hash = '';
  if (page === 'local') url.searchParams.set('mode', 'local');
  if (page === 'lobby') url.searchParams.set('mode', 'lobby');
  if (page === 'friends') url.searchParams.set('mode', 'online');
  if (page === 'room') {
    url.searchParams.set('mode', 'online');
    if (roomCode) url.searchParams.set('room', roomCode);
  }
  if (page === 'spectate') {
    url.searchParams.set('mode', 'spectate');
    if (roomCode) url.searchParams.set('room', roomCode);
  }
  return url.href;
}
