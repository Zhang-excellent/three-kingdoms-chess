<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { io, type Socket } from 'socket.io-client';
import {
  HORSE_CHESS_GAME_ID,
  HORSE_CHESS_SESSION_KEY,
  HORSE_GOALS,
  horsePieceAt,
  horseSideName,
  legalHorseMoves,
  newHorseGame,
  otherHorseSide,
} from '../horse-chess.ts';
import type {
  HorseAck,
  HorseGame,
  HorseMoveIntent,
  HorsePiece,
  HorsePoint,
  HorseReceipt,
  HorseSide,
  HorseState,
} from '../horse-chess.ts';
import { backendAssetUrl, socketIoConfig } from '../network-config.ts';
import { appRouteUrl } from '../navigation.ts';
import OtherGameTable from './OtherGameTable.vue';

const props = defineProps<{ accountName: string | null; accountAvatar?: string | null }>();
const emit = defineEmits<{ other: [] }>();
const guestAvatar = 'images/guest-avatar.svg';

interface SavedSession {
  reconnectToken: string;
  playerId: string;
}

function loadSession(): SavedSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(HORSE_CHESS_SESSION_KEY) || 'null') as Partial<SavedSession> | null;
    return value && typeof value.reconnectToken === 'string' && typeof value.playerId === 'string'
      ? value as SavedSession : null;
  } catch { return null; }
}

const session = ref<SavedSession | null>(loadSession());
const state = ref<HorseState | null>(null);
const inspected = ref<HorseState | null>(null);
const connection = ref<'offline' | 'connecting' | 'online'>('offline');
const busy = ref(false), error = ref(''), notice = ref('');
const guestName = ref(''), pendingSide = ref<HorseSide | null>(null);
const selectedId = ref<string | null>(null), flipped = ref(false);
const inviteVisible = ref(false), inviteText = ref('');
const resignDialog = ref<HTMLDialogElement | null>(null), leaveDialog = ref<HTMLDialogElement | null>(null);
const seatDialog = ref<HTMLDialogElement | null>(null);
const watching = ref(false), menuOpen = ref(false);
let socket: Socket | null = null;
let resumeAttempt = 0;

const roomState = computed(() => state.value ?? inspected.value);
const showTableView = computed(() => !session.value && !watching.value);
const game = computed<HorseGame>(() => roomState.value?.game ?? newHorseGame());
const myPlayer = computed(() => state.value?.players.find(player => player.id === state.value?.selfId) ?? null);
const mySide = computed(() => myPlayer.value?.side ?? null);
const isMyTurn = computed(() => game.value.status === 'playing' && !!mySide.value && game.value.turn === mySide.value);
const selected = computed(() => selectedId.value ? game.value.pieces.find(piece => piece.id === selectedId.value) ?? null : null);
const moves = computed(() => selected.value ? legalHorseMoves(game.value.pieces, selected.value) : []);
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
  return `轮到 ${active?.nickname || horseSideName(game.value.turn)} 行棋`;
});
const resultText = computed(() => {
  if (game.value.status !== 'finished') return '';
  if (game.value.endReason === 'draw') return '双方同意和棋。';
  if (!mySide.value) return game.value.winner ? `${horseSideName(game.value.winner)}获胜` : '本局结束';
  return game.value.winner === mySide.value ? '马踏帅位，胜局已定。' : '本局落败，可以再来一局。';
});

const px = (x: number) => 50 + x * 55;
const py = (y: number) => 50 + y * 55;
const viewX = (x: number) => px(flipped.value ? 8 - x : x);
const viewY = (y: number) => py(flipped.value ? 9 - y : y);
const coordinate = (point: HorsePoint) => `(${point.x + 1}, ${point.y + 1})`;
const targetAt = (point: HorsePoint) => horsePieceAt(game.value.pieces, point);
const goalAt = (point: HorsePoint) => (['red', 'black'] as HorseSide[])
  .map(side => ({ side, goal: HORSE_GOALS[side] }))
  .find(item => item.goal.x === point.x && item.goal.y === point.y) ?? null;
const topSide = computed<HorseSide>(() => flipped.value ? 'red' : 'black');
const bottomSide = computed<HorseSide>(() => otherHorseSide(topSide.value));
const sidePlayer = (side: HorseSide) => roomState.value?.players.find(player => player.side === side) ?? null;
const avatarFor = (side: HorseSide) => backendAssetUrl(sidePlayer(side)?.avatar) || (sidePlayer(side) ? guestAvatar : null);
const sideLabel = (side: HorseSide) => horseSideName(side);
const pieceLabel = (piece: HorsePiece) => `${horseSideName(piece.side)}马，${piece.x + 1} 路第 ${piece.y + 1} 线`;
const playerState = (side: HorseSide) => {
  const player = sidePlayer(side);
  if (!player) return roomState.value?.phase === 'lobby' ? '等待棋友' : '未入座';
  if (roomState.value?.phase === 'lobby') return player.ready ? '已准备' : '未准备';
  if (!player.online) return '离线';
  if (roomState.value?.phase === 'finished') return !game.value.winner ? '和棋' : game.value.winner === side ? '胜利' : '失败';
  return game.value.turn === side ? '行棋中' : '对局中';
};
const canSeat = (side: HorseSide) => !session.value && roomState.value?.phase === 'lobby'
  && roomState.value.players.length < 2 && !sidePlayer(side);
const canWatchTable = computed(() => !session.value && !watching.value
  && (roomState.value?.phase === 'playing' || roomState.value?.phase === 'finished'));
const drawOfferBy = computed(() => roomState.value?.drawOfferBy ?? null);
const canRespondDraw = computed(() => !!session.value && roomState.value?.phase === 'playing'
  && !!drawOfferBy.value && drawOfferBy.value !== mySide.value);

function saveSession(receipt: HorseReceipt): boolean {
  if (!receipt || receipt.gameId !== HORSE_CHESS_GAME_ID || receipt.playerId !== receipt.state.selfId)
    return false;
  session.value = { reconnectToken: receipt.reconnectToken, playerId: receipt.playerId };
  localStorage.setItem(HORSE_CHESS_SESSION_KEY, JSON.stringify(session.value));
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
  localStorage.removeItem(HORSE_CHESS_SESSION_KEY);
}

function acceptState(next: HorseState) {
  if (!next || next.gameId !== HORSE_CHESS_GAME_ID) return;
  if (session.value && next.selfId === session.value.playerId) {
    if (state.value && next.version < state.value.version) return;
    state.value = next;
    inspected.value = next;
    return;
  }
  if (!session.value && next.selfId === null) inspected.value = next;
}

function emitAck<T>(event: string, payload: unknown, timeoutMs = 6000): Promise<HorseAck<T>> {
  return new Promise(resolve => {
    if (!socket?.connected) {
      resolve({ ok: false, code: 'OFFLINE', error: '尚未连接服务器，请稍后重试。' });
      return;
    }
    socket.timeout(timeoutMs).emit(event, payload, (timeout: Error | null, ack: HorseAck<T>) => {
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
    const ack = await emitAck<HorseReceipt>('horse:resume', { reconnectToken: saved.reconnectToken });
    if (attempt !== resumeAttempt || session.value?.reconnectToken !== saved.reconnectToken) return;
    if (ack.ok) saveSession(ack.data);
    else if (ack.code === 'SESSION_NOT_FOUND') {
      clearSession();
      const watched = await emitAck<HorseState>('horse:watch', {});
      if (watched.ok) inspected.value = watched.data;
    } else error.value = ack.error;
    return;
  }
  const ack = await emitAck<HorseState>('horse:watch', {});
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
  socket.on('connect', () => {
    connection.value = 'online';
    void recover();
  });
  socket.on('disconnect', () => { connection.value = 'offline'; });
  socket.on('connect_error', () => { connection.value = 'offline'; });
  socket.on('horse:state', acceptState);
  socket.on('horse:session-replaced', () => {
    clearSession();
    error.value = '席位已在另一页面恢复，本页已停止联机。';
  });
  socket.connect();
}

function openSeat(side: HorseSide) {
  if (busy.value || !canSeat(side)) return;
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
  if (!guestName.value.trim()) {
    error.value = '请输入昵称。';
    return;
  }
  void joinSeat(pendingSide.value, guestName.value.trim());
}

async function joinSeat(side: HorseSide, nickname: string) {
  if (busy.value || !canSeat(side)) return;
  error.value = ''; notice.value = '';
  if (!await ensureConnected()) {
    error.value = '暂时无法连接服务器，请稍后重试。';
    return;
  }
  busy.value = true;
  try {
    const ack = await emitAck<HorseReceipt>('horse:join', {
      nickname, side,
    });
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
  busy.value = true;
  try {
    const ack = await emitAck<{ state: HorseState }>('horse:ready', {
      reconnectToken: session.value.reconnectToken, ready,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally { busy.value = false; }
}

async function move(pieceId: string, to: HorsePoint) {
  if (!session.value || busy.value || game.value.status !== 'playing') return;
  const intent: HorseMoveIntent = {
    requestId: `horse-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`,
    version: state.value?.version ?? 0,
    pieceId,
    to,
  };
  busy.value = true;
  try {
    const ack = await emitAck<{ state: HorseState }>('horse:move', {
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

function clickPoint(point: HorsePoint) {
  if (roomState.value?.phase !== 'playing' || !isMyTurn.value) return;
  const piece = targetAt(point);
  if (piece?.side === mySide.value) {
    selectedId.value = selectedId.value === piece.id ? null : piece.id;
    return;
  }
  if (!selected.value) return;
  if (moves.value.some(item => item.x === point.x && item.y === point.y))
    void move(selected.value.id, point);
  else error.value = '马走日字，且马腿不能有棋子。';
}

async function resign() {
  if (!session.value || busy.value) return;
  resignDialog.value?.close();
  busy.value = true;
  try {
    const ack = await emitAck<{ state: HorseState }>('horse:resign', {
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
    const ack = await emitAck<{ state: HorseState }>('horse:rematch', {
      reconnectToken: session.value.reconnectToken,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally { busy.value = false; }
}

function openSpectator() {
  if (!canWatchTable.value) return;
  watching.value = true;
  selectedId.value = null;
}

async function returnToTable(): Promise<void> {
  if (!session.value) await emitAck('horse:unwatch', {});
  watching.value = false;
  menuOpen.value = false;
}

async function requestDraw() {
  if (!session.value || busy.value) return;
  menuOpen.value = false;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: HorseState }>('horse:draw-offer', {
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
    const ack = await emitAck<{ state: HorseState }>('horse:draw-respond', {
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
    if (connection.value === 'online') await emitAck('horse:leave', { reconnectToken: saved.reconnectToken }, 3500);
  } finally {
    busy.value = false;
    clearSession();
    watching.value = false;
    menuOpen.value = false;
    const watched = await emitAck<HorseState>('horse:watch', {});
    if (watched.ok) inspected.value = watched.data;
  }
}

async function leaveForNavigation(): Promise<void> {
  const saved = session.value;
  if (!saved) return;
  if (connection.value === 'online') await emitAck('horse:leave', { reconnectToken: saved.reconnectToken }, 3500);
  clearSession();
}

function requestLeave() {
  if (roomState.value?.phase === 'playing') leaveDialog.value?.showModal();
  else void leaveRoom();
}

async function copyInvite() {
  const link = appRouteUrl(location.href, 'horse');
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

watch(mySide, side => {
  if (side) flipped.value = side === 'black';
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
});

defineExpose({ leaveForNavigation, openSeat });
</script>

<template>
  <main class="horse-page" :data-connection="connection">
    <div class="horse-page-nav">
      <button class="plain-button" type="button" @click="emit('other')">← 其他玩法</button>
      <span v-if="myPlayer" class="horse-side-chip" :class="myPlayer.side">{{ sideLabel(myPlayer.side) }}</span>
    </div>
    <header class="horse-heading">
      <div><span class="eyebrow">NINE HORSES</span><h1>马棋</h1></div>
      <p>双方各九马。马走日且受马腿阻挡，先踏入对方中央帅位的一方获胜。</p>
    </header>

    <p v-if="connection !== 'online'" class="connection-note" :class="{ error: !!error }">{{ error || '正在连接棋桌…' }}</p>
    <p v-else-if="error" class="connection-note error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="connection-note" role="status">{{ notice }}</p>

    <OtherGameTable v-if="showTableView" title="马棋" eyebrow="NINE HORSES"
      :phase="roomState?.phase ?? 'lobby'" :players="roomState?.players ?? []" :busy="busy || !roomState"
      @seat="openSeat" @watch="openSpectator" />

    <template v-else>
    <article class="horse-table-seat opponent-seat" :class="[topSide, { ready: sidePlayer(topSide)?.ready, active: roomState?.phase === 'playing' && game.turn === topSide }]">
      <span class="horse-seat-avatar" :class="{ placeholder: !sidePlayer(topSide) }">
        <img v-if="avatarFor(topSide)" :src="avatarFor(topSide)!" alt="">
        <template v-else>馬</template>
      </span>
      <span class="horse-seat-copy"><strong>{{ sidePlayer(topSide)?.nickname || '等待棋友' }}</strong><small>{{ sideLabel(topSide) }}席位</small></span>
      <em>{{ playerState(topSide) }}</em>
    </article>

    <section class="horse-game-layout">
      <div class="horse-board-column">
        <div class="game-board-menu-row">
          <button v-if="!session" class="tool-button board-back-to-table" type="button" @click="returnToTable">← 返回棋桌</button>
          <div v-else class="game-action-menu">
            <button class="game-action-menu-toggle" type="button" :aria-expanded="menuOpen" aria-label="打开对局菜单" @click="menuOpen = !menuOpen">‹</button>
            <div v-if="menuOpen" class="game-action-menu-list">
              <button type="button" :disabled="roomState?.phase !== 'playing' || !!drawOfferBy" @click="requestDraw">提和</button>
              <button type="button" :disabled="roomState?.phase !== 'playing'" @click="menuOpen = false; resignDialog?.showModal()">认输</button>
              <button type="button" :disabled="busy" @click="menuOpen = false; requestLeave()">离开</button>
            </div>
          </div>
          <span v-if="session" class="game-board-role">{{ sideLabel(mySide!) }}方</span>
        </div>
        <div class="horse-board-heading"><h2>{{ boardTitle }}</h2><span>{{ roomState?.phase === 'lobby' ? '等待开局' : `第 ${game.history.length} 手` }}</span></div>
        <div class="board-frame horse-board-frame">
          <svg class="board-svg horse-board-svg" :class="{ playable: roomState?.phase === 'playing' && isMyTurn }" viewBox="0 0 540 595" role="group" :aria-label="`马棋棋盘，${flipped ? '黑方' : '红方'}视角`">
            <defs><linearGradient id="horse-wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#efdab4"/><stop offset="1" stop-color="#e5c897"/></linearGradient><marker id="horse-trail-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a77b36"/></marker></defs>
            <rect x="8" y="8" width="524" height="579" rx="8" fill="url(#horse-wood)"/>
            <rect x="37" y="37" width="466" height="521" fill="none" stroke="#674d2f" stroke-width="1.4"/>
            <g class="grid-lines"><line v-for="n in 10" :key="`h${n}`" :x1="px(0)" :x2="px(8)" :y1="py(n-1)" :y2="py(n-1)"/><template v-for="n in 9" :key="`v${n}`"><line :x1="px(n-1)" :x2="px(n-1)" :y1="py(0)" :y2="py(4)"/><line :x1="px(n-1)" :x2="px(n-1)" :y1="py(5)" :y2="py(9)"/></template><line :x1="px(0)" :x2="px(0)" :y1="py(4)" :y2="py(5)"/><line :x1="px(8)" :x2="px(8)" :y1="py(4)" :y2="py(5)"/></g>
            <g class="coordinates"><text v-for="n in 9" :key="n" :x="px(n-1)" y="25">{{ flipped ? 10 - n : n }}</text><text v-for="n in 10" :key="`row${n}`" x="24" :y="py(n-1)+4">{{ flipped ? 11 - n : n }}</text></g>
            <text class="river" x="175" y="305">{{ flipped ? '汉 界' : '楚 河' }}</text><text class="river" x="365" y="305">{{ flipped ? '楚 河' : '汉 界' }}</text>
            <g v-for="side in (['red', 'black'] as const)" :key="`goal-${side}`" class="horse-goal" :class="side"><rect :x="viewX(HORSE_GOALS[side].x)-20" :y="viewY(HORSE_GOALS[side].y)-20" width="40" height="40" rx="5"/><text :x="viewX(HORSE_GOALS[side].x)" :y="viewY(HORSE_GOALS[side].y)+1">{{ HORSE_GOALS[side].label }}</text></g>
            <g v-if="latest" class="last-trail" aria-hidden="true"><line :x1="viewX(latest.from.x)" :y1="viewY(latest.from.y)" :x2="viewX(latest.to.x)" :y2="viewY(latest.to.y)" marker-end="url(#horse-trail-tip)"/><rect :x="viewX(latest.from.x)-18" :y="viewY(latest.from.y)-18" width="36" height="36" rx="4"/><circle :cx="viewX(latest.to.x)" :cy="viewY(latest.to.y)" r="26"/></g>
            <g v-for="point in moves" :key="`${point.x},${point.y}`" class="horse-target" role="button" tabindex="0"
              :aria-label="`${targetAt(point) ? '吃子到' : '走到'}第${point.x+1}路第${point.y+1}线`"
              @click.stop="clickPoint(point)" @keydown.enter.prevent.stop="clickPoint(point)" @keydown.space.prevent.stop="clickPoint(point)">
              <circle :cx="viewX(point.x)" :cy="viewY(point.y)" r="23" fill="transparent"/><circle :cx="viewX(point.x)" :cy="viewY(point.y)" :r="targetAt(point) ? 27 : 6" :class="targetAt(point) ? 'capture-ring' : 'move-dot'"/>
            </g>
            <g v-for="piece in game.pieces" :key="piece.id" class="horse-piece" :class="[piece.side, { selected: selectedId === piece.id }]"
              :style="{transform: `translate(${viewX(piece.x)}px, ${viewY(piece.y)}px)`}" role="button" tabindex="0"
              :aria-disabled="roomState?.phase !== 'playing' || !isMyTurn" :aria-label="pieceLabel(piece)" @click.stop="clickPoint(piece)" @keydown.enter.prevent.stop="clickPoint(piece)">
              <circle class="horse-selection-ring" r="27"/><circle class="horse-piece-shadow" cy="2.5" r="23"/><circle class="horse-piece-face" r="23"/><circle class="horse-piece-rim" r="19.5"/><text y="1">馬</text>
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
        <article class="horse-table-seat self-seat" :class="[bottomSide, { ready: sidePlayer(bottomSide)?.ready, active: roomState?.phase === 'playing' && game.turn === bottomSide, self: mySide === bottomSide }]">
          <span class="horse-seat-avatar" :class="{ placeholder: !sidePlayer(bottomSide) }">
            <img v-if="avatarFor(bottomSide)" :src="avatarFor(bottomSide)!" alt="">
            <template v-else>馬</template>
          </span>
          <span class="horse-seat-copy"><strong>{{ sidePlayer(bottomSide)?.nickname || '等待棋友' }}</strong><small>{{ sideLabel(bottomSide) }}席位</small></span>
          <em>{{ playerState(bottomSide) }}</em>
        </article>
        <div v-if="drawOfferBy && roomState?.phase === 'playing'" class="draw-offer-bar">
          <span>{{ drawOfferBy === mySide ? '已提和，等待对手回应。' : `${sideLabel(drawOfferBy)}提出和棋。` }}</span>
          <div v-if="canRespondDraw">
            <button type="button" :disabled="busy" @click="respondDraw(true)">同意</button>
            <button type="button" :disabled="busy" @click="respondDraw(false)">拒绝</button>
          </div>
        </div>
        <div class="board-tools horse-table-actions">
          <button class="tool-button" type="button" @click="flipped = !flipped">翻转棋盘</button>
          <button v-if="session && roomState?.phase === 'finished'" class="primary-button" type="button" :disabled="busy || connection !== 'online'" @click="rematch">再来一局</button>
        </div>
        <textarea v-if="inviteVisible" class="horse-invite-text" :value="inviteText" readonly rows="2" aria-label="马棋邀请链接" @focus="selectInvite"></textarea>
        <div v-if="roomState?.phase === 'finished'" class="result-banner"><strong>{{ resultText }}</strong><span>{{ mySide && game.winner ? `${horseSideName(game.winner)}踏入帅位获胜` : '本局已结束' }}</span></div>
      </div>

      <aside class="horse-history horse-table-aside">
        <div class="horse-history-heading"><strong>行棋记录</strong><span>{{ game.history.length }} 手</span></div>
        <div v-if="latest" class="last-move-card"><span class="eyebrow">上一步</span><h3 :class="latest.side">{{ horseSideName(latest.side) }} · 马</h3><p>{{ coordinate(latest.from) }} → {{ coordinate(latest.to) }}</p><small>{{ latest.captured ? `吃掉${horseSideName(latest.captured.side)}马` : '已标记起点和落点' }}</small></div>
        <ol v-if="history.length" class="move-list"><li v-for="record in history" :key="record.number"><span class="record-number">{{ String(record.number).padStart(2, '0') }}</span><div><strong :class="record.side">{{ horseSideName(record.side) }}</strong><p>马 {{ coordinate(record.from) }} → {{ coordinate(record.to) }}</p><small v-if="record.captured">吃掉{{ horseSideName(record.captured.side) }}马</small></div></li></ol>
        <div v-else class="empty-history"><span aria-hidden="true">馬</span><p>{{ roomState?.phase === 'lobby' ? '双方准备后开始棋局。' : '暂无行棋记录。' }}</p></div>
        <details class="horse-live-rules"><summary>玩法说明</summary><p>双方各九马，马走日且受马腿阻挡；先进入对方中央底线帅位的一方获胜。</p></details>
      </aside>
    </section>
    </template>

    <dialog ref="resignDialog" class="reset-dialog"><h2>确认认输？</h2><p>本局立即判负，仍可留在房间查看结果。</p><div class="dialog-actions"><button class="tool-button" type="button" @click="resignDialog?.close()">继续对局</button><button class="primary-button" type="button" @click="resign">确认认输</button></div></dialog>
    <dialog ref="leaveDialog" class="reset-dialog"><h2>退出马棋？</h2><p>对局进行中离开会按认输结算，席位立即释放。</p><div class="dialog-actions"><button class="tool-button" type="button" @click="leaveDialog?.close()">继续对局</button><button class="primary-button" type="button" @click="leaveRoom">确认退出</button></div></dialog>
    <dialog ref="seatDialog" class="horse-seat-dialog" @cancel.prevent="seatDialog?.close()">
      <form @submit.prevent="confirmGuestSeat">
        <div class="dialog-heading"><h2>入座 {{ pendingSide ? sideLabel(pendingSide) : '' }}</h2><button class="dialog-close" type="button" aria-label="关闭" @click="seatDialog?.close()">×</button></div>
        <label>昵称：<input v-model="guestName" maxlength="16" autocomplete="nickname" aria-label="座位昵称"></label>
        <p v-if="error" class="connection-note error" role="alert">{{ error }}</p>
        <div class="dialog-actions"><button class="tool-button" type="button" @click="seatDialog?.close()">取消</button><button class="primary-button" type="submit" :disabled="busy || connection !== 'online'">入座</button></div>
      </form>
    </dialog>
  </main>
</template>

<style scoped>
.horse-page{width:min(1180px,100%);margin:0 auto;padding:24px 0 54px;--horse-red:#a64b3c;--horse-black:#343e48;--horse-line:#d8c7aa}
.horse-page-nav{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;padding-bottom:13px;border-bottom:1px solid #ded2c1}
.horse-page-nav .plain-button{font-size:15px;font-weight:600;color:#5b4d3e}
.horse-side-chip{padding:4px 10px;border:1px solid #d7c6ab;border-radius:999px;background:#fffaf0;color:#745e3f;font-size:10px;font-weight:700}
.horse-side-chip.red{color:var(--horse-red);border-color:#d5a79e}.horse-side-chip.black{color:var(--horse-black);border-color:#afb5bb}
.horse-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}
.horse-heading h1{margin:5px 0 0;font:700 42px/1.15 "Songti SC","SimSun",serif;letter-spacing:4px;color:#3c332a}
.horse-heading p{max-width:430px;margin:0 0 5px;color:#7e6e5b;font-size:12px;line-height:1.8;text-align:right}
.horse-entry-card,.horse-waiting{padding:28px;border:1px solid var(--horse-line);border-radius:18px;background:linear-gradient(150deg,#fffef9,#fbf5e9);box-shadow:0 18px 44px #59432310}
.horse-seat-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.horse-seat-option{--side:#a64b3c;--soft:#faeee9;display:grid;grid-template-columns:48px minmax(0,1fr) auto;align-items:center;gap:11px;min-height:84px;padding:12px 14px;border:1px solid #d6c6b0;border-radius:12px;background:#fffdf8;color:#4f4438;text-align:left;transition:border-color .16s ease,background .16s ease,transform .16s ease,box-shadow .16s ease}
.horse-seat-option.black{--side:#343e48;--soft:#f0f2f3}
.horse-seat-option:hover:not(:disabled):not(.selected){border-color:var(--side);background:var(--soft);transform:translateY(-1px)}
.horse-seat-option.selected{border-color:var(--side);background:var(--soft);box-shadow:inset 0 0 0 1px var(--side)}
.horse-seat-option.occupied,.horse-seat-option:disabled{opacity:.58;cursor:not-allowed}
.horse-seat-option:focus-visible,.horse-entry-field input:focus-visible,.horse-enter-button:focus-visible,.horse-waiting-actions button:focus-visible{outline:2px solid #8c6d37;outline-offset:2px}
.horse-piece-preview,.horse-player-seal{display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--side,#a64b3c);border-radius:50%;background:#fffdf8;color:var(--side,#a64b3c);font:700 24px/1 "STKaiti","KaiTi",serif;box-shadow:inset 0 0 0 3px #fff8e8}
.horse-seat-option.selected .horse-piece-preview{background:var(--side);color:#fff8e9;box-shadow:inset 0 0 0 2px #fff4df4d}
.horse-seat-option>span:nth-child(2){display:grid;gap:3px;min-width:0}
.horse-seat-option strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 18px/1.25 "Songti SC","SimSun",serif}
.horse-seat-option small{color:#8b7b67;font-size:10px}
.horse-seat-option em{padding:3px 7px;border-radius:999px;background:#eee6da;color:#7c6c59;font-size:9px;font-style:normal;white-space:nowrap}
.horse-entry-field{display:grid;gap:7px;margin-top:18px;color:#615344;font-size:13px;font-weight:600}
.horse-entry-field input{height:46px;border:1px solid #d8cab5;border-radius:9px;background:#fffefb;padding:0 13px;color:#3f352b;font:500 15px/1 inherit;outline:none}
.horse-entry-field input:focus{border-color:#a78147;box-shadow:0 0 0 3px #a7814718}
.horse-account-name{margin-top:18px;padding:11px 13px;border:1px solid #e0d4c1;border-radius:9px;background:#f7f1e7;color:#776856;font-size:12px}
.horse-account-name strong{margin-left:5px;color:#4b3d2f}
.horse-enter-button{width:100%;height:48px;margin-top:18px;font-size:14px;font-weight:700;letter-spacing:.08em}
.horse-rules{margin-top:20px;padding-top:15px;border-top:1px solid #e1d6c5;color:#776857;font-size:12px;line-height:1.8}
.horse-rules summary,.horse-live-rules summary{cursor:pointer;font-weight:600;color:#715b3c}
.horse-rules ul{margin:10px 0 0;padding-left:20px}
.horse-waiting-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.horse-waiting-heading h2{margin:4px 0 0;font:700 26px/1.2 "Songti SC","SimSun",serif}
.horse-waiting-actions{display:grid;grid-template-columns:minmax(150px,240px) auto;justify-content:end;gap:10px;margin-top:20px}
.horse-waiting-actions button{min-height:44px}
.horse-waiting textarea{width:100%;margin-top:16px;padding:10px 12px;border:1px solid #d8cab5;border-radius:8px;background:#fffefb;color:#5a4c3d;font:500 12px/1.6 ui-monospace,Consolas,monospace;resize:none}
.horse-match-top{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:16px}
.horse-player-card{--side:#a64b3c;display:flex;align-items:center;gap:12px;min-width:0;padding:12px 14px;border:1px solid #ddd0bd;border-radius:11px;background:#fffdf8}
.horse-player-card.black{--side:#343e48}
.horse-player-card.active{border-color:var(--side);box-shadow:inset 3px 0 var(--side),0 7px 18px #5943230d}
.horse-player-seal{--side:inherit;flex:none;width:42px;height:42px;font-size:21px}
.horse-player-card.red .horse-player-seal{color:var(--horse-red);border-color:var(--horse-red)}.horse-player-card.black .horse-player-seal{color:var(--horse-black);border-color:var(--horse-black)}
.horse-player-card>div{display:grid;gap:3px;min-width:0}.horse-player-card strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 19px/1.2 "Songti SC","SimSun",serif}.horse-player-card small{margin-left:auto;color:#8a7b68;font-size:10px}.horse-player-card em{padding:3px 7px;border-radius:999px;background:#f0e7da;color:#765f3e;font-size:9px;font-style:normal;white-space:nowrap}
.horse-game-layout{display:grid;grid-template-columns:minmax(0,1fr) 250px;align-items:start;gap:20px}.horse-board-column,.horse-history{min-width:0}
.horse-board-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.horse-board-heading h2{margin:0;font-size:21px;color:#3f352b}.horse-board-heading span{padding:5px 10px;border:1px solid #d8cab5;border-radius:999px;background:#fffdf8;color:#847461;font-size:10px}.horse-board-frame{max-width:680px;margin:0 auto}
.horse-goal rect{fill:#f6e8ca;stroke:#a78147;stroke-width:1.4;stroke-dasharray:4 3}.horse-goal text{text-anchor:middle;dominant-baseline:central;fill:#886633;font:700 18px "STKaiti","KaiTi",serif;pointer-events:none}.horse-goal.black rect{fill:#ece5d8;stroke:#5f6570}.horse-goal.black text{fill:#4d5662}
.horse-piece{cursor:pointer;transition:transform .18s ease;outline-offset:1px}.horse-piece-shadow{fill:#603f3270}.horse-piece-face{stroke-width:1.6;filter:drop-shadow(0 2px 2px #0002)}.horse-piece.red .horse-piece-face{fill:#b6503e;stroke:#83392e}.horse-piece.black .horse-piece-face{fill:#343e48;stroke:#202b36}.horse-piece-rim{fill:none;stroke:#fff3d9;stroke-width:.8;opacity:.52}.horse-piece text{text-anchor:middle;dominant-baseline:central;fill:#fff6e3;font:29px "STKaiti","KaiTi","Songti SC",serif;pointer-events:none}.horse-selection-ring{fill:none;stroke:#fffaf0;stroke-width:3;opacity:0}.horse-piece.selected .horse-selection-ring{opacity:1;filter:drop-shadow(0 0 2px #805c28)}.horse-target{cursor:pointer}
.horse-history{padding:16px;border:1px solid #ddd0bd;border-radius:12px;background:#fffdf8}.horse-history-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px;color:#645647;font-size:12px}.horse-history-heading span{color:#94846f;font-size:10px}.horse-history .last-move-card{padding:14px}.horse-history h3.red,.horse-history strong.red{color:var(--horse-red)}.horse-history h3.black,.horse-history strong.black{color:var(--horse-black)}.horse-history .move-list{margin-top:13px;max-height:420px;overflow:auto}.horse-history .empty-history{display:block;padding:24px 8px;text-align:center;border:0}.horse-live-rules{margin-top:16px;padding-top:13px;border-top:1px solid #e4d9ca;color:#7e705f;font-size:11px;line-height:1.7}.horse-live-rules p{margin:8px 0 0}.horse-page .result-banner{margin-top:12px}
@media(max-width:860px){.horse-game-layout{grid-template-columns:1fr}.horse-history{margin-top:4px}.horse-history .move-list{max-height:260px}}
@media(max-width:640px){.horse-page{padding-top:16px}.horse-heading{display:block;margin-bottom:17px}.horse-heading h1{font-size:34px;letter-spacing:3px}.horse-heading p{margin-top:8px;text-align:left;font-size:11px}.horse-entry-card,.horse-waiting{padding:17px;border-radius:14px}.horse-seat-picker{grid-template-columns:1fr}.horse-seat-option{min-height:70px}.horse-seat-option strong{font-size:16px}.horse-waiting-heading{align-items:flex-start}.horse-waiting-heading h2{font-size:22px}.horse-waiting-actions{grid-template-columns:1fr 1fr}.horse-waiting-actions button{width:100%}.horse-match-top{gap:7px}.horse-player-card{padding:9px 10px;gap:8px}.horse-player-seal{width:35px;height:35px;font-size:18px}.horse-player-card strong{font-size:14px}.horse-player-card small{display:none}.horse-player-card em{padding:2px 5px;font-size:8px}.horse-board-heading h2{font-size:18px}.horse-history{padding:13px}.board-tools{flex-wrap:wrap}.board-tools button{flex:1 1 auto}}
.horse-heading{align-items:center;margin-bottom:18px}.horse-heading p{max-width:520px}.horse-game-layout{gap:18px}.horse-board-column{display:grid;grid-template-columns:minmax(0,1fr);gap:10px}.horse-board-column>.horse-board-frame{width:100%;max-width:660px}.horse-table-seat{--seat-color:#a64b3c;display:flex;align-items:center;gap:12px;width:min(660px,100%);min-height:62px;margin:0 auto;padding:9px 13px;border:1px solid #d6c7b3;border-radius:12px;background:linear-gradient(145deg,#fffdf8,#f8f2e8);color:#4d4236;text-align:left;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}.horse-table-seat.black{--seat-color:#343e48}.horse-table-seat.opponent-seat{margin-bottom:12px}.horse-table-seat.self-seat{margin-top:2px}.horse-table-seat.active{border-color:var(--seat-color);box-shadow:inset 3px 0 var(--seat-color),0 7px 18px #59432310}.horse-table-seat.empty{border-style:dashed;background:#f3eee5;cursor:pointer}.horse-table-seat.empty:hover:not(:disabled){border-color:#aa8a5a;background:#faf4e8;transform:translateY(-1px)}.horse-table-seat:disabled{opacity:1;cursor:default}.horse-table-seat.self{border-color:color-mix(in srgb,var(--seat-color) 55%,#d6c7b3)}.horse-table-seat.ready>em{background:#e4efe4;color:#39704b}.horse-table-seat.active .horse-seat-avatar{box-shadow:inset 0 0 0 3px #fff4df66,0 0 0 4px color-mix(in srgb,var(--seat-color) 18%,transparent)}.horse-seat-avatar{display:grid;place-items:center;width:44px;height:44px;flex:none;border:1px solid var(--seat-color);border-radius:50%;background:var(--seat-color);color:#fff8e8;font:700 23px/1 "STKaiti","KaiTi",serif;box-shadow:inset 0 0 0 3px #fff4df4d}.horse-seat-avatar.placeholder{border-color:#c8bbab;background:#e7e1d7;color:#9c9080;box-shadow:none}.horse-seat-copy{display:grid;gap:2px;min-width:0;flex:1}.horse-seat-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 18px/1.3 "Songti SC","SimSun",serif}.horse-seat-copy small{color:#8c7d6a;font-size:10px}.horse-table-seat.empty .horse-seat-copy strong{color:#8f8372;font-weight:600}.horse-table-seat>em{padding:3px 8px;border-radius:999px;background:#eee6da;color:#786a58;font-size:9px;font-style:normal;white-space:nowrap}.horse-board-heading{width:min(660px,100%);margin:0 auto 12px;padding:0 2px}.horse-board-heading h2{font:700 20px/1.25 "Songti SC","SimSun",serif}.horse-board-svg:not(.playable) .horse-piece{cursor:default}.horse-table-actions{justify-content:center;flex-wrap:wrap;padding:2px 0 4px}.horse-table-actions>button{min-height:42px}.horse-table-actions .primary-button{min-width:130px;padding-inline:22px}.horse-invite-text{width:min(660px,100%);margin:0 auto;padding:9px 11px;border:1px solid #d8cab5;border-radius:8px;background:#fffefb;color:#625444;font:500 11px/1.55 ui-monospace,Consolas,monospace;resize:none}.horse-table-aside{position:sticky;top:16px}.horse-seat-dialog{width:min(380px,calc(100vw - 32px));padding:24px;border:1px solid #d6c5aa;border-radius:14px;background:#fffaf0;color:#493d31;box-shadow:0 24px 70px #3d2d1a33}.horse-seat-dialog::backdrop,.horse-page .reset-dialog::backdrop{background:#372c204f;backdrop-filter:blur(2px)}.horse-seat-dialog form{display:grid;gap:16px}.horse-seat-dialog h2{font:700 22px/1.25 "Songti SC","SimSun",serif}.horse-seat-dialog label{display:grid;gap:7px;color:#615344;font:600 14px/1.2 "Songti SC","SimSun",serif}.horse-seat-dialog input{height:46px;border:1px solid #d8cab5;border-radius:9px;background:#fffefb;padding:0 13px;color:#3f352b;font:500 16px/1 inherit;outline:none}.horse-seat-dialog input:focus{border-color:#a78147;box-shadow:0 0 0 3px #a7814718}.horse-seat-dialog .connection-note{margin:0!important}.horse-seat-dialog .dialog-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}.horse-seat-dialog .dialog-actions button{min-height:44px}.horse-table-seat:focus-visible,.horse-table-actions button:focus-visible,.horse-seat-dialog button:focus-visible{outline:3px solid #9c7f43;outline-offset:3px}
@media(max-width:860px){.horse-table-aside{position:static}.horse-history{margin-top:0}}
@media(max-width:640px){.horse-page{padding:14px 0 38px}.horse-page-nav{margin-bottom:14px}.horse-heading p{display:none}.horse-heading h1{font-size:31px}.horse-board-heading h2{font-size:17px}.horse-board-heading span{padding:4px 8px;font-size:9px}.horse-table-seat{min-height:58px;padding:8px 10px;gap:9px}.horse-seat-avatar{width:38px;height:38px;font-size:20px}.horse-seat-copy strong{font-size:15px}.horse-table-seat>em{max-width:74px;overflow:hidden;text-overflow:ellipsis;font-size:8px}.horse-table-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.horse-table-actions>button{width:100%;min-height:44px;margin:0}.horse-table-actions .primary-button{min-width:0}.horse-history{padding:12px}.horse-invite-text{font-size:10px}.horse-seat-dialog{padding:20px}}
.horse-seat-avatar{border-radius:9px;overflow:hidden}.horse-seat-avatar img{width:100%;height:100%;object-fit:cover}
</style>
