import { computed, onBeforeUnmount, ref } from 'vue';
import { io, type Socket } from 'socket.io-client';
import { ONLINE_SESSION_KEY, PENDING_LEAVES_KEY, createMoveRequestId } from './online.ts';
import type { ClientAck, MoveIntent, RoomView, SessionReceipt } from './online.ts';
import type { Faction, Point } from './game.ts';

interface SavedSession { roomCode: string; reconnectToken: string; playerId?: string; nickname: string }
interface PendingLeave { roomCode: string; reconnectToken: string }
const REPLACED_SESSION_KEY = 'three-kingdoms-chess:replaced-session-v1';

function readStored<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) || 'null') as T | null; } catch { return null; }
}
function loadSession(): SavedSession | null {
  const value = readStored<Partial<SavedSession>>(ONLINE_SESSION_KEY);
  return value && typeof value.roomCode === 'string' && typeof value.reconnectToken === 'string' && typeof value.nickname === 'string'
    && sessionStorage.getItem(REPLACED_SESSION_KEY) !== value.reconnectToken
    ? value as SavedSession : null;
}
function loadPending(): PendingLeave[] {
  const value = readStored<PendingLeave[]>(PENDING_LEAVES_KEY);
  return Array.isArray(value) ? value.filter(item => typeof item?.roomCode === 'string' && typeof item?.reconnectToken === 'string') : [];
}

export function useOnlineRoom() {
  const params = new URLSearchParams(location.search);
  const initialSession = loadSession();
  const initialSpectating = !initialSession && params.get('mode') === 'spectate';
  const mode = ref<'local' | 'online'>(params.get('mode') === 'online' || params.has('room') || initialSpectating ? 'online' : 'local');
  const spectating = ref(initialSpectating);
  const watchCode = ref(initialSpectating ? (params.get('room') ?? '').toUpperCase() : '');
  const watchingCode = ref(initialSpectating ? watchCode.value : '');
  const nickname = ref(initialSession?.nickname ?? '');
  const createCode = ref('');
  const joinCode = ref((params.get('room') ?? '').toUpperCase());
  const room = ref<RoomView | null>(null);
  const session = ref<SavedSession | null>(initialSession);
  const connection = ref<'offline' | 'connecting' | 'online' | 'replaced'>('offline');
  const error = ref('');
  const exitNotice = ref('');
  const busy = ref(false);
  let socket: Socket | null = null;
  let epoch = 0;
  let recovery: Promise<void> = Promise.resolve();
  let flushing: Promise<void> | null = null;

  const self = computed(() => room.value?.players.find(player => player.id === room.value?.selfId) ?? null);
  const faction = computed(() => self.value?.faction ?? null);
  const inRoom = computed(() => !!room.value && !!session.value);

  function setAddress(code: string | null) {
    const url = new URL(location.href);
    if (code) { url.searchParams.set('mode', spectating.value ? 'spectate' : 'online'); url.searchParams.set('room', code); }
    else url.searchParams.delete('room');
    history.replaceState(history.state, '', url);
  }
  function pending(): PendingLeave[] { return loadPending(); }
  function queueLeave(value: PendingLeave) {
    const list = pending();
    if (!list.some(item => item.reconnectToken === value.reconnectToken)) list.push(value);
    localStorage.setItem(PENDING_LEAVES_KEY, JSON.stringify(list));
  }
  function removePending(token: string) {
    const list = pending().filter(item => item.reconnectToken !== token);
    if (list.length) localStorage.setItem(PENDING_LEAVES_KEY, JSON.stringify(list));
    else localStorage.removeItem(PENDING_LEAVES_KEY);
  }
  function validReceipt(value: SessionReceipt): boolean {
    return !!value && value.roomCode === value.state?.code && value.playerId === value.state?.selfId
      && typeof value.reconnectToken === 'string';
  }
  function save(receipt: SessionReceipt) {
    if (!validReceipt(receipt)) { error.value = '服务器房间号不一致，请重新同步。'; return false; }
    session.value = { roomCode: receipt.roomCode, reconnectToken: receipt.reconnectToken,
      playerId: receipt.playerId, nickname: nickname.value.trim() || initialSession?.nickname || '' };
    sessionStorage.removeItem(REPLACED_SESSION_KEY);
    localStorage.setItem(ONLINE_SESSION_KEY, JSON.stringify(session.value));
    room.value = receipt.state;
    joinCode.value = receipt.roomCode;
    setAddress(receipt.roomCode);
    error.value = '';
    exitNotice.value = '';
    return true;
  }
  function acceptState(state: RoomView, expected: SavedSession | null = session.value) {
    if (spectating.value) {
      if (state.code !== watchingCode.value || state.selfId !== null) return;
      if (room.value?.code === state.code && state.version < room.value.version) return;
      room.value = state;
      return;
    }
    if (!expected || state.code !== expected.roomCode || (expected.playerId && state.selfId !== expected.playerId)) return;
    if (room.value?.code === state.code && state.version < room.value.version) return;
    room.value = state;
  }
  function applyAck<T>(ack: ClientAck<T>, expected: SavedSession | null, generation: number): boolean {
    if (generation !== epoch || expected?.reconnectToken !== session.value?.reconnectToken) return false;
    if (ack.ok) { error.value = ''; return true; }
    error.value = ack.error;
    if (ack.state) acceptState(ack.state, expected);
    return false;
  }
  function emit<T>(event: string, payload: unknown): Promise<ClientAck<T>> {
    return new Promise(resolve => {
      if (!socket?.connected) { resolve({ ok: false, code: 'OFFLINE', error: '尚未连接服务器，请稍后重试。' }); return; }
      socket.timeout(6000).emit(event, payload, (timeout: Error | null, ack: ClientAck<T>) =>
        resolve(timeout ? { ok: false, code: 'TIMEOUT', error: '服务器响应超时，请重新同步后再试。' } : ack));
    });
  }
  async function flushPendingLeaves() {
    if (flushing) return flushing;
    flushing = (async () => {
      const attempted = new Set<string>();
      while (true) {
        const item = pending().find(value => !attempted.has(value.reconnectToken));
        if (!item) break;
        attempted.add(item.reconnectToken);
        if (!socket?.connected) break;
        let ack = await emit('room:leave', item);
        if (!ack.ok && ack.code === 'NOT_ACTIVE_CONNECTION') {
          const resumeAck = await emit<SessionReceipt>('room:resume', item);
          if (resumeAck.ok) ack = await emit('room:leave', item);
          else if (resumeAck.code === 'SESSION_NOT_FOUND') ack = { ok: true, data: undefined };
        }
        if (ack.ok || ack.code === 'SESSION_NOT_FOUND') {
          removePending(item.reconnectToken);
          exitNotice.value = '';
        }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }
  async function resume(generation: number) {
    if (spectating.value) {
      if (watchingCode.value) await watch(watchingCode.value, generation, true);
      return;
    }
    const saved = session.value;
    if (!saved) return;
    const ack = await emit<SessionReceipt>('room:resume', saved);
    if (generation !== epoch || session.value?.reconnectToken !== saved.reconnectToken) return;
    if (ack.ok) save(ack.data);
    else if (ack.code === 'SESSION_NOT_FOUND') {
      localStorage.removeItem(ONLINE_SESSION_KEY);
      session.value = null; room.value = null; setAddress(null);
      error.value = '原房间已失效，请重新创建或加入房间。';
    } else error.value = ack.error;
  }
  function openSocket() {
    if (socket) { if (!socket.connected) socket.connect(); return; }
    connection.value = 'connecting';
    socket = io({ path: '/three-chess/socket.io', autoConnect: false, reconnection: true });
    socket.on('connect', () => {
      connection.value = 'online';
      const generation = epoch;
      recovery = (async () => { await flushPendingLeaves(); if (generation === epoch) await resume(generation); })();
    });
    socket.on('disconnect', reason => {
      if (connection.value !== 'replaced') connection.value = 'offline';
      if (reason !== 'io client disconnect' && session.value) error.value = '连接已中断，正在自动重连；等待区座位暂留 60 秒。';
    });
    socket.on('room:state', (state: RoomView) => acceptState(state));
    socket.on('room:closed', (code: string) => {
      if (!spectating.value || watchingCode.value !== code) return;
      epoch++; watchingCode.value = ''; room.value = null; setAddress(null);
      error.value = '房间已销毁，请返回大厅或输入其他房间号。';
    });
    socket.on('session:replaced', () => {
      if (!session.value) return;
      epoch++; connection.value = 'replaced'; error.value = '这个席位已在另一设备恢复，本页面已停止联机。';
      if (session.value) sessionStorage.setItem(REPLACED_SESSION_KEY, session.value.reconnectToken);
      session.value = null; room.value = null; setAddress(null);
      socket?.disconnect();
    });
    socket.connect();
  }
  function connect() { if (spectating.value) { stopWatching(); spectating.value = false; } mode.value = 'online'; openSocket(); }
  async function ensureConnected(): Promise<boolean> {
    openSocket();
    if (!socket?.connected) {
      const connected = await new Promise<boolean>(resolve => {
        const timer = window.setTimeout(() => resolve(false), 6000);
        socket?.once('connect', () => { window.clearTimeout(timer); resolve(true); });
        socket?.once('connect_error', () => { window.clearTimeout(timer); resolve(false); });
      });
      if (!connected) return false;
    }
    await recovery;
    return !!socket?.connected;
  }
  function leaveRoom() {
    const saved = session.value;
    epoch++; room.value = null; session.value = null; busy.value = false;
    joinCode.value = '';
    localStorage.removeItem(ONLINE_SESSION_KEY); setAddress(null);
    exitNotice.value = saved ? '已返回大厅，正在完成退出。' : '';
    error.value = '';
    if (saved) { queueLeave(saved); if (socket?.connected) void flushPendingLeaves(); else openSocket(); }
  }
  function openWatchEntry() {
    if (session.value) { error.value = '请先退出玩家房间，再进入观战。'; return; }
    if (spectating.value) stopWatching();
    epoch++; spectating.value = true; mode.value = 'online'; room.value = null;
    watchingCode.value = ''; watchCode.value = ''; error.value = '';
    const url = new URL(location.href); url.searchParams.set('mode', 'spectate'); url.searchParams.delete('room');
    history.replaceState(history.state, '', url);
    openSocket();
  }
  async function watch(codeValue: string, generation = epoch, connected = false): Promise<ClientAck<{ state: RoomView }>> {
    const code = codeValue.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return { ok: false, code: 'INVALID_ROOM_CODE', error: '请输入 6 位房间号。' };
    if (!connected && !await ensureConnected()) return { ok: false, code: 'OFFLINE', error: '无法连接联机服务器，请稍后重试。' };
    if (!connected && flushing) await flushing;
    const ack = await emit<{ state: RoomView }>('room:watch', { roomCode: code });
    if (generation !== epoch || !spectating.value) {
      if (ack.ok && watchingCode.value !== ack.data.state.code)
        void emit('room:unwatch', { roomCode: ack.data.state.code });
      return ack;
    }
    if (ack.ok) {
      watchingCode.value = ack.data.state.code; watchCode.value = ack.data.state.code;
      room.value = ack.data.state; setAddress(watchingCode.value); error.value = '';
    } else {
      watchingCode.value = ''; room.value = null; setAddress(null); error.value = ack.error;
    }
    return ack;
  }
  async function startWatching() {
    if (busy.value) return;
    busy.value = true; const generation = ++epoch;
    try {
      const result = await watch(watchCode.value, generation);
      if (generation === epoch && !result.ok) error.value = result.error;
    }
    finally { if (generation === epoch) busy.value = false; }
  }
  function stopWatching() {
    epoch++; const code = watchingCode.value;
    watchingCode.value = ''; room.value = null; watchCode.value = '';
    setAddress(null); error.value = '';
    if (code && socket?.connected) void emit('room:unwatch', { roomCode: code });
  }
  function exitWatching() {
    stopWatching(); spectating.value = false; mode.value = 'online'; joinCode.value = '';
    const url = new URL(location.href); url.searchParams.set('mode', 'online');
    history.replaceState(history.state, '', url);
  }
  function useLocal() {
    if (session.value) leaveRoom();
    if (spectating.value) { stopWatching(); spectating.value = false; }
    mode.value = 'local';
    const url = new URL(location.href); url.searchParams.delete('mode'); url.searchParams.delete('room');
    history.replaceState(history.state, '', url);
  }

  async function enter(event: 'room:create' | 'room:join') {
    if (busy.value) return;
    if (!nickname.value.trim()) { error.value = '请先输入昵称。'; return; }
    const code = event === 'room:create' ? createCode.value.trim() : joinCode.value.trim().toUpperCase();
    if (event === 'room:create' && !/^[0-9]{6}$/.test(code)) { error.value = '请输入 6 位数字房间号。'; return; }
    if (event === 'room:join' && !/^[A-Z0-9]{6}$/.test(code)) { error.value = '请输入 6 位房间号。'; return; }
    if (session.value) { error.value = '请先退出当前房间。'; return; }
    if (spectating.value) { error.value = '请先退出观战。'; return; }
    busy.value = true;
    const generation = epoch;
    try {
      if (!await ensureConnected()) { error.value = '无法连接联机服务器，请稍后重试。'; return; }
      if (flushing) await flushing;
      if (pending().length) { error.value = '旧房间退出尚未得到服务器确认，请稍后重试。'; return; }
      if (generation !== epoch || session.value) return;
      const ack = await emit<SessionReceipt>(event, { nickname: nickname.value.trim(), roomCode: code });
      if (generation !== epoch) {
        if (ack.ok && validReceipt(ack.data)) { queueLeave(ack.data); void flushPendingLeaves(); }
        return;
      }
      if (ack.ok) save(ack.data); else error.value = ack.error;
    } finally { if (generation === epoch) busy.value = false; }
  }
  const createRoom = () => enter('room:create');
  const joinRoom = () => enter('room:join');

  async function action<T>(event: string, extra: Record<string, unknown> = {}): Promise<ClientAck<T>> {
    const saved = session.value, generation = epoch;
    if (!saved) return { ok: false, code: 'NO_ROOM', error: '尚未进入房间。' };
    const ack = await emit<T>(event, { roomCode: saved.roomCode, reconnectToken: saved.reconnectToken, ...extra });
    if (applyAck(ack, saved, generation) && 'data' in ack && (ack.data as { state?: RoomView })?.state)
      acceptState((ack.data as { state: RoomView }).state, saved);
    return ack;
  }
  const chooseFaction = (value: Faction) => action<{ state: RoomView }>('room:choose-faction', { faction: value, round: room.value?.round });
  const setReady = (ready: boolean) => action<{ state: RoomView }>('room:ready', { ready, round: room.value?.round });
  const rematch = () => action<{ state: RoomView }>('room:rematch', { version: room.value?.version });
  const releaseOffline = (playerId: string) => action<{ state: RoomView }>('room:release-offline', { playerId });
  const resign = () => action<{ state: RoomView }>('game:resign');
  async function move(pieceId: string, to: Point): Promise<ClientAck<{ state: RoomView }>> {
    if (!room.value) return { ok: false, code: 'NO_ROOM', error: '尚未进入房间。' };
    const intent: MoveIntent = { requestId: createMoveRequestId(), version: room.value.version, pieceId, to };
    return action<{ state: RoomView }>('game:move', { intent });
  }
  async function copyInvite(): Promise<boolean> {
    if (!session.value) return false;
    const url = new URL(location.href); url.search = '';
    url.searchParams.set('mode', 'online'); url.searchParams.set('room', session.value.roomCode);
    try { await navigator.clipboard.writeText(url.toString()); return true; } catch { return false; }
  }
  function forgetSession() { leaveRoom(); }

  onBeforeUnmount(() => socket?.disconnect());
  if (mode.value === 'online' || pending().length) openSocket();
  return { mode, nickname, createCode, joinCode, room, self, faction, connection, error, exitNotice, busy, inRoom,
    spectating, watchCode, watchingCode, openWatchEntry, startWatching, stopWatching, exitWatching,
    connect, useLocal, createRoom, joinRoom, chooseFaction, setReady, rematch, move, resign, releaseOffline, leaveRoom, copyInvite, forgetSession };
}
