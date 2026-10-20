import { computed, onBeforeUnmount, ref } from 'vue';
import { io, type Socket } from 'socket.io-client';
import { ONLINE_SESSION_KEY } from './online.ts';
import type { ClientAck, MoveIntent, RoomView, SessionReceipt } from './online.ts';
import type { Faction, Point } from './game.ts';

interface SavedSession { roomCode: string; reconnectToken: string; nickname: string }

function loadSession(): SavedSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(ONLINE_SESSION_KEY) || 'null') as Partial<SavedSession> | null;
    return value && typeof value.roomCode === 'string' && typeof value.reconnectToken === 'string' && typeof value.nickname === 'string'
      ? value as SavedSession : null;
  } catch { return null; }
}

export function useOnlineRoom() {
  const params = new URLSearchParams(location.search);
  const mode = ref<'local' | 'online'>(params.get('mode') === 'online' || params.has('room') ? 'online' : 'local');
  const nickname = ref(loadSession()?.nickname ?? '');
  const joinCode = ref((params.get('room') ?? '').toUpperCase());
  const room = ref<RoomView | null>(null);
  const session = ref<SavedSession | null>(loadSession());
  const connection = ref<'offline' | 'connecting' | 'online' | 'replaced'>('offline');
  const error = ref('');
  const busy = ref(false);
  let socket: Socket | null = null;

  function requestId(): string {
    const random = new Uint32Array(4);
    globalThis.crypto.getRandomValues(random);
    return `${Date.now().toString(36)}-${Array.from(random, value => value.toString(36)).join('-')}`;
  }

  const self = computed(() => room.value?.players.find(player => player.id === room.value?.selfId) ?? null);
  const faction = computed(() => self.value?.faction ?? null);
  const inRoom = computed(() => !!room.value && !!session.value);

  function save(receipt: SessionReceipt) {
    session.value = { roomCode: receipt.roomCode, reconnectToken: receipt.reconnectToken, nickname: nickname.value.trim() };
    localStorage.setItem(ONLINE_SESSION_KEY, JSON.stringify(session.value));
    room.value = receipt.state;
  }

  function applyAck<T>(ack: ClientAck<T>): ack is Extract<ClientAck<T>, { ok: true }> {
    if (ack.ok) { error.value = ''; return true; }
    error.value = ack.error;
    if (ack.state) room.value = ack.state;
    return false;
  }

  function emit<T>(event: string, payload: unknown): Promise<ClientAck<T>> {
    return new Promise(resolve => {
      if (!socket?.connected) { resolve({ ok: false, code: 'OFFLINE', error: '尚未连接服务器，请稍后重试。' }); return; }
      socket.timeout(6000).emit(event, payload, (timeout: Error | null, ack: ClientAck<T>) =>
        resolve(timeout ? { ok: false, code: 'TIMEOUT', error: '服务器响应超时，请重新同步后再试。' } : ack));
    });
  }

  async function resume() {
    if (!session.value) return;
    const ack = await emit<SessionReceipt>('room:resume', { roomCode: session.value.roomCode, reconnectToken: session.value.reconnectToken });
    if (applyAck(ack)) save(ack.data);
    else if (!['OFFLINE', 'TIMEOUT'].includes(ack.code)) room.value = null;
  }

  function connect() {
    mode.value = 'online';
    if (socket) { if (!socket.connected) socket.connect(); return; }
    connection.value = 'connecting';
    socket = io({ path: '/three-chess/socket.io', autoConnect: false, reconnection: true });
    socket.on('connect', async () => { connection.value = 'online'; await resume(); });
    socket.on('disconnect', reason => { if (connection.value !== 'replaced') connection.value = 'offline'; if (reason !== 'io client disconnect') error.value = '连接已中断，座位仍会保留；正在自动重连。'; });
    socket.on('room:state', (state: RoomView) => { room.value = state; error.value = ''; });
    socket.on('session:replaced', () => { connection.value = 'replaced'; error.value = '这个席位已在另一设备恢复，本页面已停止联机。'; socket?.disconnect(); });
    socket.connect();
  }

  async function ensureConnected(): Promise<boolean> {
    connect();
    if (socket?.connected) return true;
    return new Promise(resolve => {
      const timer = window.setTimeout(() => resolve(false), 6000);
      socket?.once('connect', () => { window.clearTimeout(timer); resolve(true); });
      socket?.once('connect_error', () => { window.clearTimeout(timer); resolve(false); });
    });
  }

  function useLocal() { mode.value = 'local'; }

  async function createRoom() {
    if (!nickname.value.trim()) { error.value = '请先输入昵称。'; return; }
    busy.value = true;
    try {
      if (!await ensureConnected()) { error.value = '无法连接联机服务器，请稍后重试。'; return; }
      const ack = await emit<SessionReceipt>('room:create', { nickname: nickname.value });
      if (applyAck(ack)) save(ack.data);
    } finally { busy.value = false; }
  }

  async function joinRoom() {
    if (!nickname.value.trim() || !joinCode.value.trim()) { error.value = '请输入昵称和房间号。'; return; }
    busy.value = true;
    try {
      if (!await ensureConnected()) { error.value = '无法连接联机服务器，请稍后重试。'; return; }
      const ack = await emit<SessionReceipt>('room:join', { nickname: nickname.value, roomCode: joinCode.value });
      if (applyAck(ack)) save(ack.data);
    } finally { busy.value = false; }
  }

  async function chooseFaction(factionValue: Faction) {
    if (!session.value) return;
    const ack = await emit<{ state: RoomView }>('room:choose-faction', { roomCode: session.value.roomCode, reconnectToken: session.value.reconnectToken, faction: factionValue });
    if (applyAck(ack)) room.value = ack.data.state;
  }

  async function setReady(ready: boolean) {
    if (!session.value) return;
    const ack = await emit<{ state: RoomView }>('room:ready', { roomCode: session.value.roomCode, reconnectToken: session.value.reconnectToken, ready });
    if (applyAck(ack)) room.value = ack.data.state;
  }

  async function move(pieceId: string, to: Point): Promise<ClientAck<{ state: RoomView }>> {
    if (!session.value || !room.value) return { ok: false, code: 'NO_ROOM', error: '尚未进入房间。' };
    const intent: MoveIntent = { requestId: requestId(), version: room.value.version, pieceId, to };
    const ack = await emit<{ state: RoomView }>('game:move', { roomCode: session.value.roomCode, reconnectToken: session.value.reconnectToken, intent });
    if (applyAck(ack)) room.value = ack.data.state;
    return ack;
  }

  async function copyInvite(): Promise<boolean> {
    if (!room.value) return false;
    const url = new URL(location.href); url.search = ''; url.searchParams.set('mode', 'online'); url.searchParams.set('room', room.value.code);
    try { await navigator.clipboard.writeText(url.toString()); return true; } catch { return false; }
  }

  function forgetSession() {
    localStorage.removeItem(ONLINE_SESSION_KEY); session.value = null; room.value = null; error.value = ''; joinCode.value = '';
  }

  onBeforeUnmount(() => socket?.disconnect());
  if (mode.value === 'online') connect();
  return { mode, nickname, joinCode, room, self, faction, connection, error, busy, inRoom,
    connect, useLocal, createRoom, joinRoom, chooseFaction, setReady, move, copyInvite, forgetSession };
}
