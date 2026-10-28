<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue';
import { ORDER, PLAYERS, RULES_VERSION, TURN_CYCLE, at, legalMoves, newGame, pieceName, playMove, validGame } from './game.ts';
import type { Faction, Game, MoveRecord, Piece, Point } from './game.ts';
import { screenPoint } from './board-view.ts';
import { useOnlineRoom } from './useOnlineRoom.ts';

const storageKey = 'three-kingdoms-chess:independent-v1';
const legacyStorageKeys = ['three-kingdoms-chess:turn-cycle-v1', 'three-kingdoms-chess:capture-v0.1'];
let restored: { game: Game; undo: Game[] } = { game: newGame(), undo: [] };
let initialMessage = '请选择一枚魏方棋子，曹操先行。';
let requiresNewGame = false;
let storageUsable = true;
try {
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    try {
      const value = JSON.parse(raw);
      const validUndo = Array.isArray(value?.undo) && value.undo.every(validGame);
      if (value?.rulesVersion === RULES_VERSION && validGame(value.game) && validUndo) {
        restored = { game: value.game, undo: value.undo.slice(-50) };
        initialMessage = '已恢复上次棋局，继续行棋即可。';
      } else requiresNewGame = true;
    } catch { requiresNewGame = true; }
    if (requiresNewGame) initialMessage = '检测到无法无歧义恢复的存档，原数据已保留，请按新规则另开一局。';
  } else if (legacyStorageKeys.some(key => localStorage.getItem(key))) {
    requiresNewGame = true;
    initialMessage = '检测到旧联盟或四拍规则存档，原数据已保留，请按三方独立规则另开一局。';
  }
} catch { storageUsable = false; }
const localGame = ref<Game>(restored.game), undo = ref<Game[]>(restored.undo);
const selectedId = ref<string | null>(null), message = ref(initialMessage), feedbackError = ref(false);
const rulesDialog = ref<HTMLDialogElement | null>(null), resetDialog = ref<HTMLDialogElement | null>(null);
const resignDialog = ref<HTMLDialogElement | null>(null), exitDialog = ref<HTMLDialogElement | null>(null);
const sound = ref(false), saveAvailable = ref(storageUsable), compatibilityWarning = ref(requiresNewGame);
const online = useOnlineRoom();
const { mode, nickname, createCode, joinCode, room, self, connection, error: onlineError, exitNotice, busy: onlineBusy,
  spectating, watchCode } = online;
let afterExit: 'local' | 'spectate' | null = null;
const fallbackGame = newGame();
const game = computed(() => online.mode.value === 'online' ? (online.room.value?.game ?? fallbackGame) : localGame.value);
const onlineLobby = computed(() => online.mode.value === 'online' && (!online.room.value || online.room.value.phase === 'lobby'));
const previousGame = computed(() => online.room.value?.phase === 'lobby' && online.room.value.game?.status === 'finished' ? online.room.value.game : null);
const previousRanking = computed(() => previousGame.value ? ORDER.filter(f => previousGame.value!.placements[f]).sort((a, b) => previousGame.value!.placements[a]! - previousGame.value!.placements[b]!) : []);
const rematchBusy = ref(false);
const ownFaction = computed(() => online.mode.value === 'online' ? online.faction.value : null);
const flipOverride = ref(false);
const flipped = computed(() => (ownFaction.value === 'shu' || ownFaction.value === 'wu') !== flipOverride.value);
watch([ownFaction, mode], () => { flipOverride.value = false; });
const roomPlayer = (faction: Faction) => online.room.value?.players.find(player => player.faction === faction);
const factionTaken = (faction: Faction) => !!online.room.value?.players.some(player => player.id !== online.room.value?.selfId && player.faction === faction);
let audio: AudioContext | null = null;
const selected = computed(() => game.value.pieces.find(p => p.id === selectedId.value) ?? null);
const moves = computed(() => selected.value ? legalMoves(game.value.pieces, selected.value) : []);
const active = computed(() => game.value.turn ? PLAYERS[game.value.turn] : null);
const latest = computed(() => game.value.lastMove);
const records = computed(() => game.value.history.slice(-20).reverse());
const turnPosition = computed(() => game.value.turnSlot === null ? '' : game.value.eliminated.length
  ? `双人交替 · 当前${PLAYERS[game.value.turn!].nation}方` : `三拍循环 · 第 ${game.value.turnSlot + 1} 位`);
const ranking = computed(() => ORDER.filter(faction => game.value.placements[faction]).sort((a, b) => game.value.placements[a]! - game.value.placements[b]!));
const rankingText = computed(() => ranking.value.map(faction => `${game.value.placements[faction] === 1 ? '冠军' : `第${game.value.placements[faction]}名`} ${PLAYERS[faction].name}`).join(' · '));
const px = (x: number) => 50 + x * 55;
const py = (y: number) => 50 + y * 55;
const viewX = (x: number) => px(flipped.value ? 8 - x : x);
const viewY = (y: number) => py(flipped.value ? 9 - y : y);
const coordinate = (p: Point) => `(${p.x + 1}, ${p.y + 1})`;
const count = (faction: Faction) => game.value.pieces.filter(p => p.faction === faction).length;
const description = (record: MoveRecord) => `${pieceName(record)} ${coordinate(record.from)} → ${coordinate(record.to)}`;
const eliminatedNames = (record: MoveRecord) => record.eliminated.map(f => PLAYERS[f].name).join('、');
const capturedAt = (point: Point) => !!at(game.value.pieces, point);

watch([localGame, undo], () => {
  if (compatibilityWarning.value) return;
  try { localStorage.setItem(storageKey, JSON.stringify({ rulesVersion: RULES_VERSION, game: localGame.value, undo: undo.value.slice(-50) })); saveAvailable.value = true; }
  catch { saveAvailable.value = false; }
}, { deep: true });

watch(() => online.room.value?.version, () => {
  if (online.mode.value !== 'online') return;
  selectedId.value = null;
  feedbackError.value = false;
});

function notify(text: string, error = false) { message.value = text; feedbackError.value = error; }
function tone(capture: boolean) {
  if (!sound.value) return;
  try {
    audio ??= new AudioContext(); void audio.resume();
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(capture ? 380 : 620, audio.currentTime);
    gain.gain.setValueAtTime(0.075, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.09);
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.1);
  } catch { /* Optional sound never blocks a move. */ }
}
async function cellClick(x: number, y: number) {
  if (spectating.value) { notify('正在观战，不能操作棋子。', true); return; }
  if (online.mode.value === 'local' && compatibilityWarning.value) { notify('旧规则存档不能按三方独立规则续局，请另开一局。', true); return; }
  if (game.value.status !== 'playing') { notify(online.mode.value === 'online' ? '本局已结束，可以点击“再来一局”。' : '本局已经结束，可以悔棋复盘或重新开局。'); return; }
  const piece = at(game.value.pieces, { x, y });
  if (piece?.faction === game.value.turn) {
    if (online.mode.value === 'online' && piece.faction !== ownFaction.value) { notify(`你控制的是${ownFaction.value ? PLAYERS[ownFaction.value].nation : '未选择'}方，不能操作其他阵营。`, true); return; }
    selectedId.value = selectedId.value === piece.id ? null : piece.id;
    notify(selectedId.value ? `已选中${pieceName(piece)}，圆点是可走位置，红圈表示可吃子。` : `轮到${active.value?.name}行棋。`);
    return;
  }
  if (!selected.value) { notify(`轮到${active.value?.name}，请先选择本方棋子。`, !!piece); return; }
  if (online.mode.value === 'online') {
    const result = await online.move(selected.value.id, { x, y });
    if (!result.ok) { notify(result.error, true); return; }
    selectedId.value = null; feedbackError.value = false; tone(!!result.data.state.game?.lastMove?.captured); return;
  }
  const result = playMove(toRaw(localGame.value), selected.value.id, { x, y });
  if (!result.ok) { notify(result.error, true); return; }
  undo.value.push(structuredClone(toRaw(localGame.value)));
  if (undo.value.length > 50) undo.value.shift();
  localGame.value = result.game; selectedId.value = null;
  notify(result.notices.join(' ')); tone(!!result.game.lastMove?.captured);
}
function boardInput(clientX: number, clientY: number, svg: SVGSVGElement) {
  if (!selected.value) return;
  const matrix = svg.getScreenCTM();
  if (!matrix) return;
  const p = svg.createSVGPoint(); p.x = clientX; p.y = clientY;
  const actual = p.matrixTransform(matrix.inverse());
  const point = screenPoint(actual.x, actual.y, flipped.value);
  if (point) void cellClick(point.x, point.y);
}
function boardClick(event: MouseEvent) { boardInput(event.clientX, event.clientY, event.currentTarget as SVGSVGElement); }
function boardTouch(event: TouchEvent) {
  const touch = event.changedTouches[0];
  if (!touch) return;
  event.preventDefault();
  const target = event.target instanceof Element ? event.target.closest<SVGGElement>('[data-board-x]') : null;
  if (target) { void cellClick(Number(target.dataset.boardX), Number(target.dataset.boardY)); return; }
  boardInput(touch.clientX, touch.clientY, event.currentTarget as SVGSVGElement);
}
function undoMove() {
  if (online.mode.value === 'online') { notify('联机模式禁用单方悔棋。', true); return; }
  const previous = undo.value.pop();
  if (!previous) return;
  localGame.value = previous; selectedId.value = null;
  notify(`已撤回一步，轮到${active.value?.name ?? '本局已结束'}。`);
}
function reset() {
  if (online.mode.value === 'online') { notify('联机模式不能由单方重新开局。', true); return; }
  compatibilityWarning.value = false;
  localGame.value = newGame(); undo.value = []; selectedId.value = null;
  notify('三方独立对弈，棋子已归位，曹操先行。'); resetDialog.value?.close();
}
function resetRequest() {
  if (game.value.history.length) resetDialog.value?.showModal(); else reset();
}
function pieceLabel(piece: Piece) { return `${PLAYERS[piece.faction].nation}方${pieceName(piece)}，第${piece.x + 1}路第${piece.y + 1}线`; }
function onEscape() { selectedId.value = null; notify(active.value ? `轮到${active.value.name}行棋。` : message.value); }
async function copyInvite() { notify(await online.copyInvite() ? '邀请链接已复制，发给另外两位朋友即可。' : '复制失败，请手动复制浏览器地址。', false); }
function chooseMode(mode: 'local' | 'online' | 'spectate') {
  selectedId.value = null;
  if (mode === 'spectate') {
    if (spectating.value) return;
    if (online.room.value?.phase === 'playing' && ownFaction.value && !game.value.eliminated.includes(ownFaction.value)) {
      afterExit = 'spectate'; exitDialog.value?.showModal(); return;
    }
    if (online.room.value) online.leaveRoom();
    online.openWatchEntry(); notify('输入房间号即可只读观战。'); return;
  }
  if (mode === 'local') {
    if (online.room.value?.phase === 'playing' && ownFaction.value && !game.value.eliminated.includes(ownFaction.value)) {
      afterExit = 'local'; exitDialog.value?.showModal(); return;
    }
    online.useLocal(); notify('本地试玩：同一设备轮流操作三方。');
  }
  else { online.connect(); notify('联机对弈：三人各控制一个阵营。'); }
}
function requestLeave() {
  afterExit = null;
  if (room.value?.phase === 'playing' && ownFaction.value && !game.value.eliminated.includes(ownFaction.value))
    exitDialog.value?.showModal();
  else { online.leaveRoom(); selectedId.value = null; }
}
function confirmLeave() {
  exitDialog.value?.close(); online.leaveRoom(); selectedId.value = null;
  if (afterExit === 'spectate') online.openWatchEntry();
  else if (afterExit === 'local') online.useLocal();
  afterExit = null;
}
async function confirmResign() {
  resignDialog.value?.close();
  const result = await online.resign();
  notify(result.ok ? '已认输出局，可以留在房间查看后续对局。' : result.error, !result.ok);
}
async function releaseOffline(playerId: string) {
  const result = await online.releaseOffline(playerId);
  if (!result.ok) notify(result.error, true);
}
async function requestRematch() {
  if (rematchBusy.value || room.value?.phase !== 'finished') return;
  rematchBusy.value = true;
  try {
    const result = await online.rematch();
    if (!result.ok) notify(result.error, true);
  } finally { rematchBusy.value = false; }
}
</script>

<template>
  <div class="app-shell" :data-turn-slot="game.turnSlot ?? undefined" @keydown.esc="onEscape">
    <header class="site-header">
      <div class="brand"><span class="brand-seal" aria-hidden="true">弈</span><div><h1>三国象棋</h1><p>THREE KINGDOMS CHESS</p></div></div>
      <div class="header-actions"><div class="mode-switch" aria-label="游戏模式"><button :class="{active: mode === 'local'}" @click="chooseMode('local')">本地试玩</button><button :class="{active: mode === 'online' && !spectating}" @click="chooseMode('online')">联机对弈</button><button :class="{active: spectating}" @click="chooseMode('spectate')">观战</button></div><button class="plain-button" @click="rulesDialog?.showModal()">玩法说明 <span aria-hidden="true">↗</span></button></div>
    </header>
    <main v-if="onlineLobby" class="online-shell">
      <section v-if="spectating" class="online-entry watch-entry">
        <span class="eyebrow">观战</span><h2>{{ room ? `正在观战 · 房间 ${room.code}` : '输入房间号观战' }}</h2>
        <p v-if="room">{{ room.phase === 'lobby' ? '等待玩家准备' : '棋局正在进行' }}</p>
        <p v-else>等待中或已开局的房间均可观战，玩家满员也可以进入。</p>
        <div v-if="room" class="lobby-players"><article v-for="player in room.players" :key="player.id"><span class="online-dot" :class="{off: !player.online}"></span><div><strong>{{ player.nickname }}</strong><small>{{ player.online ? '在线' : '离线' }}</small></div><b>{{ player.faction ? PLAYERS[player.faction].nation + '方' : '未选阵营' }}</b><em>{{ player.ready ? '已准备' : '未准备' }}</em></article></div>
        <div v-if="room" class="room-heading-actions"><button class="tool-button" @click="online.exitWatching()">退出观战</button><button class="tool-button" @click="online.stopWatching()">更换房间</button></div>
        <div v-else class="join-row watch-join"><input v-model="watchCode" maxlength="6" inputmode="numeric" autocomplete="off" aria-label="观战房间号" placeholder="输入 6 位房间号" @input="watchCode = watchCode.toUpperCase()"><button class="primary-button" :disabled="onlineBusy || connection !== 'online'" @click="online.startWatching()">进入观战</button></div>
        <button v-if="!room" class="tool-button" @click="chooseMode('online')">返回联机大厅</button>
        <p v-if="connection !== 'online' || onlineError" class="connection-note" :class="{error: onlineError}">{{ onlineError || '连接中断，正在重连…' }}</p>
        <div v-if="previousGame" class="previous-game"><strong>上一局结果</strong><p v-for="faction in previousRanking" :key="faction">{{ previousGame.placements[faction] === 1 ? '冠军' : `第${previousGame.placements[faction]}名` }} · {{ PLAYERS[faction].name }}</p><details><summary>查看上一局棋谱（{{ previousGame.history.length }} 步）</summary><ol><li v-for="record in previousGame.history" :key="record.number">{{ record.number }}. {{ PLAYERS[record.faction].name }} · {{ description(record) }}</li></ol></details></div>
      </section>
      <section v-else-if="!room" class="online-entry">
        <span class="eyebrow">联机对弈</span><h2>和两位朋友进入同一房间</h2><p>每人选择魏、蜀、吴中的一个阵营。</p>
        <label>你的昵称<input v-model="nickname" maxlength="16" autocomplete="nickname" placeholder="最多 16 个字符"></label>
        <div class="entry-actions"><div class="join-row"><input v-model="createCode" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" autocomplete="off" aria-label="创建房间号" placeholder="自定 6 位数字房间号"><button class="primary-button" :disabled="onlineBusy || connection !== 'online'" @click="online.createRoom">创建房间</button></div><div class="join-row"><input v-model="joinCode" maxlength="6" inputmode="numeric" autocomplete="off" aria-label="加入房间号" placeholder="输入朋友的房间号" @input="joinCode = joinCode.toUpperCase()"><button class="tool-button" :disabled="onlineBusy || connection !== 'online'" @click="online.joinRoom">加入房间</button></div></div>
        <p v-if="connection !== 'online' || onlineError" class="connection-note" :class="{error: onlineError}">{{ onlineError || '连接中断，正在重连…' }}</p>
        <p v-if="exitNotice" class="connection-note" role="status">{{ exitNotice }}</p>
      </section>
      <section v-else class="room-lobby">
        <div class="room-heading"><div><span class="eyebrow">等待三人准备</span><h2>房间 {{ room.code }}</h2></div><div class="room-heading-actions"><button class="tool-button" @click="copyInvite">复制邀请链接</button><button class="tool-button leave-button" @click="requestLeave">退出房间</button></div></div>
        <div class="lobby-players"><article v-for="player in room.players" :key="player.id" :class="{self: player.id === room.selfId}"><span class="online-dot" :class="{off: !player.online}"></span><div><strong>{{ player.nickname }}</strong><small>{{ player.id === room.selfId ? '这是你' : player.online ? '在线' : '已断线，席位最多保留 60 秒' }}</small></div><b>{{ player.faction ? PLAYERS[player.faction].nation + '方' : '未选阵营' }}</b><em>{{ player.ready ? '已准备' : '未准备' }}</em><button v-if="!player.online && player.id !== room.selfId" class="tool-button release-button" :disabled="connection !== 'online'" @click="releaseOffline(player.id)">释放席位</button></article><article v-for="slot in 3 - room.players.length" :key="`empty-${slot}`" class="empty"><span>等待朋友加入…</span></article></div>
        <div class="faction-choice"><span>选择你的阵营</span><div><button v-for="faction in ORDER" :key="faction" :class="[faction,{selected: self?.faction === faction}]" :disabled="factionTaken(faction) || connection !== 'online'" @click="online.chooseFaction(faction)">{{ PLAYERS[faction].nation }} · {{ PLAYERS[faction].name }}</button></div></div>
        <button class="primary-button ready-button" :disabled="!self?.faction || connection !== 'online'" @click="online.setReady(!self?.ready)">{{ self?.ready ? '取消准备' : '我已准备' }}</button>
        <p class="lobby-tip">三人全部在线、阵营不同且准备完毕后自动开局。</p>
        <p v-if="onlineError" class="connection-note error">{{ onlineError }}</p>
        <div v-if="previousGame" class="previous-game"><strong>上一局结果</strong><p v-for="faction in previousRanking" :key="faction">{{ previousGame.placements[faction] === 1 ? '冠军' : `第${previousGame.placements[faction]}名` }} · {{ PLAYERS[faction].name }}</p><details><summary>查看上一局棋谱（{{ previousGame.history.length }} 步）</summary><ol><li v-for="record in previousGame.history" :key="record.number">{{ record.number }}. {{ PLAYERS[record.faction].name }} · {{ description(record) }}</li></ol></details></div>
      </section>
    </main>
    <main v-else class="play-layout">
      <aside class="players-panel" aria-label="玩家与当前回合">
        <div class="section-label"><span>本局席位</span><span>三人 · 独立竞争</span></div>
        <div class="player-cards">
          <section v-for="faction in ORDER" :key="faction" class="player-card" :class="{active: game.turn === faction, eliminated: game.eliminated.includes(faction)}" :style="{'--faction-color': PLAYERS[faction].color}" :aria-current="game.turn === faction ? 'true' : undefined">
            <div class="player-card-top">
              <div class="avatar" :class="{'avatar-lit': game.turn === faction}">{{ PLAYERS[faction].initial }}<span class="avatar-dot" v-if="game.turn === faction"></span></div>
              <div class="player-name"><span class="nation">{{ PLAYERS[faction].nation }}国</span><h2>{{ PLAYERS[faction].name }}</h2><p v-if="mode === 'online'">{{ roomPlayer(faction)?.nickname ?? '等待玩家' }} · {{ roomPlayer(faction)?.online ? '在线' : '离线' }}</p><p v-else>{{ PLAYERS[faction].team }}</p></div>
              <span class="seat-number">0{{ ORDER.indexOf(faction) + 1 }}</span>
            </div>
            <div class="player-card-bottom"><span>{{ count(faction) }} 枚子力</span><strong v-if="game.placements[faction]">{{ game.placements[faction] === 1 ? '冠军' : `第${game.placements[faction]}名` }}</strong><strong v-else-if="game.turn === faction" class="turn-label"><i></i>正在行棋</strong><span v-else>等待回合</span></div>
          </section>
        </div>
        <div class="turn-order"><span>行棋顺序</span><p><template v-for="(faction, slot) in TURN_CYCLE" :key="slot"><b v-if="slot">›</b><strong :class="{current: game.turnSlot === slot, eliminated: game.eliminated.includes(faction)}">{{ PLAYERS[faction].name }}</strong></template></p><small>出局方跳过，剩余两国严格交替</small></div>
        <div class="alliance-note"><span class="tiny-seal">竞</span><p>三方独立竞争<br><strong>可自由选择合作或进攻，名次按出局顺序确定</strong></p></div>
        <div class="ranking-card"><strong>本局名次</strong><p v-for="faction in ranking" :key="faction">{{ game.placements[faction] === 1 ? '冠军' : `第${game.placements[faction]}名` }} · {{ PLAYERS[faction].name }}</p><small v-if="game.status === 'playing'">其余名次待对局继续确定</small></div>
      </aside>

      <section class="board-panel" aria-label="三国象棋棋盘">
        <div class="board-heading"><div><span class="eyebrow">秦岭淮河 · {{ mode === 'online' ? `${spectating ? '正在观战' : '联机房间'} ${room?.code}` : '本地试玩' }}</span><h2 v-if="active">轮到 <span :style="{color: active.color}">{{ active.name }}</span> 行棋</h2><h2 v-else>{{ PLAYERS[game.winner!].name }}获得冠军</h2><small v-if="turnPosition" class="turn-position">{{ turnPosition }}</small></div><span class="move-count">第 <strong>{{ game.history.length + (game.status === 'playing' ? 1 : 0) }}</strong> 步</span></div>
        <div v-if="mode === 'online' && connection !== 'online'" class="network-banner" role="alert">连接中断，正在重连…</div>
        <div v-if="mode === 'local' && compatibilityWarning" class="legacy-save-banner" role="alert"><div><strong>旧存档已保留</strong><p>旧联盟或四拍规则与三方独立竞争不兼容，无法安全续局。</p></div><button class="primary-button" @click="reset">按新规则另开一局</button></div>
        <div class="board-frame">
          <svg class="board-svg" viewBox="0 0 540 595" role="group" :aria-label="`九路十横线棋盘，${flipped ? '已翻转' : '标准'}视角；坐标标识为标准坐标`" @click="boardClick" @touchend="boardTouch">
            <defs>
              <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#efdab4"/><stop offset="1" stop-color="#e5c897"/></linearGradient>
              <pattern id="grain" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M0 6 H18 M0 15 H18" stroke="#755935" stroke-opacity=".035"/></pattern>
              <marker id="trail-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a77b36"/></marker>
            </defs>
            <rect x="8" y="8" width="524" height="579" rx="8" fill="url(#wood)"/>
            <rect x="8" y="8" width="524" height="579" rx="8" fill="url(#grain)"/>
            <rect x="37" y="37" width="466" height="521" fill="none" stroke="#674d2f" stroke-width="1.4"/>
            <g class="grid-lines">
              <line v-for="n in 10" :key="`h${n}`" :x1="px(0)" :x2="px(8)" :y1="py(n-1)" :y2="py(n-1)"/>
              <template v-for="n in 9" :key="`v${n}`"><line :x1="px(n-1)" :x2="px(n-1)" :y1="py(0)" :y2="py(4)"/><line :x1="px(n-1)" :x2="px(n-1)" :y1="py(5)" :y2="py(9)"/></template>
              <line :x1="px(0)" :x2="px(0)" :y1="py(4)" :y2="py(5)"/><line :x1="px(8)" :x2="px(8)" :y1="py(4)" :y2="py(5)"/>
              <path :d="`M${px(3)} ${py(0)} L${px(5)} ${py(2)} M${px(5)} ${py(0)} L${px(3)} ${py(2)} M${px(3)} ${py(7)} L${px(5)} ${py(9)} M${px(5)} ${py(7)} L${px(3)} ${py(9)}`"/>
            </g>
            <g class="coordinates"><text v-for="n in 9" :key="n" :x="px(n-1)" y="25">{{ flipped ? 10 - n : n }}</text><text v-for="n in 10" :key="`row${n}`" x="24" :y="py(n-1)+4">{{ flipped ? 11 - n : n }}</text></g>
            <text class="river" x="175" y="305">{{ flipped ? '淮 河' : '秦 岭' }}</text><text class="river" x="365" y="305">{{ flipped ? '秦 岭' : '淮 河' }}</text>
            <g v-if="latest" class="last-trail" aria-hidden="true"><line :x1="viewX(latest.from.x)" :y1="viewY(latest.from.y)" :x2="viewX(latest.to.x)" :y2="viewY(latest.to.y)" marker-end="url(#trail-tip)"/><rect :x="viewX(latest.from.x)-18" :y="viewY(latest.from.y)-18" width="36" height="36" rx="4"/><circle :cx="viewX(latest.to.x)" :cy="viewY(latest.to.y)" r="26"/></g>
            <g v-for="point in moves" :key="`${point.x},${point.y}`" class="legal-point" role="button" tabindex="0" :data-board-x="point.x" :data-board-y="point.y" :aria-label="`${capturedAt(point) ? '吃子到' : '走到'}第${point.x+1}路第${point.y+1}线`" @click.stop="cellClick(point.x,point.y)" @keydown.enter.prevent.stop="cellClick(point.x,point.y)" @keydown.space.prevent.stop="cellClick(point.x,point.y)">
              <circle :cx="viewX(point.x)" :cy="viewY(point.y)" r="23" fill="transparent"/><circle :cx="viewX(point.x)" :cy="viewY(point.y)" :r="capturedAt(point) ? 27 : 6" :class="capturedAt(point) ? 'capture-ring' : 'move-dot'"/>
            </g>
            <g v-for="piece in game.pieces" :key="piece.id" class="piece" :class="[piece.faction,{selected: selectedId === piece.id}]" :style="{transform: `translate(${viewX(piece.x)}px, ${viewY(piece.y)}px)`}" role="button" tabindex="0" :data-board-x="piece.x" :data-board-y="piece.y" :aria-label="pieceLabel(piece)" :aria-pressed="selectedId === piece.id" @click.stop="cellClick(piece.x,piece.y)" @keydown.enter.prevent.stop="cellClick(piece.x,piece.y)" @keydown.space.prevent.stop="cellClick(piece.x,piece.y)">
              <circle class="selection-ring" r="27"/><circle class="piece-shadow" cy="2.5" r="23"/><circle class="piece-face" r="23"/><circle class="piece-rim" r="19.5"/><text :class="{general: piece.kind === 'king'}" y="1">{{ pieceName(piece) }}</text>
            </g>
          </svg>
        </div>
        <div class="board-tools"><button v-if="mode === 'local'" class="tool-button" :disabled="compatibilityWarning || !undo.length" @click="undoMove"><span aria-hidden="true">↶</span> 悔棋</button><button v-if="mode === 'local'" class="tool-button" @click="resetRequest"><span aria-hidden="true">↻</span> 重新开局</button><button v-if="mode === 'online' && !spectating && room?.phase === 'finished'" class="primary-button rematch-button" :disabled="rematchBusy || connection !== 'online'" @click="requestRematch">{{ rematchBusy ? '请稍候…' : '再来一局' }}</button><button class="tool-button flip-button" :aria-pressed="flipped" @click="flipOverride = !flipOverride">翻转棋盘</button><button class="tool-button sound-button" :aria-pressed="sound" @click="sound = !sound">音效 {{ sound ? '开' : '关' }}</button><button v-if="mode === 'online' && !spectating && room?.phase === 'playing' && ownFaction && !game.eliminated.includes(ownFaction)" class="tool-button resign-button" @click="resignDialog?.showModal()">认输</button><button v-if="mode === 'online' && !spectating" class="tool-button leave-button" @click="requestLeave">退出房间</button><button v-if="spectating" class="tool-button leave-button" @click="online.exitWatching()">退出观战</button></div>
        <p v-if="mode === 'local' || feedbackError" class="feedback" :class="{error: feedbackError}" role="status" aria-live="polite"><span class="feedback-icon" aria-hidden="true">{{ feedbackError ? '!' : '›' }}</span>{{ message }}</p>
        <div v-if="game.status === 'finished'" class="result-banner"><strong>{{ PLAYERS[game.winner!].name }}夺冠</strong><span>{{ rankingText }}。本局共 {{ game.history.length }} 步。</span></div>
      </section>

      <aside class="history-panel" aria-label="行棋记录">
        <div class="section-label"><span>行棋记录</span><span>{{ game.history.length }} 步</span></div>
        <div class="last-move-card"><span class="eyebrow">上一步</span><template v-if="latest"><h3 :style="{color: PLAYERS[latest.faction].color}">{{ PLAYERS[latest.faction].name }} · {{ pieceName(latest) }}</h3><p>{{ coordinate(latest.from) }} <b>→</b> {{ coordinate(latest.to) }}</p><small>{{ latest.captured ? `吃掉${PLAYERS[latest.captured.faction].name}的${pieceName(latest.captured)}` : '已标记起点和落点' }}</small></template><template v-else><h3>棋局已就绪</h3><p>曹操先行</p><small>走子后保留起点与落点痕迹</small></template></div>
        <ol v-if="records.length" class="move-list"><li v-for="record in records" :key="record.number"><span class="record-number">{{ String(record.number).padStart(2,'0') }}</span><div><strong :style="{color: PLAYERS[record.faction].color}">{{ PLAYERS[record.faction].name }}</strong><p>{{ description(record) }}</p><small v-if="record.eliminated.length">{{ eliminatedNames(record) }}出局 · 名次见本局席位</small></div></li></ol>
        <div v-else class="empty-history"><span aria-hidden="true">弈</span><p>第一步，开启新棋局。</p></div>
        <div class="board-legend"><p><i class="legend-dot"></i> 可走位置</p><p><i class="legend-ring"></i> 可以吃子</p><p><i class="legend-square"></i> 上一步起点与落点</p><small>棋盘边缘显示标准棋谱坐标；当前左上角为第 {{ flipped ? 9 : 1 }} 路、第 {{ flipped ? 10 : 1 }} 线。</small></div>
      </aside>
    </main>
    <footer class="site-footer"><span>三人同局，魏蜀吴对弈 · 当前为试玩规则。</span><span v-if="mode === 'local'">{{ saveAvailable ? '棋局自动保存在本机' : '本机保存不可用，请保持页面打开' }}</span></footer>
    <dialog ref="rulesDialog" class="rules-dialog"><div class="dialog-heading"><h2>本轮试玩规则</h2><button class="dialog-close" aria-label="关闭规则" @click="rulesDialog?.close()">×</button></div><p>本地模式可在同一页面轮流控制三国；联机模式中三人各控制自己的阵营。魏 → 蜀 → 吴循环，每方每回合只走一步。魏方默认标准视角，蜀吴默认翻转视角；“翻转棋盘”只改变个人看到的画面。输入房间号可只读观战。</p><ul><li>三方独立竞争。任意不同阵营可以按棋子走法互相吃子；同国棋子不能互吃。</li><li>主公被吃或轮到本国时无合法走法，该国出局并清空全部棋子；剩余两国严格交替。</li><li>第一位出局为第三名，第二位出局为第二名，最后存活方为冠军。曹操先出局时蜀吴继续对弈。</li><li>锋：向前一或两格；向后、向左、向右一格，不能跳子。</li><li>刘备、孙权：上方底线第 2～8 路，每次横走一格。曹操仍在下方九宫。</li><li>任意棋子都可以作炮架。取消对面笑；其余棋子的基本走法沿用中国象棋。</li></ul><div class="trial-rule"><strong>这一轮的临时约定</strong><p>以吃主公判出局，不强制应将，也不禁止送将。重复局面的判和次数尚待确认，本版不自动判重复和棋。</p></div><button class="primary-button" @click="rulesDialog?.close()">知道了，继续行棋</button></dialog>
    <dialog ref="resetDialog" class="reset-dialog"><h2>重新开局？</h2><p>当前棋局与行棋记录将清空，三国棋子回到初始位置。</p><div class="dialog-actions"><button class="tool-button" @click="resetDialog?.close()">继续本局</button><button class="primary-button" @click="reset">重新开局</button></div></dialog>
    <dialog ref="resignDialog" class="reset-dialog"><h2>确认认输？</h2><p>本国立即出局并清空棋子，名次按出局先后确定；你仍可留在房间查看。</p><div class="dialog-actions"><button class="tool-button" @click="resignDialog?.close()">继续对局</button><button class="primary-button" @click="confirmResign">确认认输</button></div></dialog>
    <dialog ref="exitDialog" class="reset-dialog"><h2>确认退出房间？</h2><p>你仍在对局中，退出将先按认输出局，再返回大厅。断网时本机立即退出，服务器恢复连接后补发通知。</p><div class="dialog-actions"><button class="tool-button" @click="exitDialog?.close()">继续对局</button><button class="primary-button" @click="confirmLeave">确认退出</button></div></dialog>
  </div>
</template>
