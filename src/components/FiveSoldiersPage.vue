<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { io, type Socket } from 'socket.io-client';
import {
  FIVE_SOLDIERS_GAME_ID,
  FIVE_SOLDIERS_SESSION_KEY,
  fivePieceAt,
  fivePieceName,
  fiveSideName,
  legalFiveMoves,
  newFiveGame,
  otherFiveSide,
} from '../five-soldiers.ts';
import type {
  FiveAck,
  FiveGame,
  FiveMoveIntent,
  FivePiece,
  FivePoint,
  FiveReceipt,
  FiveSide,
  FiveState,
} from '../five-soldiers.ts';
import { appRouteUrl } from '../navigation.ts';

const props = defineProps<{ accountName: string | null }>();
const emit = defineEmits<{ other: [] }>();

interface SavedSession {
  reconnectToken: string;
  playerId: string;
}

function loadSession(): SavedSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(FIVE_SOLDIERS_SESSION_KEY) || 'null') as Partial<SavedSession> | null;
    return value && typeof value.reconnectToken === 'string' && typeof value.playerId === 'string'
      ? value as SavedSession : null;
  } catch { return null; }
}

const session = ref<SavedSession | null>(loadSession());
const state = ref<FiveState | null>(null);
const inspected = ref<FiveState | null>(null);
const connection = ref<'offline' | 'connecting' | 'online'>('offline');
const busy = ref(false), error = ref(''), notice = ref('');
const guestName = ref(''), selectedSide = ref<FiveSide>('red');
const selectedId = ref<string | null>(null), flipped = ref(false);
const inviteVisible = ref(false), inviteText = ref('');
const resignDialog = ref<HTMLDialogElement | null>(null), leaveDialog = ref<HTMLDialogElement | null>(null);
let socket: Socket | null = null;
let resumeAttempt = 0;

const game = computed<FiveGame>(() => state.value?.game ?? newFiveGame());
const myPlayer = computed(() => state.value?.players.find(player => player.id === state.value?.selfId) ?? null);
const opponent = computed(() => state.value?.players.find(player => player.id !== state.value?.selfId) ?? null);
const mySide = computed(() => myPlayer.value?.side ?? null);
const isMyTurn = computed(() => game.value.status === 'playing' && !!mySide.value && game.value.turn === mySide.value);
const selected = computed(() => selectedId.value ? game.value.pieces.find(piece => piece.id === selectedId.value) ?? null : null);
const moves = computed(() => selected.value ? legalFiveMoves(game.value.pieces, selected.value) : []);
const latest = computed(() => game.value.lastMove);
const history = computed(() => game.value.history.slice(-20).reverse());
const boardTitle = computed(() => {
  if (game.value.status === 'finished') {
    if (!game.value.winner || !mySide.value) return '本局结束';
    return game.value.winner === mySide.value ? '你获胜' : '你失败';
  }
  const active = state.value?.players.find(player => player.side === game.value.turn);
  return `轮到 ${active?.nickname || fiveSideName(game.value.turn)} 行棋`;
});
const turnBudget = computed(() => game.value.status === 'playing'
  ? `${fiveSideName(game.value.turn)}本回合还可走 ${game.value.movesRemaining} 步`
  : '');
const selectedAvailable = computed(() => {
  if (!inspected.value || inspected.value.phase !== 'lobby') return false;
  const occupied = inspected.value?.players.some(player => player.side === selectedSide.value) ?? false;
  return !occupied && (inspected.value?.players.length ?? 0) < 2;
});

const px = (x: number) => 50 + x * 55;
const py = (y: number) => 50 + y * 55;
const viewX = (x: number) => px(flipped.value ? 8 - x : x);
const viewY = (y: number) => py(flipped.value ? 9 - y : y);
const coordinate = (point: FivePoint) => `(${point.x + 1}, ${point.y + 1})`;
const targetAt = (point: FivePoint) => fivePieceAt(game.value.pieces, point);
const sidePlayer = (side: FiveSide) => state.value?.players.find(player => player.side === side) ?? null;
const examinedSidePlayer = (side: FiveSide) => inspected.value?.players.find(player => player.side === side) ?? null;
const sideLabel = (side: FiveSide) => fiveSideName(side);
const pieceLabel = (piece: FivePiece) => `${fiveSideName(piece.side)}${fivePieceName(piece)}，${piece.x + 1} 路第 ${piece.y + 1} 线`;
const playerState = (side: FiveSide) => {
  const player = sidePlayer(side);
  if (!player) return '等待入座';
  if (!player.online) return '离线';
  return player.ready ? '已准备' : '未准备';
};
const resultText = computed(() => {
  if (game.value.status !== 'finished') return '';
  if (!mySide.value) return game.value.winner ? `${fiveSideName(game.value.winner)}获胜` : '本局结束';
  return game.value.winner === mySide.value ? '五兵夺帅，胜局已定。' : '本局落败，可以再来一局。';
});

function saveSession(receipt: FiveReceipt): boolean {
  if (!receipt || receipt.gameId !== FIVE_SOLDIERS_GAME_ID || receipt.playerId !== receipt.state.selfId)
    return false;
  session.value = { reconnectToken: receipt.reconnectToken, playerId: receipt.playerId };
  localStorage.setItem(FIVE_SOLDIERS_SESSION_KEY, JSON.stringify(session.value));
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
  localStorage.removeItem(FIVE_SOLDIERS_SESSION_KEY);
}

function acceptState(next: FiveState) {
  if (!next || next.gameId !== FIVE_SOLDIERS_GAME_ID) return;
  if (session.value && next.selfId === session.value.playerId) {
    if (state.value && next.version < state.value.version) return;
    state.value = next;
    inspected.value = next;
    return;
  }
  if (!session.value && next.selfId === null) inspected.value = next;
}

function emitAck<T>(event: string, payload: unknown, timeoutMs = 6000): Promise<FiveAck<T>> {
  return new Promise(resolve => {
    if (!socket?.connected) {
      resolve({ ok: false, code: 'OFFLINE', error: '尚未连接服务器，请稍后重试。' });
      return;
    }
    socket.timeout(timeoutMs).emit(event, payload, (timeout: Error | null, ack: FiveAck<T>) => {
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
    const ack = await emitAck<FiveReceipt>('five:resume', { reconnectToken: saved.reconnectToken });
    if (attempt !== resumeAttempt || session.value?.reconnectToken !== saved.reconnectToken) return;
    if (ack.ok) saveSession(ack.data);
    else if (ack.code === 'SESSION_NOT_FOUND') {
      clearSession();
      error.value = '';
      const inspectedAck = await emitAck<FiveState>('five:watch', {});
      if (inspectedAck.ok) inspected.value = inspectedAck.data;
    } else error.value = ack.error;
    return;
  }
  const ack = await emitAck<FiveState>('five:watch', {});
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
  socket = io({ path: '/three-chess/socket.io', autoConnect: false, reconnection: true, forceNew: true });
  socket.on('connect', () => {
    connection.value = 'online';
    void recover();
  });
  socket.on('disconnect', () => { connection.value = 'offline'; });
  socket.on('connect_error', () => { connection.value = 'offline'; });
  socket.on('five:state', acceptState);
  socket.on('five:session-replaced', () => {
    clearSession();
    error.value = '席位已在另一页面恢复，本页已停止联机。';
  });
  socket.connect();
}

function chooseSide(side: FiveSide) {
  if (state.value?.phase === 'lobby' && myPlayer.value) {
    void chooseSideOnline(side);
    return;
  }
  if (examinedSidePlayer(side)) return;
  selectedSide.value = side;
}

async function chooseSideOnline(side: FiveSide) {
  if (!session.value || busy.value || side === mySide.value) return;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: FiveState }>('five:choose-side', {
      reconnectToken: session.value.reconnectToken, side,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally { busy.value = false; }
}

async function enterRoom() {
  error.value = '';
  notice.value = '';
  if (!props.accountName && !guestName.value.trim()) {
    error.value = '未登录玩家需要填写昵称。';
    return;
  }
  if (!await ensureConnected()) {
    error.value = '暂时无法连接服务器，请稍后重试。';
    return;
  }
  busy.value = true;
  try {
    const ack = await emitAck<FiveReceipt>('five:join', {
      nickname: guestName.value.trim(),
      side: selectedSide.value,
    });
    if (!ack.ok) error.value = ack.error;
    else if (!saveSession(ack.data)) error.value = '服务器返回的席位信息不完整。';
  } finally { busy.value = false; }
}

async function setReady(ready: boolean) {
  if (!session.value || busy.value) return;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: FiveState }>('five:ready', {
      reconnectToken: session.value.reconnectToken, ready,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally { busy.value = false; }
}

async function move(pieceId: string, to: FivePoint) {
  if (!session.value || busy.value || game.value.status !== 'playing') return;
  const intent: FiveMoveIntent = {
    requestId: `five-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`,
    version: state.value?.version ?? 0,
    pieceId,
    to,
  };
  busy.value = true;
  try {
    const ack = await emitAck<{ state: FiveState }>('five:move', {
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

function clickPoint(point: FivePoint) {
  if (state.value?.phase !== 'playing' || !isMyTurn.value) return;
  const piece = targetAt(point);
  if (piece?.side === mySide.value) {
    selectedId.value = selectedId.value === piece.id ? null : piece.id;
    return;
  }
  if (!selected.value) return;
  if (moves.value.some(movePoint => movePoint.x === point.x && movePoint.y === point.y))
    void move(selected.value.id, point);
  else error.value = '这个位置不符合当前棋子的走法。';
}

function confirmResign() {
  resignDialog.value?.close();
  void resign();
}

async function resign() {
  if (!session.value || busy.value) return;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: FiveState }>('five:resign', {
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
    const ack = await emitAck<{ state: FiveState }>('five:rematch', {
      reconnectToken: session.value.reconnectToken,
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
    if (connection.value === 'online') await emitAck('five:leave', { reconnectToken: saved.reconnectToken }, 3500);
  } finally {
    busy.value = false;
    clearSession();
    const ack = await emitAck<FiveState>('five:watch', {});
    if (ack.ok) inspected.value = ack.data;
  }
}

async function leaveForNavigation(): Promise<void> {
  const saved = session.value;
  if (!saved) return;
  if (connection.value === 'online') await emitAck('five:leave', { reconnectToken: saved.reconnectToken }, 3500);
  clearSession();
}

function requestLeave() {
  if (state.value?.phase === 'playing') leaveDialog.value?.showModal();
  else void leaveRoom();
}

async function copyInvite() {
  const link = appRouteUrl(location.href, 'five');
  inviteText.value = link;
  try {
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
watch(inspected, current => {
  if (!current || session.value) return;
  if (current.players.some(player => player.side === selectedSide.value)) {
    const empty = (['red', 'black'] as FiveSide[]).find(side => !current.players.some(player => player.side === side));
    if (empty) selectedSide.value = empty;
  }
});
watch(() => props.accountName, name => {
  if (name) {
    guestName.value = '';
    if (!session.value) {
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

defineExpose({ leaveForNavigation });
</script>

<template>
  <main class="five-page" :data-connection="connection">
    <div class="five-page-nav">
      <button class="plain-button" type="button" @click="emit('other')">← 其他玩法</button>
      <span v-if="myPlayer" class="five-side-chip" :class="myPlayer.side">{{ sideLabel(myPlayer.side) }}</span>
    </div>

    <header class="five-heading">
      <div>
        <span class="eyebrow">FIVE SOLDIERS</span>
        <h1>五兵联盟</h1>
      </div>
      <p>五兵红方每回合连续两步，对阵每回合一步的标准黑方。抢先将帅即可获胜。</p>
    </header>

    <p v-if="connection !== 'online'" class="connection-note" :class="{ error: !!error }">{{ error || '正在连接棋桌…' }}</p>
    <p v-else-if="error" class="connection-note error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="connection-note" role="status">{{ notice }}</p>

    <section v-if="!session" class="five-entry-card">
      <div class="five-seat-picker" role="group" aria-label="选择阵营">
        <button v-for="side in (['red', 'black'] as const)" :key="side" type="button"
          class="five-seat-option" :class="[side, { selected: selectedSide === side, occupied: !!examinedSidePlayer(side) }]"
          :disabled="!!examinedSidePlayer(side)" @click="chooseSide(side)">
          <span class="five-piece-preview">{{ side === 'red' ? '帅' : '将' }}</span>
          <span><strong>{{ sideLabel(side) }}</strong><small>{{ examinedSidePlayer(side)?.nickname || (side === 'red' ? '五兵阵营' : '标准阵营') }}</small></span>
          <em>{{ examinedSidePlayer(side) ? '已入座' : selectedSide === side ? '已选择' : '可加入' }}</em>
        </button>
      </div>
      <label v-if="!accountName" class="five-entry-field">昵称：<input v-model="guestName" maxlength="16" autocomplete="nickname" @keydown.enter="enterRoom"></label>
      <div v-else class="five-account-name">账号昵称 <strong>{{ accountName }}</strong></div>
      <button class="primary-button five-enter-button" type="button"
        :disabled="busy || connection !== 'online' || !selectedAvailable" @click="enterRoom">
        {{ inspected?.phase === 'playing' || inspected?.phase === 'finished' ? '当前对局进行中' : '进入对局' }}
      </button>
      <details class="five-rules">
        <summary>玩法说明</summary>
        <ul>
          <li>红方为五兵＋士象全＋帅，黑方为标准十六子。</li>
          <li>红方每回合连续走两步，黑方每回合走一步；所有棋子按中国象棋的基本走法行棋。</li>
          <li>不强制应将，也不禁止送将；吃掉对方将帅立即获胜。</li>
          <li>双方都准备后开始，对局结束后可在原桌再来一局。</li>
        </ul>
      </details>
    </section>

    <section v-else-if="state?.phase === 'lobby'" class="five-waiting">
      <div class="five-waiting-heading">
        <div><span class="eyebrow">双人棋桌</span><h2>等待双方准备</h2></div>
        <button class="tool-button" type="button" @click="copyInvite">复制邀请链接</button>
      </div>
      <div class="five-seat-picker">
        <button v-for="side in (['red', 'black'] as const)" :key="side" type="button"
          class="five-seat-option" :class="[side, { selected: mySide === side }]"
          :disabled="busy || (!!sidePlayer(side) && mySide !== side)" @click="chooseSide(side)">
          <span class="five-piece-preview">{{ side === 'red' ? '帅' : '将' }}</span>
          <span><strong>{{ sidePlayer(side)?.nickname || '等待对手' }}</strong><small>{{ sideLabel(side) }}</small></span>
          <em>{{ playerState(side) }}</em>
        </button>
      </div>
      <div class="five-waiting-actions">
        <button class="primary-button" type="button" :disabled="busy || connection !== 'online'" @click="setReady(!myPlayer?.ready)">
          {{ myPlayer?.ready ? '取消准备' : '准备' }}
        </button>
        <button class="tool-button" type="button" :disabled="busy" @click="requestLeave">退出房间</button>
      </div>
      <textarea v-if="inviteVisible" :value="inviteText" readonly rows="2" aria-label="五兵联盟邀请链接" @focus="selectInvite"></textarea>
    </section>

    <template v-else>
      <section class="five-match-top" aria-label="对局双方">
        <article v-for="side in (['red', 'black'] as const)" :key="side" class="five-player-card" :class="[side, { active: game.status === 'playing' && game.turn === side }]">
          <span class="five-player-seal">{{ side === 'red' ? '帅' : '将' }}</span>
          <div><strong>{{ sidePlayer(side)?.nickname || fiveSideName(side) }}</strong><small>{{ fiveSideName(side) }} · {{ sidePlayer(side)?.identity === 'guest' ? '游客' : '账号' }}</small></div>
          <em v-if="game.status === 'finished'">{{ game.winner === side ? '胜利' : '失败' }}</em>
          <em v-else-if="game.turn === side">行棋中 · 剩余 {{ game.movesRemaining }} 步</em>
          <em v-else-if="sidePlayer(side) && !sidePlayer(side)?.online">离线</em>
        </article>
      </section>

      <section class="five-game-layout">
        <div class="five-board-column">
          <div class="five-board-heading"><div><h2>{{ boardTitle }}</h2><small v-if="turnBudget">{{ turnBudget }}</small></div><span>第 {{ game.history.length }} 手</span></div>
          <div class="board-frame five-board-frame">
            <svg class="board-svg five-board-svg" viewBox="0 0 540 595" role="group" :aria-label="`五兵联盟棋盘，${flipped ? '黑方' : '红方'}视角`">
              <defs>
                <linearGradient id="five-wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#efdab4"/><stop offset="1" stop-color="#e5c897"/></linearGradient>
                <pattern id="five-grain" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M0 6 H18 M0 15 H18" stroke="#755935" stroke-opacity=".035"/></pattern>
                <marker id="five-trail-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a77b36"/></marker>
              </defs>
              <rect x="8" y="8" width="524" height="579" rx="8" fill="url(#five-wood)"/>
              <rect x="8" y="8" width="524" height="579" rx="8" fill="url(#five-grain)"/>
              <rect x="37" y="37" width="466" height="521" fill="none" stroke="#674d2f" stroke-width="1.4"/>
              <g class="grid-lines">
                <line v-for="n in 10" :key="`h${n}`" :x1="px(0)" :x2="px(8)" :y1="py(n-1)" :y2="py(n-1)"/>
                <template v-for="n in 9" :key="`v${n}`"><line :x1="px(n-1)" :x2="px(n-1)" :y1="py(0)" :y2="py(4)"/><line :x1="px(n-1)" :x2="px(n-1)" :y1="py(5)" :y2="py(9)"/></template>
                <line :x1="px(0)" :x2="px(0)" :y1="py(4)" :y2="py(5)"/><line :x1="px(8)" :x2="px(8)" :y1="py(4)" :y2="py(5)"/>
                <path :d="`M${px(3)} ${py(0)} L${px(5)} ${py(2)} M${px(5)} ${py(0)} L${px(3)} ${py(2)} M${px(3)} ${py(7)} L${px(5)} ${py(9)} M${px(5)} ${py(7)} L${px(3)} ${py(9)}`"/>
              </g>
              <g class="coordinates"><text v-for="n in 9" :key="n" :x="px(n-1)" y="25">{{ flipped ? 10 - n : n }}</text><text v-for="n in 10" :key="`row${n}`" x="24" :y="py(n-1)+4">{{ flipped ? 11 - n : n }}</text></g>
              <text class="river" x="175" y="305">{{ flipped ? '汉 界' : '楚 河' }}</text><text class="river" x="365" y="305">{{ flipped ? '楚 河' : '汉 界' }}</text>
              <g v-if="latest" class="last-trail" aria-hidden="true"><line :x1="viewX(latest.from.x)" :y1="viewY(latest.from.y)" :x2="viewX(latest.to.x)" :y2="viewY(latest.to.y)" marker-end="url(#five-trail-tip)"/><rect :x="viewX(latest.from.x)-18" :y="viewY(latest.from.y)-18" width="36" height="36" rx="4"/><circle :cx="viewX(latest.to.x)" :cy="viewY(latest.to.y)" r="26"/></g>
              <g v-for="point in moves" :key="`${point.x},${point.y}`" class="five-target" role="button" tabindex="0"
                :aria-label="`${targetAt(point) ? '吃子到' : '走到'}第${point.x+1}路第${point.y+1}线`"
                @click.stop="clickPoint(point)" @keydown.enter.prevent.stop="clickPoint(point)" @keydown.space.prevent.stop="clickPoint(point)">
                <circle :cx="viewX(point.x)" :cy="viewY(point.y)" r="23" fill="transparent"/><circle :cx="viewX(point.x)" :cy="viewY(point.y)" :r="targetAt(point) ? 27 : 6" :class="targetAt(point) ? 'capture-ring' : 'move-dot'"/>
              </g>
              <g v-for="piece in game.pieces" :key="piece.id" class="five-piece" :class="[piece.side, { selected: selectedId === piece.id }]"
                :style="{transform: `translate(${viewX(piece.x)}px, ${viewY(piece.y)}px)`}" role="button" tabindex="0"
                :aria-label="pieceLabel(piece)" @click.stop="clickPoint(piece)" @keydown.enter.prevent.stop="clickPoint(piece)">
                <circle class="five-selection-ring" r="27"/><circle class="five-piece-shadow" cy="2.5" r="23"/><circle class="five-piece-face" r="23"/><circle class="five-piece-rim" r="19.5"/><text :class="{ general: piece.kind === 'general' }" y="1">{{ fivePieceName(piece) }}</text>
              </g>
            </svg>
          </div>
          <div class="board-tools">
            <button class="tool-button" type="button" @click="flipped = !flipped">翻转棋盘</button>
            <button v-if="state?.phase === 'playing' && myPlayer" class="tool-button resign-button" type="button" @click="resignDialog?.showModal()">认输</button>
            <button v-if="state?.phase === 'finished'" class="primary-button" type="button" :disabled="busy" @click="rematch">再来一局</button>
            <button class="tool-button leave-button" type="button" :disabled="busy" @click="requestLeave">退出房间</button>
          </div>
          <div v-if="state?.phase === 'finished'" class="result-banner"><strong>{{ resultText }}</strong><span>{{ game.winner ? `${fiveSideName(game.winner)}吃将获胜` : '本局结束' }}</span></div>
        </div>

        <aside class="five-history">
          <div class="five-history-heading"><strong>行棋记录</strong><span>{{ game.history.length }} 手</span></div>
          <div v-if="latest" class="last-move-card"><span class="eyebrow">上一步</span><h3 :class="latest.side">{{ fiveSideName(latest.side) }} · {{ fivePieceName(latest) }}</h3><p>{{ coordinate(latest.from) }} → {{ coordinate(latest.to) }}</p><small>{{ latest.captured ? `吃掉${fiveSideName(latest.captured.side)}${fivePieceName(latest.captured)}` : '已标记起点和落点' }}</small></div>
          <ol v-if="history.length" class="move-list"><li v-for="record in history" :key="record.number"><span class="record-number">{{ String(record.number).padStart(2, '0') }}</span><div><strong :class="record.side">{{ fiveSideName(record.side) }}</strong><p>{{ fivePieceName(record) }} {{ coordinate(record.from) }} → {{ coordinate(record.to) }}</p><small v-if="record.captured">吃掉{{ fiveSideName(record.captured.side) }}{{ fivePieceName(record.captured) }}</small></div></li></ol>
          <div v-else class="empty-history"><span aria-hidden="true">兵</span><p>双方准备后开始棋局。</p></div>
          <details class="five-live-rules"><summary>玩法说明</summary><p>五兵红方每回合连续走两步，黑方每回合走一步；不强制应将，吃掉将帅即胜。</p></details>
        </aside>
      </section>
    </template>

    <dialog ref="resignDialog" class="reset-dialog">
      <h2>确认认输？</h2><p>本局立即判负，仍可留在房间查看结果。</p>
      <div class="dialog-actions"><button class="tool-button" type="button" @click="resignDialog?.close()">继续对局</button><button class="primary-button" type="button" @click="confirmResign">确认认输</button></div>
    </dialog>
    <dialog ref="leaveDialog" class="reset-dialog">
      <h2>退出五兵联盟？</h2><p>对局进行中离开会按认输结算。</p>
      <div class="dialog-actions"><button class="tool-button" type="button" @click="leaveDialog?.close()">继续对局</button><button class="primary-button" type="button" @click="leaveRoom">确认退出</button></div>
    </dialog>
  </main>
</template>

<style scoped>
.five-page{width:min(1180px,100%);margin:0 auto;padding:24px 0 54px;--five-red:#a64b3c;--five-black:#343e48;--five-line:#d8c7aa}
.five-page-nav{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;padding-bottom:13px;border-bottom:1px solid #ded2c1}
.five-page-nav .plain-button{font-size:15px;font-weight:600;color:#5b4d3e}
.five-side-chip{padding:4px 10px;border:1px solid #d7c6ab;border-radius:999px;background:#fffaf0;color:#745e3f;font-size:10px;font-weight:700}
.five-side-chip.red{color:var(--five-red);border-color:#d5a79e}.five-side-chip.black{color:var(--five-black);border-color:#afb5bb}
.five-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}
.five-heading h1{margin:5px 0 0;font:700 42px/1.15 "Songti SC","SimSun",serif;letter-spacing:4px;color:#3c332a}
.five-heading p{max-width:420px;margin:0 0 5px;color:#7e6e5b;font-size:12px;line-height:1.8;text-align:right}
.five-entry-card,.five-waiting{padding:28px;border:1px solid var(--five-line);border-radius:18px;background:linear-gradient(150deg,#fffef9,#fbf5e9);box-shadow:0 18px 44px #59432310}
.five-seat-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.five-seat-option{--side:#a64b3c;--soft:#faeee9;display:grid;grid-template-columns:48px minmax(0,1fr) auto;align-items:center;gap:11px;min-height:84px;padding:12px 14px;border:1px solid #d6c6b0;border-radius:12px;background:#fffdf8;color:#4f4438;text-align:left;transition:border-color .16s ease,background .16s ease,transform .16s ease,box-shadow .16s ease}
.five-seat-option.black{--side:#343e48;--soft:#f0f2f3}
.five-seat-option:hover:not(:disabled):not(.selected){border-color:var(--side);background:var(--soft);transform:translateY(-1px)}
.five-seat-option.selected{border-color:var(--side);background:var(--soft);box-shadow:inset 0 0 0 1px var(--side)}
.five-seat-option.occupied,.five-seat-option:disabled{opacity:.58;cursor:not-allowed}
.five-seat-option:focus-visible,.five-entry-field input:focus-visible,.five-enter-button:focus-visible,.five-waiting-actions button:focus-visible{outline:2px solid #8c6d37;outline-offset:2px}
.five-piece-preview,.five-player-seal{display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--side,#a64b3c);border-radius:50%;background:#fffdf8;color:var(--side,#a64b3c);font:700 24px/1 "STKaiti","KaiTi",serif;box-shadow:inset 0 0 0 3px #fff8e8}
.five-seat-option.selected .five-piece-preview{background:var(--side);color:#fff8e9;box-shadow:inset 0 0 0 2px #fff4df4d}
.five-seat-option>span:nth-child(2){display:grid;gap:3px;min-width:0}
.five-seat-option strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 18px/1.25 "Songti SC","SimSun",serif}
.five-seat-option small{color:#8b7b67;font-size:10px}
.five-seat-option em{padding:3px 7px;border-radius:999px;background:#eee6da;color:#7c6c59;font-size:9px;font-style:normal;white-space:nowrap}
.five-entry-field{display:grid;gap:7px;margin-top:18px;color:#615344;font-size:13px;font-weight:600}
.five-entry-field input{height:46px;border:1px solid #d8cab5;border-radius:9px;background:#fffefb;padding:0 13px;color:#3f352b;font:500 15px/1 inherit;outline:none}
.five-entry-field input:focus{border-color:#a78147;box-shadow:0 0 0 3px #a7814718}
.five-account-name{margin-top:18px;padding:11px 13px;border:1px solid #e0d4c1;border-radius:9px;background:#f7f1e7;color:#776856;font-size:12px}
.five-account-name strong{margin-left:5px;color:#4b3d2f}
.five-enter-button{width:100%;height:48px;margin-top:18px;font-size:14px;font-weight:700;letter-spacing:.08em}
.five-rules{margin-top:20px;padding-top:15px;border-top:1px solid #e1d6c5;color:#776857;font-size:12px;line-height:1.8}
.five-rules summary,.five-live-rules summary{cursor:pointer;font-weight:600;color:#715b3c}
.five-rules ul{margin:10px 0 0;padding-left:20px}
.five-waiting-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.five-waiting-heading h2{margin:4px 0 0;font:700 26px/1.2 "Songti SC","SimSun",serif}
.five-waiting-actions{display:grid;grid-template-columns:minmax(150px,240px) auto;justify-content:end;gap:10px;margin-top:20px}
.five-waiting-actions button{min-height:44px}
.five-waiting textarea{width:100%;margin-top:16px;padding:10px 12px;border:1px solid #d8cab5;border-radius:8px;background:#fffefb;color:#5a4c3d;font:500 12px/1.6 ui-monospace,Consolas,monospace;resize:none}
.five-match-top{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:16px}
.five-player-card{--side:#a64b3c;display:flex;align-items:center;gap:12px;min-width:0;padding:12px 14px;border:1px solid #ddd0bd;border-radius:11px;background:#fffdf8}
.five-player-card.black{--side:#343e48}
.five-player-card.active{border-color:var(--side);box-shadow:inset 3px 0 var(--side),0 7px 18px #5943230d}
.five-player-seal{--side:inherit;flex:none;width:42px;height:42px;font-size:23px}
.five-player-card.red .five-player-seal{color:var(--five-red);border-color:var(--five-red)}
.five-player-card.black .five-player-seal{color:var(--five-black);border-color:var(--five-black)}
.five-player-card>div{display:grid;gap:3px;min-width:0}
.five-player-card strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 19px/1.2 "Songti SC","SimSun",serif}
.five-player-card small{margin-left:auto;color:#8a7b68;font-size:10px}
.five-player-card em{padding:3px 7px;border-radius:999px;background:#f0e7da;color:#765f3e;font-size:9px;font-style:normal;white-space:nowrap}
.five-game-layout{display:grid;grid-template-columns:minmax(0,1fr) 250px;align-items:start;gap:20px}
.five-board-column,.five-history{min-width:0}
.five-board-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.five-board-heading>div{display:grid;gap:3px;min-width:0}
.five-board-heading h2{margin:0;font-size:21px;color:#3f352b}
.five-board-heading small{color:#9b6f44;font-size:10px;font-weight:600}
.five-board-heading span{padding:5px 10px;border:1px solid #d8cab5;border-radius:999px;background:#fffdf8;color:#847461;font-size:10px}
.five-board-frame{max-width:680px;margin:0 auto}
.five-piece{cursor:pointer;transition:transform .18s ease;outline-offset:1px}
.five-piece-shadow{fill:#603f3270}.five-piece-face{stroke-width:1.6;filter:drop-shadow(0 2px 2px #0002)}
.five-piece.red .five-piece-face{fill:#b6503e;stroke:#83392e}.five-piece.black .five-piece-face{fill:#343e48;stroke:#202b36}
.five-piece-rim{fill:none;stroke:#fff3d9;stroke-width:.8;opacity:.52}
.five-piece text{text-anchor:middle;dominant-baseline:central;fill:#fff6e3;font:30px "STKaiti","KaiTi","Songti SC",serif;pointer-events:none}
.five-piece text.general{font-size:18px;font-weight:600}
.five-selection-ring{fill:none;stroke:#fffaf0;stroke-width:3;opacity:0}
.five-piece.selected .five-selection-ring{opacity:1;filter:drop-shadow(0 0 2px #805c28)}
.five-target{cursor:pointer}.five-history{padding:16px;border:1px solid #ddd0bd;border-radius:12px;background:#fffdf8}
.five-history-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px;color:#645647;font-size:12px}
.five-history-heading span{color:#94846f;font-size:10px}
.five-history .last-move-card{padding:14px}
.five-history h3.red,.five-history strong.red{color:var(--five-red)}.five-history h3.black,.five-history strong.black{color:var(--five-black)}
.five-history .move-list{margin-top:13px;max-height:420px;overflow:auto}
.five-history .empty-history{display:block;padding:24px 8px;text-align:center;border:0}
.five-live-rules{margin-top:16px;padding-top:13px;border-top:1px solid #e4d9ca;color:#7e705f;font-size:11px;line-height:1.7}
.five-live-rules p{margin:8px 0 0}
.five-page .result-banner{margin-top:12px}
@media(max-width:860px){.five-game-layout{grid-template-columns:1fr}.five-history{margin-top:4px}.five-history .move-list{max-height:260px}}
@media(max-width:640px){
  .five-page{padding-top:16px}.five-heading{display:block;margin-bottom:17px}.five-heading h1{font-size:34px;letter-spacing:3px}.five-heading p{margin-top:8px;text-align:left;font-size:11px}
  .five-entry-card,.five-waiting{padding:17px;border-radius:14px}.five-seat-picker{grid-template-columns:1fr}.five-seat-option{min-height:70px}.five-seat-option strong{font-size:16px}
  .five-waiting-heading{align-items:flex-start}.five-waiting-heading h2{font-size:22px}.five-waiting-actions{grid-template-columns:1fr 1fr}.five-waiting-actions button{width:100%}
  .five-match-top{gap:7px}.five-player-card{padding:9px 10px;gap:8px}.five-player-seal{width:35px;height:35px;font-size:19px}.five-player-card strong{font-size:14px}.five-player-card small{display:none}.five-player-card em{padding:2px 5px;font-size:8px}
  .five-board-heading h2{font-size:18px}.five-history{padding:13px}.board-tools{flex-wrap:wrap}.board-tools button{flex:1 1 auto}
}
</style>
