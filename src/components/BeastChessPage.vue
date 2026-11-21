<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { io, type Socket } from 'socket.io-client';
import BeastChessBoard from './BeastChessBoard.vue';
import OtherGameTable from './OtherGameTable.vue';
import {
  BEAST_CHESS_GAME_ID,
  BEAST_CHESS_SESSION_KEY,
  BEAST_KIND_NAMES,
  BEAST_SEAT_SIDE_NAMES,
  BEAST_SIDE_NAMES,
  beastCoordinate,
  beastGameSideToSeat,
  beastPieceAt,
  beastSeatToGameSide,
  capturedBeastPieces,
  legalBeastMoves,
  newBeastGame,
} from '../beast-chess.ts';
import type {
  BeastAck,
  BeastGame,
  BeastMoveIntent,
  BeastPiece,
  BeastPlayerView,
  BeastPoint,
  BeastReceipt,
  BeastSeatSide,
  BeastSide,
  BeastState,
} from '../beast-chess.ts';
import { backendAssetUrl, socketIoConfig } from '../network-config.ts';
import { appRouteUrl } from '../navigation.ts';
import { BeastMoveSoundTracker, GameAudio, loadAudioSettings } from '../audio.ts';
import type { AudioSettings } from '../audio.ts';

const props = defineProps<{
  accountName: string | null;
  accountAvatar?: string | null;
  audioSettings?: AudioSettings;
}>();
const emit = defineEmits<{ other: [] }>();
const guestAvatar = 'images/guest-avatar.svg';
const initialGame = newBeastGame();

interface SavedSession {
  reconnectToken: string;
  playerId: string;
}

function loadSession(): SavedSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(BEAST_CHESS_SESSION_KEY) || 'null') as Partial<SavedSession> | null;
    return value && typeof value.reconnectToken === 'string' && typeof value.playerId === 'string'
      ? value as SavedSession : null;
  } catch { return null; }
}

const session = shallowRef<SavedSession | null>(loadSession());
const state = shallowRef<BeastState | null>(null);
const inspected = shallowRef<BeastState | null>(null);
const connection = ref<'offline' | 'connecting' | 'online'>('offline');
const busy = ref(false), error = ref(''), notice = ref('');
const guestName = ref(''), pendingSide = ref<BeastSeatSide | null>(null);
const selectedId = ref<string | null>(null);
const inviteVisible = ref(false), inviteText = ref('');
const resignDialog = ref<HTMLDialogElement | null>(null), leaveDialog = ref<HTMLDialogElement | null>(null);
const seatDialog = ref<HTMLDialogElement | null>(null);
const watching = ref(false);
const gameAudio = new GameAudio();
const moveSoundTracker = new BeastMoveSoundTracker();
let socket: Socket | null = null;
let resumeAttempt = 0;

const roomState = computed(() => state.value ?? inspected.value);
const showTableView = computed(() => !session.value && !watching.value);
const game = computed<BeastGame>(() => roomState.value?.game ?? initialGame);
const myPlayer = computed(() => state.value?.players.find(player => player.id === state.value?.selfId) ?? null);
const mySeat = computed(() => myPlayer.value?.side ?? null);
const myGameSide = computed<BeastSide | null>(() => mySeat.value ? beastSeatToGameSide(mySeat.value) : null);
const isMyTurn = computed(() => game.value.status === 'playing'
  && !!myGameSide.value && game.value.turn === myGameSide.value);
const boardFlipped = computed(() => mySeat.value === 'black');
const selected = computed<BeastPiece | null>(() => selectedId.value
  ? game.value.pieces.find(piece => piece.id === selectedId.value) ?? null
  : null);
const targets = computed(() => selected.value ? legalBeastMoves(game.value, selected.value.id) : []);
const latest = computed(() => game.value.lastMove);
const history = computed(() => game.value.history.slice(-24).reverse());
const drawOfferBy = computed(() => roomState.value?.drawOfferBy ?? null);
const canRespondDraw = computed(() => !!session.value && roomState.value?.phase === 'playing'
  && !!drawOfferBy.value && drawOfferBy.value !== mySeat.value);
const boardTitle = computed(() => {
  const room = roomState.value;
  if (!room) return '正在连接棋桌';
  if (room.phase === 'lobby') {
    if (room.players.length < 2) return '等待另一位棋友';
    return myPlayer.value?.ready ? '已准备，等待对手' : '双方已入座，准备开局';
  }
  if (room.phase === 'finished') {
    if (!game.value.winner) return '本局和棋';
    if (!myGameSide.value) return `${BEAST_SIDE_NAMES[game.value.winner]}获胜`;
    return game.value.winner === myGameSide.value ? '你获胜' : '你失败';
  }
  const activeSide = game.value.turn;
  const activeSeat = activeSide ? beastGameSideToSeat(activeSide) : null;
  return activeSeat && seatPlayer(activeSeat)?.nickname
    ? `轮到 ${seatPlayer(activeSeat)!.nickname} 行棋`
    : activeSide ? `轮到${BEAST_SIDE_NAMES[activeSide]}行棋` : '对局已结束';
});
const resultText = computed(() => {
  if (game.value.status !== 'finished') return '';
  if (game.value.finishReason === 'resignation')
    return game.value.winner ? `${BEAST_SIDE_NAMES[game.value.winner]}因对手认输获胜。` : '一方认输。';
  if (game.value.finishReason === 'draw' || game.value.drawReason === 'agreement') return '双方同意和棋。';
  if (game.value.finishReason === 'den') return '棋子进入敌方兽穴。';
  if (game.value.finishReason === 'capture-all') return '对方棋子已全部被吃。';
  if (game.value.finishReason === 'stalemate') return '对方已经没有合法走法。';
  if (game.value.finishReason === 'threefold') return '同一完整局面出现三次。';
  if (game.value.finishReason === 'halfmove') return '连续 100 个半回合没有吃子。';
  return '本局已经结束。';
});
const upperPlayer = computed(() => seatPlayer('black'));
const lowerPlayer = computed(() => seatPlayer('red'));
const upperCaptured = computed(() => capturedBeastPieces(game.value).upper);
const lowerCaptured = computed(() => capturedBeastPieces(game.value).lower);

function seatPlayer(side: BeastSeatSide): BeastPlayerView | null {
  return roomState.value?.players.find(player => player.side === side) ?? null;
}

function avatarFor(side: BeastSeatSide): string | null {
  const player = seatPlayer(side);
  return player ? backendAssetUrl(player.avatar) || guestAvatar : null;
}

function seatLabel(side: BeastSeatSide): string {
  return BEAST_SEAT_SIDE_NAMES[side];
}

function playerState(side: BeastSeatSide): string {
  const player = seatPlayer(side);
  if (!player) return roomState.value?.phase === 'lobby' ? '等待棋友' : '未入座';
  if (roomState.value?.phase === 'lobby') return player.ready ? '已准备' : '未准备';
  if (roomState.value?.phase === 'finished') {
    const gameSide = beastSeatToGameSide(side);
    if (!game.value.winner) return '和棋';
    return game.value.winner === gameSide ? '胜利' : '失败';
  }
  return game.value.turn === beastSeatToGameSide(side) ? '行棋中' : '对局中';
}

function canSeat(side: BeastSeatSide): boolean {
  return !session.value && roomState.value?.phase === 'lobby'
    && roomState.value.players.length < 2 && !seatPlayer(side);
}

function capturedText(pieces: BeastPiece[]): string {
  return pieces.length ? pieces.map(piece => BEAST_KIND_NAMES[piece.kind]).join('、') : '无';
}

function coordinate(point: BeastPoint): string {
  return beastCoordinate(point);
}

function saveSession(receipt: BeastReceipt): boolean {
  if (!receipt || receipt.gameId !== BEAST_CHESS_GAME_ID || receipt.playerId !== receipt.state.selfId) return false;
  session.value = { reconnectToken: receipt.reconnectToken, playerId: receipt.playerId };
  localStorage.setItem(BEAST_CHESS_SESSION_KEY, JSON.stringify(session.value));
  state.value = receipt.state;
  inspected.value = receipt.state;
  selectedId.value = null;
  return true;
}

function clearSession() {
  resumeAttempt++;
  session.value = null;
  state.value = null;
  selectedId.value = null;
  localStorage.removeItem(BEAST_CHESS_SESSION_KEY);
}

function acceptState(next: BeastState) {
  if (!next || next.gameId !== BEAST_CHESS_GAME_ID) return;
  if (session.value && next.selfId === session.value.playerId) {
    if (state.value && next.version < state.value.version) return;
    state.value = next;
    inspected.value = next;
    return;
  }
  if (!session.value && next.selfId === null) inspected.value = next;
}

function emitAck<T>(event: string, payload: unknown, timeoutMs = 6000): Promise<BeastAck<T>> {
  return new Promise(resolve => {
    if (!socket?.connected) {
      resolve({ ok: false, code: 'OFFLINE', error: '尚未连接服务器，请稍后重试。' });
      return;
    }
    socket.timeout(timeoutMs).emit(event, payload, (timeout: Error | null, ack: BeastAck<T>) => {
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
    const ack = await emitAck<BeastReceipt>('beast:resume', { reconnectToken: saved.reconnectToken });
    if (attempt !== resumeAttempt || session.value?.reconnectToken !== saved.reconnectToken) return;
    if (ack.ok) saveSession(ack.data);
    else if (ack.code === 'SESSION_NOT_FOUND') {
      clearSession();
      const watched = await emitAck<BeastState>('beast:watch', {});
      if (watched.ok) inspected.value = watched.data;
    } else error.value = ack.error;
    return;
  }
  const ack = await emitAck<BeastState>('beast:watch', {});
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
  socket.on('beast:state', acceptState);
  socket.on('beast:session-replaced', () => {
    clearSession();
    error.value = '席位已在另一页面恢复，本页已停止联机。';
  });
  socket.connect();
}

function openSeat(side: BeastSeatSide) {
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

async function joinSeat(side: BeastSeatSide, nickname: string) {
  if (busy.value || !canSeat(side)) return;
  error.value = '';
  notice.value = '';
  if (!await ensureConnected()) {
    error.value = '暂时无法连接服务器，请稍后重试。';
    return;
  }
  busy.value = true;
  try {
    const ack = await emitAck<BeastReceipt>('beast:join', { nickname, side });
    if (!ack.ok) error.value = ack.error;
    else if (!saveSession(ack.data)) error.value = '服务器返回的席位信息不完整。';
    else {
      seatDialog.value?.close();
      pendingSide.value = null;
    }
  } finally {
    busy.value = false;
  }
}

async function setReady() {
  if (!session.value || busy.value || !myPlayer.value) return;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: BeastState }>('beast:ready', {
      reconnectToken: session.value.reconnectToken,
      ready: !myPlayer.value.ready,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally {
    busy.value = false;
  }
}

async function move(pieceId: string, to: BeastPoint) {
  if (!session.value || busy.value || game.value.status !== 'playing') return;
  const intent: BeastMoveIntent = {
    requestId: `beast-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`,
    version: state.value?.version ?? 0,
    pieceId,
    to,
  };
  busy.value = true;
  try {
    const ack = await emitAck<{ state: BeastState }>('beast:move', {
      reconnectToken: session.value.reconnectToken,
      intent,
    });
    if (!ack.ok) {
      error.value = ack.error;
      if (ack.state) acceptState(ack.state);
    } else {
      error.value = '';
      acceptState(ack.data.state);
      selectedId.value = null;
    }
  } finally {
    busy.value = false;
  }
}

function clickCell(point: BeastPoint) {
  if (roomState.value?.phase !== 'playing' || !isMyTurn.value) return;
  const piece = beastPieceAt(game.value.pieces, point);
  if (piece?.side === myGameSide.value) {
    selectedId.value = selectedId.value === piece.id ? null : piece.id;
    error.value = '';
    return;
  }
  if (!selected.value) return;
  if (targets.value.some(target => target.x === point.x && target.y === point.y))
    void move(selected.value.id, point);
  else error.value = piece ? '这不是当前棋子的合法吃子位置。' : '这不是当前棋子的合法落点。';
}

async function resign() {
  if (!session.value || busy.value) return;
  resignDialog.value?.close();
  busy.value = true;
  try {
    const ack = await emitAck<{ state: BeastState }>('beast:resign', {
      reconnectToken: session.value.reconnectToken,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally {
    busy.value = false;
  }
}

async function rematch() {
  if (!session.value || busy.value) return;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: BeastState }>('beast:rematch', {
      reconnectToken: session.value.reconnectToken,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally {
    busy.value = false;
  }
}

async function requestDraw() {
  if (!session.value || busy.value) return;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: BeastState }>('beast:draw-offer', {
      reconnectToken: session.value.reconnectToken,
    });
    if (!ack.ok) error.value = ack.error;
    else {
      acceptState(ack.data.state);
      notice.value = '已提出和棋申请。';
    }
  } finally {
    busy.value = false;
  }
}

async function respondDraw(accept: boolean) {
  if (!session.value || busy.value) return;
  busy.value = true;
  try {
    const ack = await emitAck<{ state: BeastState }>('beast:draw-respond', {
      reconnectToken: session.value.reconnectToken,
      accept,
    });
    if (!ack.ok) error.value = ack.error;
    else acceptState(ack.data.state);
  } finally {
    busy.value = false;
  }
}

function openSpectator() {
  if (!roomState.value || roomState.value.phase === 'lobby') return;
  watching.value = true;
  selectedId.value = null;
}

async function returnToTable(): Promise<void> {
  if (!session.value) await emitAck('beast:unwatch', {});
  watching.value = false;
}

async function leaveRoom(): Promise<void> {
  leaveDialog.value?.close();
  const saved = session.value;
  if (!saved) return;
  busy.value = true;
  try {
    if (connection.value === 'online')
      await emitAck('beast:leave', { reconnectToken: saved.reconnectToken }, 3500);
  } finally {
    busy.value = false;
    clearSession();
    watching.value = false;
    const watched = await emitAck<BeastState>('beast:watch', {});
    if (watched.ok) inspected.value = watched.data;
  }
}

async function leaveForNavigation(): Promise<void> {
  const saved = session.value;
  if (!saved) return;
  if (connection.value === 'online')
    await emitAck('beast:leave', { reconnectToken: saved.reconnectToken }, 3500);
  clearSession();
}

function requestLeave() {
  if (roomState.value?.phase === 'playing') leaveDialog.value?.showModal();
  else void leaveRoom();
}

async function copyInvite() {
  inviteText.value = appRouteUrl(location.href, 'beast');
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(inviteText.value);
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

watch([() => roomState.value?.phase, () => game.value.turn], () => {
  selectedId.value = null;
});
watch(() => roomState.value?.game, current => {
  if (!current) return;
  const kind = moveSoundTracker.observe(
    current,
    `beast:${roomState.value?.round ?? 0}`,
    connection.value === 'online',
  );
  if (kind) gameAudio.playEffect(kind, props.audioSettings ?? loadAudioSettings());
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
  <main class="beast-page" :data-connection="connection">
    <nav class="beast-page-nav" aria-label="斗兽棋导航">
      <button class="plain-button" type="button" @click="emit('other')">← 其他玩法</button>
      <span v-if="mySeat" class="beast-side-chip" :class="mySeat">{{ seatLabel(mySeat) }}</span>
    </nav>

    <header class="beast-heading">
      <div><span>JUNGLE CHESS</span><h1>斗兽棋</h1></div>
      <p>双方各八兽，下方先行。鼠入河、狮虎跳河，进入敌方兽穴或使对方无子可走即获胜。</p>
    </header>

    <p v-if="connection !== 'online'" class="connection-note" :class="{ error: !!error }">
      {{ error || '正在连接联机棋桌…' }}
    </p>
    <p v-else-if="error" class="connection-note error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="connection-note" role="status">{{ notice }}</p>

    <OtherGameTable v-if="showTableView" title="斗兽棋" eyebrow="JUNGLE CHESS"
      :phase="roomState?.phase ?? 'lobby'" :players="roomState?.players ?? []"
      :busy="busy || !roomState" :side-names="{ red: '下方', black: '上方' }"
      @seat="openSeat" @watch="openSpectator" />

    <template v-else>
      <article class="beast-table-seat upper" :class="{ ready: upperPlayer?.ready, active: roomState?.phase === 'playing' && game.turn === 'upper' }">
        <span class="beast-seat-avatar" :class="{ placeholder: !upperPlayer }">
          <img v-if="avatarFor('black')" :src="avatarFor('black')!" alt="">
          <template v-else>?</template>
        </span>
        <span class="beast-seat-copy"><strong>{{ upperPlayer?.nickname || '等待棋友' }}</strong><small>上方席位{{ upperPlayer?.identity === 'guest' ? ' · 游客' : '' }}</small></span>
        <em>{{ playerState('black') }}</em>
      </article>

      <section class="beast-game-layout">
        <div class="beast-game-main">
          <div class="beast-game-toolbar">
            <div v-if="session" class="beast-action-row" aria-label="对局操作">
              <button type="button" :disabled="busy || roomState?.phase !== 'playing' || !!drawOfferBy" @click="requestDraw">提和</button>
              <button type="button" :disabled="busy || roomState?.phase !== 'playing'" @click="resignDialog?.showModal()">认输</button>
              <button type="button" :disabled="busy" @click="requestLeave">退出</button>
            </div>
            <button v-else class="plain-button beast-back-table" type="button" @click="returnToTable">← 返回棋桌</button>
            <span class="beast-turn-badge">
              <i :class="game.turn ?? 'done'"></i>{{ boardTitle }}
            </span>
          </div>

          <div class="beast-online-board">
            <BeastChessBoard :pieces="game.pieces" :selected-id="selectedId" :targets="targets"
              :last-move="game.lastMove" :disabled="roomState?.phase !== 'playing' || !isMyTurn"
              :flipped="boardFlipped"
              @cell="clickCell" />
            <div v-if="session && roomState?.phase === 'lobby'" class="beast-waiting-card">
              <span>棋桌准备</span>
              <h2>{{ roomState.players.length < 2 ? '等待棋友' : '双方已入座' }}</h2>
              <p>{{ myPlayer?.ready ? '已准备，等待对手。' : '准备后即可等待开局。' }}</p>
              <div>
                <button class="primary-button" type="button" :disabled="busy || connection !== 'online'" @click="setReady">
                  {{ myPlayer?.ready ? '取消准备' : '准备' }}
                </button>
                <button class="tool-button" type="button" @click="copyInvite">邀请好友</button>
              </div>
            </div>
          </div>

          <div v-if="drawOfferBy && roomState?.phase === 'playing'" class="beast-draw-bar">
            <span>{{ drawOfferBy === mySeat ? '已提和，等待对手回应。' : `${seatLabel(drawOfferBy)}提出和棋。` }}</span>
            <div v-if="canRespondDraw">
              <button type="button" :disabled="busy" @click="respondDraw(true)">同意</button>
              <button type="button" :disabled="busy" @click="respondDraw(false)">拒绝</button>
            </div>
          </div>

          <article class="beast-table-seat lower self-seat" :class="{ ready: lowerPlayer?.ready, active: roomState?.phase === 'playing' && game.turn === 'lower', self: mySeat === 'red' }">
            <span class="beast-seat-avatar" :class="{ placeholder: !lowerPlayer }">
              <img v-if="avatarFor('red')" :src="avatarFor('red')!" alt="">
              <template v-else>?</template>
            </span>
            <span class="beast-seat-copy"><strong>{{ lowerPlayer?.nickname || '等待棋友' }}</strong><small>下方席位 · 先行{{ lowerPlayer?.identity === 'guest' ? ' · 游客' : '' }}</small></span>
            <em>{{ playerState('red') }}</em>
          </article>

          <div class="beast-bottom-actions">
            <span>上方被吃：{{ capturedText(upperCaptured) }}</span>
            <span>下方被吃：{{ capturedText(lowerCaptured) }}</span>
            <button v-if="session && roomState?.phase === 'finished'" class="primary-button" type="button"
              :disabled="busy || connection !== 'online'" @click="rematch">再来一局</button>
          </div>
          <textarea v-if="inviteVisible" class="beast-invite-text" :value="inviteText" readonly rows="2"
            aria-label="斗兽棋邀请链接" @focus="selectInvite"></textarea>
          <div v-if="roomState?.phase === 'finished'" class="result-banner">
            <strong>{{ resultText }}</strong>
            <span>{{ game.winner ? `${BEAST_SIDE_NAMES[game.winner]}获胜` : '本局和棋' }}</span>
          </div>
        </div>

        <aside class="beast-history">
          <div class="beast-history-heading"><strong>行棋记录</strong><span>{{ game.history.length }} 手</span></div>
          <div v-if="latest" class="last-move-card">
            <span class="eyebrow">上一步</span>
            <h3>{{ BEAST_SIDE_NAMES[latest.side] }} · {{ BEAST_KIND_NAMES[latest.kind] }}</h3>
            <p>{{ coordinate(latest.from) }} → {{ coordinate(latest.to) }}</p>
            <small>{{ latest.captured ? `吃掉${BEAST_KIND_NAMES[latest.captured.kind]}` : latest.jumpedRiver ? '跳过河流' : '已标记起点和落点' }}</small>
          </div>
          <ol v-if="history.length" class="move-list">
            <li v-for="record in history" :key="record.number">
              <span class="record-number">{{ String(record.number).padStart(2, '0') }}</span>
              <div><strong>{{ BEAST_SIDE_NAMES[record.side] }}</strong><p>{{ BEAST_KIND_NAMES[record.kind] }} {{ coordinate(record.from) }} → {{ coordinate(record.to) }}</p><small v-if="record.captured">吃掉{{ BEAST_KIND_NAMES[record.captured.kind] }}</small></div>
            </li>
          </ol>
          <div v-else class="empty-history"><span aria-hidden="true">兽</span><p>{{ roomState?.phase === 'lobby' ? '开局后显示正式棋谱。' : '暂无行棋记录。' }}</p></div>
          <details class="beast-live-rules"><summary>玩法说明</summary><p>双方各八兽，下方先行。只有鼠能入河，狮虎可跳河；陷阱会降低敌方战力，进入敌方兽穴或使对方无子可走即获胜。</p></details>
        </aside>
      </section>
    </template>

    <dialog ref="seatDialog" class="beast-seat-dialog" @cancel.prevent="seatDialog?.close()">
      <form @submit.prevent="confirmGuestSeat">
        <div class="dialog-heading"><h2>入座 {{ pendingSide ? seatLabel(pendingSide) : '' }}</h2><button class="dialog-close" type="button" aria-label="关闭" @click="seatDialog?.close()">×</button></div>
        <label>昵称：<input v-model="guestName" maxlength="16" autocomplete="nickname" aria-label="座位昵称"></label>
        <p v-if="error" class="connection-note error" role="alert">{{ error }}</p>
        <div class="dialog-actions"><button class="tool-button" type="button" @click="seatDialog?.close()">取消</button><button class="primary-button" type="submit" :disabled="busy || connection !== 'online'">入座</button></div>
      </form>
    </dialog>
    <dialog ref="resignDialog" class="reset-dialog">
      <h2>确认认输？</h2><p>本局立即判负，仍可留在房间查看结果。</p>
      <div class="dialog-actions"><button class="tool-button" type="button" @click="resignDialog?.close()">继续对局</button><button class="primary-button" type="button" @click="resign">确认认输</button></div>
    </dialog>
    <dialog ref="leaveDialog" class="reset-dialog">
      <h2>退出斗兽棋？</h2><p>对局进行中离开会按认输结算，席位立即释放。</p>
      <div class="dialog-actions"><button class="tool-button" type="button" @click="leaveDialog?.close()">继续对局</button><button class="primary-button" type="button" @click="leaveRoom">确认退出</button></div>
    </dialog>
  </main>
</template>

<style scoped>
.beast-page{width:min(1120px,100%);min-width:0;margin:0 auto;padding:16px 0 38px;color:#473b30;overflow-x:clip}
.beast-page-nav{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #ded2c1}
.beast-page-nav .plain-button{font-size:13px;font-weight:600;color:#5b4d3e}
.beast-side-chip{padding:4px 10px;border:1px solid #d7c6ab;border-radius:999px;background:#fffaf0;color:#745e3f;font-size:10px;font-weight:700}
.beast-heading{display:flex;align-items:center;justify-content:space-between;gap:22px;margin-bottom:14px}
.beast-heading span{color:#a1713f;font-size:9px;font-weight:700;letter-spacing:.18em}
.beast-heading h1{margin:2px 0 0;font:700 36px/1.08 "Songti SC","SimSun",serif;letter-spacing:4px}
.beast-heading p{max-width:470px;margin:0;color:#7e6e5b;font-size:11px;line-height:1.75;text-align:right}
.beast-game-layout{display:grid;grid-template-columns:minmax(0,1fr) 250px;align-items:start;gap:18px}
.beast-game-main{display:grid;justify-items:center;gap:7px;min-width:0}
.beast-game-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;width:min(560px,100%);min-height:36px}
.beast-action-row{display:flex;align-items:center;gap:6px}
.beast-action-row button,.beast-draw-bar button{min-height:34px;padding:6px 11px;border:1px solid #d2c1a7;border-radius:7px;background:#fffaf0;color:#654f36;font-size:11px;font-weight:600}
.beast-action-row button:hover:not(:disabled),.beast-draw-bar button:hover:not(:disabled){border-color:#a67b45;background:#f6ecdc}
.beast-action-row button:nth-child(2){border-color:#c99b82;color:#8e4437}
.beast-action-row button:last-child{border-color:#c6b49a;color:#6f5b46}
.beast-back-table{padding:5px 0!important;font-size:12px!important}
.beast-turn-badge{display:inline-flex;align-items:center;gap:7px;min-width:0;padding:6px 10px;border:1px solid #d7c6ab;border-radius:999px;background:#fffdf8;color:#745f43;font-size:10px;white-space:nowrap}
.beast-turn-badge i{width:7px;height:7px;border-radius:50%;background:#a64b3c}.beast-turn-badge i.upper{background:#63452f}.beast-turn-badge i.done{background:#a18b70}
.beast-online-board{position:relative;width:min(560px,100%)}
.beast-waiting-card{position:absolute;left:50%;top:50%;z-index:12;display:grid;justify-items:center;gap:7px;width:min(310px,calc(100% - 42px));padding:18px 20px;border:1px solid #c8b390;border-radius:14px;background:#fffaf0ed;box-shadow:0 22px 55px #36231542;transform:translate(-50%,-50%);text-align:center;backdrop-filter:blur(4px)}
.beast-waiting-card>span{color:#a27b43;font-size:9px;font-weight:700;letter-spacing:.14em}.beast-waiting-card h2{margin:0;font:700 20px/1.25 "Songti SC","SimSun",serif;color:#483b2e}.beast-waiting-card p{margin:0;color:#7d6c57;font-size:10px}.beast-waiting-card>div{display:grid;grid-template-columns:1fr 1fr;gap:7px;width:100%;margin-top:4px}.beast-waiting-card button{min-height:40px}
.beast-draw-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;width:min(560px,100%);padding:9px 11px;border:1px solid #c6a36f;border-radius:9px;background:#f7eedf;color:#745b39;font-size:10px}.beast-draw-bar>div{display:flex;gap:6px}
.beast-table-seat{--seat-color:#7d4b32;display:flex;align-items:center;gap:10px;width:min(560px,100%);min-height:52px;margin:0 auto;padding:5px 10px;border:1px solid #d6c7b3;border-radius:11px;background:linear-gradient(145deg,#fffdf8,#f8f2e8);color:#4d4236;transition:border-color .16s ease,box-shadow .16s ease}
.beast-table-seat.upper{--seat-color:#5c402e;margin-bottom:6px}.beast-table-seat.lower{--seat-color:#a64b3c;margin-top:0}.beast-table-seat.active{border-color:var(--seat-color);box-shadow:inset 3px 0 var(--seat-color),0 7px 18px #59432310}.beast-table-seat.ready>em{background:#e4efe4;color:#39704b}
.beast-seat-avatar{display:grid;place-items:center;width:36px;height:36px;flex:none;overflow:hidden;border:1px solid var(--seat-color);border-radius:9px;background:var(--seat-color);color:#fff8e8;font:700 19px/1 "STKaiti","KaiTi",serif}.beast-seat-avatar.placeholder{border-color:#c8bbab;background:#e7e1d7;color:#9c9080}.beast-seat-avatar img{width:100%;height:100%;object-fit:cover}
.beast-seat-copy{display:grid;gap:2px;min-width:0;flex:1}.beast-seat-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 18px/1.25 "Songti SC","SimSun",serif}.beast-seat-copy small{color:#8c7d6a;font-size:9px}.beast-table-seat>em{padding:3px 8px;border-radius:999px;background:#eee6da;color:#786a58;font-size:9px;font-style:normal;white-space:nowrap}
.beast-bottom-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;width:min(560px,100%);min-height:36px;color:#8a7964;font-size:9px}.beast-bottom-actions .primary-button{min-height:36px;padding:6px 16px;font-size:11px}
.beast-invite-text{width:min(560px,100%);padding:9px 11px;border:1px solid #d8cab5;border-radius:8px;background:#fffefb;color:#625444;font:500 10px/1.55 ui-monospace,Consolas,monospace;resize:none}
.beast-history{padding:14px;border:1px solid #ddd0bd;border-radius:12px;background:#fffdf8}.beast-history-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;color:#645647;font-size:12px}.beast-history-heading span{color:#94846f;font-size:10px}.beast-history .last-move-card{padding:13px}.beast-history .move-list{margin-top:12px;max-height:360px;overflow:auto}.beast-history .empty-history{display:block;padding:22px 8px;text-align:center;border:0}.beast-live-rules{margin-top:14px;padding-top:12px;border-top:1px solid #e4d9ca;color:#7e705f;font-size:10px;line-height:1.7}.beast-live-rules summary{cursor:pointer;font-weight:600;color:#715b3c}.beast-live-rules p{margin:7px 0 0}
.beast-page .result-banner{margin-top:0;width:min(560px,100%)}
.beast-seat-dialog{width:min(380px,calc(100vw - 32px));padding:24px;border:1px solid #d6c5aa;border-radius:14px;background:#fffaf0;color:#493d31;box-shadow:0 24px 70px #3d2d1a33}.beast-seat-dialog::backdrop,.beast-page .reset-dialog::backdrop{background:#372c204f;backdrop-filter:blur(2px)}.beast-seat-dialog form{display:grid;gap:15px}.beast-seat-dialog h2{font:700 22px/1.25 "Songti SC","SimSun",serif}.beast-seat-dialog label{display:grid;gap:7px;color:#615344;font-size:14px;font-weight:600}.beast-seat-dialog input{height:46px;border:1px solid #d8cab5;border-radius:9px;background:#fffefb;padding:0 13px;color:#3f352b;font:500 16px/1 inherit;outline:none}.beast-seat-dialog input:focus{border-color:#a78147;box-shadow:0 0 0 3px #a7814718}.beast-seat-dialog .connection-note{margin:0!important}.beast-seat-dialog .dialog-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}.beast-seat-dialog .dialog-actions button{min-height:44px}
.beast-page button:focus-visible{outline:2px solid #8c6d37;outline-offset:3px}
@media(max-width:900px){.beast-game-layout{grid-template-columns:minmax(0,1fr)}.beast-history{width:min(680px,100%);margin:0 auto}.beast-history .move-list{max-height:240px}}
@media(max-width:640px){.beast-page{padding:11px 0 30px}.beast-page-nav{margin-bottom:10px;padding-bottom:8px}.beast-heading{margin-bottom:10px}.beast-heading h1{font-size:31px;letter-spacing:3px}.beast-heading p{display:none}.beast-game-toolbar{min-height:36px;gap:5px}.beast-action-row{display:grid;grid-template-columns:repeat(3,auto);gap:5px}.beast-action-row button{min-height:34px;padding:5px 8px;font-size:10px}.beast-turn-badge{max-width:48vw;overflow:hidden;text-overflow:ellipsis;font-size:9px}.beast-table-seat{min-height:54px;padding:7px 9px;gap:8px}.beast-seat-avatar{width:36px;height:36px;font-size:18px}.beast-seat-copy strong{font-size:15px}.beast-seat-copy small{font-size:8px}.beast-table-seat>em{font-size:8px}.beast-table-seat.upper{margin-bottom:8px}.beast-waiting-card{padding:15px;width:min(300px,calc(100% - 30px))}.beast-waiting-card h2{font-size:18px}.beast-waiting-card>div{grid-template-columns:1fr}.beast-draw-bar{align-items:flex-start;flex-direction:column}.beast-draw-bar>div{width:100%;display:grid;grid-template-columns:1fr 1fr}.beast-draw-bar button{width:100%}.beast-bottom-actions{display:grid;grid-template-columns:1fr 1fr;gap:5px}.beast-bottom-actions .primary-button{grid-column:1 / -1;width:100%}.beast-history{padding:11px}.beast-seat-dialog{padding:20px}}
</style>
