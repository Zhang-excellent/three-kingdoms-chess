<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { io, type Socket } from 'socket.io-client';
import {
  MIST_BOARD_CELLS,
  MIST_CHESS_GAME_ID,
  MIST_CHESS_SESSION_KEY,
  MIST_CHESS_RULES_VERSION,
} from '../mist-chess.ts';
import type {
  MistAck,
  MistGameView,
  MistMoveIntent,
  MistReceipt,
  MistState,
} from '../mist-chess.ts';
import {
  chinesePieceAt,
  chinesePieceName,
  chineseSideName,
  otherChineseSide,
} from '../chinese-chess.ts';
import type { ChinesePiece, ChinesePoint, ChineseSide } from '../chinese-chess.ts';
import { backendAssetUrl, socketIoConfig } from '../network-config.ts';
import { appRouteUrl } from '../navigation.ts';
import { GameAudio, MistMoveSoundTracker, loadAudioSettings } from '../audio.ts';
import type { AudioSettings } from '../audio.ts';
import OtherGameTable from './OtherGameTable.vue';

const props = defineProps<{
  accountName: string | null;
  accountAvatar?: string | null;
  audioSettings?: AudioSettings;
}>();
const emit = defineEmits<{ other: [] }>();
const guestAvatar = 'images/guest-avatar.svg';

interface SavedSession {
  reconnectToken: string;
  playerId: string;
}

const EMPTY_GAME: MistGameView = {
  schema: 1,
  rulesVersion: MIST_CHESS_RULES_VERSION,
  pieces: [],
  turn: 'red',
  status: 'playing',
  winner: null,
  endReason: null,
  lastMove: null,
  history: [],
  visibleCells: [],
  legalMoves: [],
  moveCount: 0,
  lostKinds: [],
  fullBoardVisible: false,
};

function loadSession(): SavedSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(MIST_CHESS_SESSION_KEY) || 'null') as Partial<SavedSession> | null;
    return value && typeof value.reconnectToken === 'string' && typeof value.playerId === 'string'
      ? value as SavedSession : null;
  } catch { return null; }
}

const session = ref<SavedSession | null>(loadSession());
const state = ref<MistState | null>(null);
const inspected = ref<MistState | null>(null);
const connection = ref<'offline' | 'connecting' | 'online'>('offline');
const busy = ref(false), error = ref(''), notice = ref('');
const guestName = ref(''), pendingSide = ref<ChineseSide | null>(null);
const selectedId = ref<string | null>(null), flipped = ref(false);
const inviteVisible = ref(false), inviteText = ref('');
const resignDialog = ref<HTMLDialogElement | null>(null), leaveDialog = ref<HTMLDialogElement | null>(null);
const seatDialog = ref<HTMLDialogElement | null>(null);
const menuOpen = ref(false);
const gameAudio = new GameAudio();
const moveSoundTracker = new MistMoveSoundTracker();
let socket: Socket | null = null;
let resumeAttempt = 0;

const roomState = computed(() => state.value ?? inspected.value);
const showTableView = computed(() => !session.value);
const game = computed(() => roomState.value?.game ?? EMPTY_GAME);
const myPlayer = computed(() => state.value?.players.find(player => player.id === state.value?.selfId) ?? null);
const mySide = computed(() => myPlayer.value?.side ?? null);
const isMyTurn = computed(() => roomState.value?.phase === 'playing'
  && game.value.status === 'playing' && !!mySide.value && game.value.turn === mySide.value);
const selected = computed<ChinesePiece | null>(() => selectedId.value
  ? game.value.pieces.find(piece => piece.id === selectedId.value) ?? null : null);
const moves = computed<ChinesePoint[]>(() => selected.value
  ? game.value.legalMoves.filter(move => move.pieceId === selected.value!.id).map(move => move.to) : []);
const visiblePoints = computed(() => new Set(game.value.visibleCells.map(point => `${point.x},${point.y}`)));
const fogCells = computed(() => game.value.fullBoardVisible ? [] : MIST_BOARD_CELLS.filter(point =>
  !visiblePoints.value.has(`${point.x},${point.y}`)));
const latest = computed(() => game.value.lastMove);
const history = computed(() => game.value.history.slice(-20).reverse());
const boardTitle = computed(() => {
  const room = roomState.value;
  if (!room) return '正在读取棋桌';
  if (room.phase === 'lobby') {
    if (room.players.length < 2) return '点击空席位入座';
    return '等待双方准备';
  }
  if (room.phase === 'finished') {
    if (!game.value.winner) return '本局和棋';
    if (!mySide.value) return '本局结束';
    return game.value.winner === mySide.value ? '你获胜' : '你失败';
  }
  const active = room.players.find(player => player.side === game.value.turn);
  return `轮到 ${active?.nickname || chineseSideName(game.value.turn)} 行棋`;
});
const resultText = computed(() => {
  if (game.value.status !== 'finished') return '';
  if (game.value.endReason === 'draw') return '双方同意和棋。';
  if (!mySide.value) return game.value.winner ? `${chineseSideName(game.value.winner)}获胜` : '本局结束';
  if (game.value.winner !== mySide.value) return '本局落败，可以再来一局。';
  if (game.value.endReason === 'king-captured') return '吃掉对方将帅，胜局已定。';
  if (game.value.endReason === 'stalemate') return '对方没有任何合法走法，胜局已定。';
  return '对方认输，胜局已定。';
});

const px = (x: number) => 50 + x * 55;
const py = (y: number) => 50 + y * 55;
const viewX = (x: number) => px(flipped.value ? 8 - x : x);
const viewY = (y: number) => py(flipped.value ? 9 - y : y);
const coordinate = (point: ChinesePoint) => `(${point.x + 1}, ${point.y + 1})`;
const targetAt = (point: ChinesePoint) => chinesePieceAt(game.value.pieces, point);
const topSide = computed<ChineseSide>(() => flipped.value ? 'red' : 'black');
const bottomSide = computed<ChineseSide>(() => otherChineseSide(topSide.value));
const sidePlayer = (side: ChineseSide) => roomState.value?.players.find(player => player.side === side) ?? null;
const avatarFor = (side: ChineseSide) => backendAssetUrl(sidePlayer(side)?.avatar) || (sidePlayer(side) ? guestAvatar : null);
const sideLabel = (side: ChineseSide) => chineseSideName(side);
const pieceLabel = (piece: ChinesePiece) =>
  `${chineseSideName(piece.side)}${chinesePieceName(piece)}，${piece.x + 1} 路第 ${piece.y + 1} 线`;
const playerState = (side: ChineseSide) => {
  const player = sidePlayer(side);
  if (!player) return roomState.value?.phase === 'lobby' ? '等待棋友' : '未入座';
  if (!player.online) return '断线中';
  if (roomState.value?.phase === 'lobby') return player.ready ? '已准备' : '未准备';
  if (roomState.value?.phase === 'finished') return !game.value.winner ? '和棋' : game.value.winner === side ? '胜利' : '失败';
  return game.value.turn === side ? '行棋中' : '对局中';
};
const canSeat = (side: ChineseSide) => !session.value && roomState.value?.phase === 'lobby'
  && roomState.value.players.length < 2 && !sidePlayer(side);
const drawOfferBy = computed(() => roomState.value?.drawOfferBy ?? null);
const canRespondDraw = computed(() => !!session.value && roomState.value?.phase === 'playing'
  && !!drawOfferBy.value && drawOfferBy.value !== mySide.value);
const mistAudioSettings = computed<AudioSettings>(() => props.audioSettings ?? loadAudioSettings());

function saveSession(receipt: MistReceipt): boolean {
  if (!receipt || receipt.gameId !== MIST_CHESS_GAME_ID || receipt.playerId !== receipt.state.selfId) return false;
  session.value = { reconnectToken: receipt.reconnectToken, playerId: receipt.playerId };
  localStorage.setItem(MIST_CHESS_SESSION_KEY, JSON.stringify(session.value));
  state.value = receipt.state;
  inspected.value = receipt.state;
  selectedId.value = null;
  flipped.value = receipt.state.players.find(player => player.id === receipt.playerId)?.side === 'black';
  return true;
}

function clearSession() {
  resumeAttempt++;
  session.value = null;
  state.value = null;
  selectedId.value = null;
  localStorage.removeItem(MIST_CHESS_SESSION_KEY);
}

function acceptState(next: MistState) {
  if (!next || next.gameId !== MIST_CHESS_GAME_ID) return;
  if (session.value && next.selfId === session.value.playerId) {
    if (state.value && next.version < state.value.version) return;
    state.value = next;
    inspected.value = next;
    return;
  }
  if (!session.value && next.selfId === null) inspected.value = next;
}

function emitAck<T>(event: string, payload: unknown, timeoutMs = 6000): Promise<MistAck<T>> {
  return new Promise(resolve => {
    if (!socket?.connected) {
      resolve({ ok: false, code: 'OFFLINE', error: '尚未连接服务器，请稍后重试。' });
      return;
    }
    socket.timeout(timeoutMs).emit(event, payload, (timeout: Error | null, ack: MistAck<T>) => {
      resolve(timeout ? { ok: false, code: 'TIMEOUT', error: '服务器响应超时，请稍后重试。' } : ack);
    });
  });
}

async function ensureConnected(): Promise<boolean> {
  openSocket();
  if (socket?.connected) return true;
  return new Promise(resolve => {
    const timer = window.setTimeout(() => resolve(false), 6000);
    socket?.once('connect', () => { window.clearTimeout(timer); resolve(true); });
    socket?.once('connect_error', () => { window.clearTimeout(timer); resolve(false); });
  });
}

async function recover() {
  const attempt = ++resumeAttempt;
  if (session.value) {
    const saved = session.value;
    const ack = await emitAck<MistReceipt>('mist:resume', { reconnectToken: saved.reconnectToken });
    if (attempt !== resumeAttempt || session.value?.reconnectToken !== saved.reconnectToken) return;
    if (ack.ok) saveSession(ack.data);
    else if (ack.code === 'SESSION_NOT_FOUND') {
      clearSession();
      const inspectedAck = await emitAck<MistState>('mist:inspect', {});
      if (inspectedAck.ok) inspected.value = inspectedAck.data;
    } else error.value = ack.error;
    return;
  }
  const ack = await emitAck<MistState>('mist:inspect', {});
  if (attempt !== resumeAttempt) return;
  if (ack.ok) inspected.value = ack.data;
  else error.value = ack.error;
}

function openSocket() {
  if (socket) {
    if (!socket.connected) socket.connect();
    return;
  }
  connection.value = 'connecting';
  const config = socketIoConfig();
  const options = { ...config.options, autoConnect: false, reconnection: true, forceNew: true };
  socket = config.origin ? io(config.origin, options) : io(options);
  socket.on('connect', () => { connection.value = 'online'; void recover(); });
  socket.on('disconnect', () => {
    connection.value = 'offline';
    moveSoundTracker.suspend();
  });
  socket.on('connect_error', () => {
    connection.value = 'offline';
    moveSoundTracker.suspend();
  });
  socket.on('mist:state', acceptState);
  socket.on('mist:session-replaced', () => {
    clearSession();
    error.value = '席位已在另一页面恢复，本页已停止联机。';
  });
  socket.connect();
}

function openSeat(side: ChineseSide) {
  if (busy.value || !canSeat(side)) return;
  gameAudio.primeEffects(mistAudioSettings.value);
  if (props.accountName) {
    void joinSeat(side, '');
    return;
  }
  pendingSide.value = side;
  guestName.value = '';
  error.value = '';
  seatDialog.value?.showModal();
}

function confirmGuestSeat() {
  if (!pendingSide.value) return;
  gameAudio.primeEffects(mistAudioSettings.value);
  if (!guestName.value.trim()) {
    error.value = '请输入昵称。';
    return;
  }
  void joinSeat(pendingSide.value, guestName.value.trim());
}

async function joinSeat(side: ChineseSide, nickname: string) {
  if (busy.value || !canSeat(side)) return;
  error.value = ''; notice.value = '';
  if (!await ensureConnected()) {
    error.value = '暂时无法连接服务器，请稍后重试。';
    return;
  }
  busy.value = true;
  try {
    const ack = await emitAck<MistReceipt>('mist:join', { nickname, side });
    if (!ack.ok) error.value = ack.error;
    else if (!saveSession(ack.data)) error.value = '服务器返回的席位信息不完整。';
    else {
      seatDialog.value?.close();
      pendingSide.value = null;
    }
  } finally { busy.value = false; }
}

async function setReady(ready: boolean) {
  if (!session.value || busy.value) return;
  gameAudio.primeEffects(mistAudioSettings.value);
  busy.value = true;
  try {
    const ack = await emitAck<{ state: MistState }>('mist:ready', {
      reconnectToken: session.value.reconnectToken, ready,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally { busy.value = false; }
}

async function move(pieceId: string, to: ChinesePoint) {
  if (!session.value || busy.value || !isMyTurn.value) return;
  const intent: MistMoveIntent = {
    requestId: `mist-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`,
    version: state.value?.version ?? 0,
    pieceId,
    to,
  };
  busy.value = true;
  try {
    const ack = await emitAck<{ state: MistState }>('mist:move', {
      reconnectToken: session.value.reconnectToken, intent,
    });
    if (!ack.ok) {
      error.value = ack.error;
      if (ack.state) acceptState(ack.state);
    } else {
      error.value = '';
      acceptState(ack.data.state);
      selectedId.value = null;
    }
  } finally { busy.value = false; }
}

function clickPoint(point: ChinesePoint) {
  if (!isMyTurn.value) return;
  gameAudio.primeEffects(mistAudioSettings.value);
  const piece = targetAt(point);
  if (piece?.side === mySide.value) {
    selectedId.value = selectedId.value === piece.id ? null : piece.id;
    return;
  }
  if (!selected.value) return;
  if (moves.value.some(item => item.x === point.x && item.y === point.y))
    void move(selected.value.id, point);
  else error.value = '这一步无法执行，请重新选择。';
}

async function resign() {
  if (!session.value || busy.value) return;
  resignDialog.value?.close();
  busy.value = true;
  try {
    const ack = await emitAck<{ state: MistState }>('mist:resign', {
      reconnectToken: session.value.reconnectToken,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally { busy.value = false; }
}

async function rematch() {
  if (!session.value || busy.value) return;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: MistState }>('mist:rematch', {
      reconnectToken: session.value.reconnectToken,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally { busy.value = false; }
}

async function requestDraw() {
  if (!session.value || busy.value) return;
  menuOpen.value = false;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: MistState }>('mist:draw-offer', {
      reconnectToken: session.value.reconnectToken,
    });
    if (!ack.ok) error.value = ack.error;
    else { acceptState(ack.data.state); notice.value = '已提出和棋申请。'; }
  } finally { busy.value = false; }
}

async function respondDraw(accept: boolean) {
  if (!session.value || busy.value) return;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: MistState }>('mist:draw-respond', {
      reconnectToken: session.value.reconnectToken, accept,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally { busy.value = false; }
}

async function leaveRoom(): Promise<void> {
  leaveDialog.value?.close();
  const saved = session.value;
  if (!saved) return;
  busy.value = true;
  try {
    if (connection.value === 'online') await emitAck('mist:leave', { reconnectToken: saved.reconnectToken }, 3500);
  } finally {
    busy.value = false;
    clearSession();
    menuOpen.value = false;
    const ack = await emitAck<MistState>('mist:inspect', {});
    if (ack.ok) inspected.value = ack.data;
  }
}

async function leaveForNavigation(): Promise<void> {
  const saved = session.value;
  if (!saved) return;
  if (connection.value === 'online') await emitAck('mist:leave', { reconnectToken: saved.reconnectToken }, 3500);
  clearSession();
}

function requestLeave() {
  if (roomState.value?.phase === 'playing') leaveDialog.value?.showModal();
  else void leaveRoom();
}

async function copyInvite() {
  const link = appRouteUrl(location.href, 'mist');
  inviteText.value = link;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(link);
    inviteVisible.value = true;
    notice.value = '邀请链接已复制。';
  } catch {
    inviteVisible.value = true;
    notice.value = '';
  }
}

function selectInvite(event: FocusEvent) {
  (event.target as HTMLTextAreaElement).select();
}

watch(mySide, side => { if (side) flipped.value = side === 'black'; });
watch(() => roomState.value?.version, () => {
  if (selectedId.value && !game.value.pieces.some(piece => piece.id === selectedId.value))
    selectedId.value = null;
});
watch(() => roomState.value?.game, current => {
  if (!current) return;
  const kind = moveSoundTracker.observe(
    current,
    mySide.value,
    `mist:${roomState.value?.round ?? 0}:${myPlayer.value?.id ?? 'visitor'}`,
    connection.value === 'online',
  );
  if (kind) gameAudio.playEffect(kind, mistAudioSettings.value);
});
watch([() => props.accountName, () => props.accountAvatar], ([name], [previousName, previousAvatar]) => {
  if (name || props.accountAvatar !== previousAvatar) {
    guestName.value = '';
    if (name !== previousName || props.accountAvatar !== previousAvatar) {
      socket?.disconnect();
      socket?.connect();
    }
  }
});

onMounted(openSocket);
onBeforeUnmount(() => {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  gameAudio.dispose();
});

defineExpose({ leaveForNavigation, openSeat });
</script>

<template>
  <main class="mist-page" :data-connection="connection">
    <div class="mist-page-nav">
      <button class="plain-button" type="button" @click="emit('other')">← 其他玩法</button>
      <span v-if="myPlayer" class="mist-side-chip" :class="myPlayer.side">{{ sideLabel(myPlayer.side) }}</span>
    </div>
    <header class="mist-heading">
      <div><span class="eyebrow">FOG CHINESE CHESS</span><h1>迷雾象棋</h1></div>
      <p>沿用中国象棋走法。只能看见己方棋子及其可走、可吃的落点；吃掉将帅获胜。</p>
    </header>
    <p v-if="connection !== 'online'" class="connection-note" :class="{ error: !!error }">{{ error || '正在连接棋桌…' }}</p>
    <p v-else-if="error" class="connection-note error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="connection-note" role="status">{{ notice }}</p>

    <OtherGameTable v-if="showTableView" title="迷雾象棋" eyebrow="FOG CHINESE CHESS"
      :phase="roomState?.phase ?? 'lobby'" :players="roomState?.players ?? []" :busy="busy || !roomState"
      :watch-enabled="false" @seat="openSeat" />

    <template v-else>
      <article class="mist-table-seat opponent-seat" :class="[topSide, { ready: sidePlayer(topSide)?.ready, active: roomState?.phase === 'playing' && game.turn === topSide }]">
        <span class="mist-seat-avatar" :class="{ placeholder: !sidePlayer(topSide) }">
          <img v-if="avatarFor(topSide)" :src="avatarFor(topSide)!" alt="">
          <template v-else>?</template>
        </span>
        <span class="mist-seat-copy">
          <strong>{{ sidePlayer(topSide)?.nickname || '等待棋友' }}</strong>
          <small>{{ sideLabel(topSide) }}席位</small>
        </span>
        <em>{{ playerState(topSide) }}</em>
      </article>

      <section class="mist-game-layout">
        <div class="mist-board-column">
          <div class="game-board-menu-row">
            <div v-if="session" class="game-action-menu">
              <button class="game-action-menu-toggle" type="button" :aria-expanded="menuOpen" aria-label="打开对局菜单" @click="menuOpen = !menuOpen">‹</button>
              <div v-if="menuOpen" class="game-action-menu-list">
                <button type="button" :disabled="roomState?.phase !== 'playing' || !!drawOfferBy" @click="requestDraw">提和</button>
                <button type="button" :disabled="roomState?.phase !== 'playing'" @click="menuOpen = false; resignDialog?.showModal()">认输</button>
                <button type="button" :disabled="busy" @click="menuOpen = false; requestLeave()">离开</button>
              </div>
            </div>
            <span v-if="session" class="game-board-role">{{ sideLabel(mySide!) }}方</span>
          </div>
          <div class="mist-board-heading">
            <h2>{{ boardTitle }}</h2>
            <span>{{ roomState?.phase === 'lobby' ? '等待开局' : `第 ${game.moveCount} 手` }}</span>
          </div>
          <div class="board-frame mist-board-frame" :class="{ 'full-board': game.fullBoardVisible }">
            <svg class="board-svg mist-board-svg" :class="{ playable: roomState?.phase === 'playing' && isMyTurn }"
              viewBox="0 0 540 595" role="group" :aria-label="`迷雾象棋棋盘，${flipped ? '黑方' : '红方'}视角，仅显示本方视野`">
              <defs>
                <linearGradient id="mist-wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#efdab4"/><stop offset="1" stop-color="#e5c897"/></linearGradient>
                <marker id="mist-trail-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a77b36"/></marker>
              </defs>
              <rect x="8" y="8" width="524" height="579" rx="8" fill="url(#mist-wood)"/>
              <rect x="37" y="37" width="466" height="521" fill="none" stroke="#674d2f" stroke-width="1.4"/>
              <g class="grid-lines">
                <line v-for="n in 10" :key="`h${n}`" :x1="px(0)" :x2="px(8)" :y1="py(n-1)" :y2="py(n-1)"/>
                <template v-for="n in 9" :key="`v${n}`">
                  <line :x1="px(n-1)" :x2="px(n-1)" :y1="py(0)" :y2="py(4)"/>
                  <line :x1="px(n-1)" :x2="px(n-1)" :y1="py(5)" :y2="py(9)"/>
                </template>
                <line :x1="px(0)" :x2="px(0)" :y1="py(4)" :y2="py(5)"/><line :x1="px(8)" :x2="px(8)" :y1="py(4)" :y2="py(5)"/>
                <path :d="`M${px(3)} ${py(0)} L${px(5)} ${py(2)} M${px(5)} ${py(0)} L${px(3)} ${py(2)} M${px(3)} ${py(7)} L${px(5)} ${py(9)} M${px(5)} ${py(7)} L${px(3)} ${py(9)}`"/>
              </g>
              <g class="coordinates">
                <text v-for="n in 9" :key="n" :x="px(n-1)" y="25">{{ flipped ? 10 - n : n }}</text>
                <text v-for="n in 10" :key="`row${n}`" x="24" :y="py(n-1)+4">{{ flipped ? 11 - n : n }}</text>
              </g>
              <text class="river" x="175" y="305">{{ flipped ? '汉 界' : '楚 河' }}</text>
              <text class="river" x="365" y="305">{{ flipped ? '楚 河' : '汉 界' }}</text>
              <g v-if="fogCells.length" class="mist-fog-layer" aria-hidden="true">
                <rect v-for="point in fogCells" :key="`fog-${point.x}-${point.y}`"
                  :x="viewX(point.x) - 27" :y="viewY(point.y) - 27" width="54" height="54" rx="11" class="mist-fog-cell"/>
              </g>
              <g v-if="latest" class="last-trail" aria-hidden="true">
                <line :x1="viewX(latest.from.x)" :y1="viewY(latest.from.y)" :x2="viewX(latest.to.x)" :y2="viewY(latest.to.y)" marker-end="url(#mist-trail-tip)"/>
                <rect :x="viewX(latest.from.x)-18" :y="viewY(latest.from.y)-18" width="36" height="36" rx="4"/>
                <circle :cx="viewX(latest.to.x)" :cy="viewY(latest.to.y)" r="26"/>
              </g>
              <g v-for="point in moves" :key="`${point.x},${point.y}`" class="mist-target" role="button" tabindex="0"
                :aria-label="`${targetAt(point) ? '吃子到' : '走到'}第${point.x+1}路第${point.y+1}线`"
                @click.stop="clickPoint(point)" @keydown.enter.prevent.stop="clickPoint(point)" @keydown.space.prevent.stop="clickPoint(point)">
                <circle :cx="viewX(point.x)" :cy="viewY(point.y)" r="23" fill="transparent"/>
                <circle :cx="viewX(point.x)" :cy="viewY(point.y)" :r="targetAt(point) ? 27 : 6" :class="targetAt(point) ? 'capture-ring' : 'move-dot'"/>
              </g>
              <g v-for="piece in game.pieces" :key="piece.id" class="mist-piece" :class="[piece.side, { selected: selectedId === piece.id }]"
                :style="{transform: `translate(${viewX(piece.x)}px, ${viewY(piece.y)}px)`}" role="button" tabindex="0"
                :aria-disabled="!isMyTurn" :aria-label="pieceLabel(piece)" @click.stop="clickPoint(piece)" @keydown.enter.prevent.stop="clickPoint(piece)">
                <circle class="mist-selection-ring" r="27"/><circle class="mist-piece-shadow" cy="2.5" r="23"/>
                <circle class="mist-piece-face" r="23"/><circle class="mist-piece-rim" r="19.5"/>
                <text :class="{general: piece.kind === 'king'}" y="1">{{ chinesePieceName(piece) }}</text>
              </g>
            </svg>
            <div v-if="session && roomState?.phase === 'lobby'" class="game-board-waiting-card">
              <span class="eyebrow">棋桌准备</span>
              <h3>{{ roomState.players.length < 2 ? '等待棋友' : '双方已入座' }}</h3>
              <p>{{ myPlayer?.ready ? '已准备，等待对手。' : '准备后即可等待开局。' }}</p>
              <div class="game-waiting-actions">
                <button class="primary-button" type="button" :disabled="busy || connection !== 'online'" @click="setReady(!myPlayer?.ready)">{{ myPlayer?.ready ? '取消开始' : '开始' }}</button>
                <button class="tool-button" type="button" @click="copyInvite">邀请好友</button>
              </div>
            </div>
          </div>
          <div v-if="drawOfferBy && roomState?.phase === 'playing'" class="draw-offer-bar">
            <span>{{ drawOfferBy === mySide ? '已提和，等待对手回应。' : `${sideLabel(drawOfferBy)}提出和棋。` }}</span>
            <div v-if="canRespondDraw">
              <button type="button" :disabled="busy" @click="respondDraw(true)">同意</button>
              <button type="button" :disabled="busy" @click="respondDraw(false)">拒绝</button>
            </div>
          </div>
          <article class="mist-table-seat self-seat" :class="[bottomSide, { ready: sidePlayer(bottomSide)?.ready, active: roomState?.phase === 'playing' && game.turn === bottomSide, self: mySide === bottomSide }]">
            <span class="mist-seat-avatar" :class="{ placeholder: !sidePlayer(bottomSide) }">
              <img v-if="avatarFor(bottomSide)" :src="avatarFor(bottomSide)!" alt=""><template v-else>?</template>
            </span>
            <span class="mist-seat-copy">
              <strong>{{ sidePlayer(bottomSide)?.nickname || '等待棋友' }}</strong>
              <small>{{ sideLabel(bottomSide) }}席位</small>
            </span>
            <em>{{ playerState(bottomSide) }}</em>
          </article>
          <div class="board-tools mist-table-actions">
            <button class="tool-button" type="button" @click="flipped = !flipped">翻转棋盘</button>
            <button v-if="session && roomState?.phase === 'finished'" class="primary-button" type="button" :disabled="busy || connection !== 'online'" @click="rematch">再来一局</button>
          </div>
          <textarea v-if="inviteVisible" class="mist-invite-text" :value="inviteText" readonly rows="2" aria-label="迷雾象棋邀请链接" @focus="selectInvite"></textarea>
          <div v-if="roomState?.phase === 'finished'" class="result-banner">
            <strong>{{ resultText }}</strong>
            <span>{{ mySide && game.winner ? `${chineseSideName(game.winner)}获胜` : '本局已结束，完整棋盘已揭晓' }}</span>
          </div>
        </div>
        <aside class="mist-history">
          <div class="mist-history-heading"><strong>{{ game.fullBoardVisible ? '完整行棋记录' : '我方行动记录' }}</strong><span>共 {{ game.moveCount }} 手</span></div>
          <p v-if="!game.fullBoardVisible && game.moveCount > game.history.length" class="mist-history-hint">
            对手在迷雾中的走法已隐藏；轮次和你的视野仍会实时更新。
          </p>
          <div v-if="latest" class="last-move-card">
            <span class="eyebrow">上一步</span>
            <h3 :class="latest.side">{{ chineseSideName(latest.side) }} · {{ chinesePieceName(latest) }}</h3>
            <p>{{ coordinate(latest.from) }} → {{ coordinate(latest.to) }}</p>
            <small>{{ latest.captured ? `吃掉${chineseSideName(latest.captured.side)}${chinesePieceName(latest.captured)}` : '已标记起点和落点' }}</small>
          </div>
          <ol v-if="history.length" class="move-list">
            <li v-for="record in history" :key="record.number">
              <span class="record-number">{{ String(record.number).padStart(2, '0') }}</span>
              <div><strong :class="record.side">{{ chineseSideName(record.side) }}</strong><p>{{ chinesePieceName(record) }} {{ coordinate(record.from) }} → {{ coordinate(record.to) }}</p><small v-if="record.captured">吃掉{{ chineseSideName(record.captured.side) }}{{ chinesePieceName(record.captured) }}</small></div>
            </li>
          </ol>
          <div v-else class="empty-history"><span aria-hidden="true">雾</span><p>{{ roomState?.phase === 'lobby' ? '开局后显示可见行动。' : '暂无可见行动记录。' }}</p></div>
          <details class="mist-live-rules">
            <summary>玩法说明</summary>
            <p>只能看见己方棋子及全部可走、可吃落点，路径和炮架不会自动点亮。允许送将和将帅照面，吃掉将帅立即获胜；终局后才公开完整棋盘与棋谱。</p>
          </details>
        </aside>
      </section>
    </template>

    <dialog ref="seatDialog" class="mist-seat-dialog" @cancel.prevent="seatDialog?.close()">
      <form @submit.prevent="confirmGuestSeat">
        <div class="dialog-heading"><h2>入座 {{ pendingSide ? sideLabel(pendingSide) : '' }}</h2><button class="dialog-close" type="button" aria-label="关闭" @click="seatDialog?.close()">×</button></div>
        <label>昵称：<input v-model="guestName" maxlength="16" autocomplete="nickname" aria-label="座位昵称"></label>
        <p v-if="error" class="connection-note error" role="alert">{{ error }}</p>
        <div class="dialog-actions"><button class="tool-button" type="button" @click="seatDialog?.close()">取消</button><button class="primary-button" type="submit" :disabled="busy || connection !== 'online'">入座</button></div>
      </form>
    </dialog>
    <dialog ref="resignDialog" class="reset-dialog">
      <h2>确认认输？</h2><p>本局立即判负，仍可留在房间查看终局。</p>
      <div class="dialog-actions"><button class="tool-button" type="button" @click="resignDialog?.close()">继续对局</button><button class="primary-button" type="button" @click="resign">确认认输</button></div>
    </dialog>
    <dialog ref="leaveDialog" class="reset-dialog">
      <h2>退出迷雾象棋？</h2><p>对局进行中离开会按认输结算，席位立即释放。</p>
      <div class="dialog-actions"><button class="tool-button" type="button" @click="leaveDialog?.close()">继续对局</button><button class="primary-button" type="button" @click="leaveRoom">确认退出</button></div>
    </dialog>
  </main>
</template>

<style scoped>
.mist-page{width:min(1180px,100%);min-width:0;margin:0 auto;padding:24px 0 54px;overflow-x:clip;--mist-red:#a64b3c;--mist-black:#343e48}.mist-page-nav{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;padding-bottom:13px;border-bottom:1px solid #ded2c1}.mist-page-nav .plain-button{font-size:15px;font-weight:600;color:#5b4d3e}.mist-side-chip{padding:4px 10px;border:1px solid #d7c6ab;border-radius:999px;background:#fffaf0;color:#745e3f;font-size:10px;font-weight:700}.mist-side-chip.red{color:var(--mist-red);border-color:#d5a79e}.mist-side-chip.black{color:var(--mist-black);border-color:#afb5bb}.mist-heading{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:18px}.mist-heading h1{margin:5px 0 0;font:700 42px/1.15 "Songti SC","SimSun",serif;letter-spacing:4px;color:#3c332a}.mist-heading p{max-width:520px;margin:0;color:#7e6e5b;font-size:12px;line-height:1.8;text-align:right}.mist-game-layout{display:grid;grid-template-columns:minmax(0,1fr) 260px;align-items:start;gap:20px}.mist-board-column{display:grid;gap:10px;min-width:0}.mist-board-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;width:min(660px,100%);margin:0 auto 2px;padding:0 2px}.mist-board-heading h2{margin:0;font:700 20px/1.25 "Songti SC","SimSun",serif;color:#3f352b}.mist-board-heading span{padding:5px 10px;border:1px solid #d8cab5;border-radius:999px;background:#fffdf8;color:#847461;font-size:10px}.mist-board-frame{width:100%;max-width:660px;margin:0 auto}.mist-board-svg:not(.playable) .mist-piece{cursor:default}.mist-fog-layer{pointer-events:none}.mist-fog-cell{fill:#172022;opacity:.94;stroke:#0d1315;stroke-width:1;filter:drop-shadow(0 2px 2px #0003)}.mist-board-frame.full-board .mist-fog-cell{opacity:0}.mist-piece{cursor:pointer;transition:transform .18s ease;outline-offset:1px}.mist-piece-shadow{fill:#603f3270}.mist-piece-face{stroke-width:1.6;filter:drop-shadow(0 2px 2px #0002)}.mist-piece.red .mist-piece-face{fill:#b6503e;stroke:#83392e}.mist-piece.black .mist-piece-face{fill:#343e48;stroke:#202b36}.mist-piece-rim{fill:none;stroke:#fff3d9;stroke-width:.8;opacity:.52}.mist-piece text{text-anchor:middle;dominant-baseline:central;fill:#fff6e3;font:27px "STKaiti","KaiTi","Songti SC",serif;pointer-events:none}.mist-piece text.general{font-size:32px;font-weight:600}.mist-selection-ring{fill:none;stroke:#fffaf0;stroke-width:3;opacity:0}.mist-piece.selected .mist-selection-ring{opacity:1;filter:drop-shadow(0 0 2px #805c28)}.mist-target{cursor:pointer}.mist-table-seat{--seat-color:#a64b3c;display:flex;align-items:center;gap:12px;width:min(660px,100%);min-height:62px;margin:0 auto;padding:8px 13px;border:1px solid #d6c7b3;border-radius:12px;background:linear-gradient(145deg,#fffdf8,#f8f2e8);color:#4d4236;text-align:left;transition:border-color .16s ease,box-shadow .16s ease}.mist-table-seat.black{--seat-color:#343e48}.mist-table-seat.opponent-seat{margin-bottom:2px}.mist-table-seat.self-seat{margin-top:2px}.mist-table-seat.active{border-color:var(--seat-color);box-shadow:inset 3px 0 var(--seat-color),0 7px 18px #59432310}.mist-table-seat.self{border-color:color-mix(in srgb,var(--seat-color) 55%,#d6c7b3)}.mist-seat-avatar{display:grid;place-items:center;width:44px;height:44px;flex:none;overflow:hidden;border:1px solid var(--seat-color);border-radius:9px;background:var(--seat-color);color:#fff8e8;font:700 23px/1 "STKaiti","KaiTi",serif}.mist-seat-avatar.placeholder{border-color:#c8bbab;background:#e7e1d7;color:#9c9080}.mist-seat-avatar img{width:100%;height:100%;object-fit:cover}.mist-seat-copy{display:grid;gap:2px;min-width:0;flex:1}.mist-seat-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 18px/1.3 "Songti SC","SimSun",serif}.mist-seat-copy small{color:#8c7d6a;font-size:10px}.mist-table-seat>em{padding:3px 8px;border-radius:999px;background:#eee6da;color:#786a58;font-size:9px;font-style:normal;white-space:nowrap}.mist-table-seat.ready>em{background:#e4efe4;color:#39704b}.mist-table-actions{justify-content:center;flex-wrap:wrap;padding:2px 0 4px}.mist-table-actions>button{min-height:42px}.mist-invite-text{width:min(660px,100%);margin:0 auto;padding:9px 11px;border:1px solid #d8cab5;border-radius:8px;background:#fffefb;color:#625444;font:500 11px/1.55 ui-monospace,Consolas,monospace;resize:none}.mist-history{position:sticky;top:16px;min-width:0;padding:16px;border:1px solid #ddd0bd;border-radius:12px;background:#fffdf8}.mist-history-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px;color:#645647;font-size:12px}.mist-history-heading span{color:#94846f;font-size:10px}.mist-history-hint{margin:0 0 12px;padding:9px 10px;border-radius:8px;background:#f2ede4;color:#7d705f;font-size:10px;line-height:1.65}.mist-history h3.red,.mist-history strong.red{color:var(--mist-red)}.mist-history h3.black,.mist-history strong.black{color:var(--mist-black)}.mist-history .last-move-card{padding:14px}.mist-history .move-list{max-height:420px;overflow:auto}.mist-history .empty-history{display:block;padding:24px 8px;text-align:center;border:0}.mist-live-rules{margin-top:16px;padding-top:13px;border-top:1px solid #e4d9ca;color:#7e705f;font-size:11px;line-height:1.7}.mist-live-rules summary{cursor:pointer;font-weight:600;color:#715b3c}.mist-live-rules p{margin:8px 0 0}.mist-seat-dialog{width:min(380px,calc(100vw - 32px));padding:24px}.mist-seat-dialog form{display:grid;gap:16px}.mist-seat-dialog h2{font:700 24px "Songti SC","SimSun",serif}.mist-seat-dialog label{display:grid;gap:7px;color:#615344;font-size:14px;font-weight:600}.mist-seat-dialog input{height:46px;border:1px solid #d8cab5;border-radius:9px;background:#fffefb;padding:0 13px;color:#3f352b;font:500 16px/1 inherit;outline:none}.mist-seat-dialog input:focus{border-color:#a78147;box-shadow:0 0 0 3px #a7814718}.mist-seat-dialog::backdrop,.mist-page .reset-dialog::backdrop{background:#372c204f;backdrop-filter:blur(2px)}@media(max-width:860px){.mist-game-layout{grid-template-columns:1fr}.mist-history{position:static;margin-top:4px}.mist-heading p{max-width:390px}.mist-table-actions{justify-content:flex-start}}@media(max-width:640px){.mist-page{padding:14px 0 38px}.mist-page-nav{margin-bottom:14px}.mist-heading{display:block;margin-bottom:17px}.mist-heading h1{font-size:31px;letter-spacing:3px}.mist-heading p{margin-top:8px;text-align:left;font-size:11px}.mist-board-heading h2{font-size:17px}.mist-table-seat{min-height:58px;padding:8px 10px;gap:9px}.mist-seat-avatar{width:38px;height:38px;font-size:20px}.mist-seat-copy strong{font-size:15px}.mist-table-seat>em{max-width:74px;overflow:hidden;text-overflow:ellipsis}.mist-table-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.mist-table-actions>button{width:100%;margin:0}.mist-history{padding:12px}.mist-fog-cell{opacity:.95}.mist-seat-dialog{padding:20px}}
</style>
