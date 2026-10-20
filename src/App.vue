<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue';
import { ORDER, PLAYERS, RULES_VERSION, TURN_CYCLE, at, legalMoves, newGame, pieceName, playMove, validGame } from './game.ts';
import type { Faction, Game, MoveRecord, Piece, Point } from './game.ts';

const storageKey = 'three-kingdoms-chess:turn-cycle-v1';
const legacyStorageKey = 'three-kingdoms-chess:capture-v0.1';
let restored: { game: Game; undo: Game[] } = { game: newGame(), undo: [] };
let initialMessage = '请选择一枚魏方棋子，曹操先行。';
let requiresNewGame = false;
let storageUsable = true;
try {
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    const value = JSON.parse(raw);
    const validUndo = Array.isArray(value.undo) && value.undo.every(validGame);
    if (value.rulesVersion === RULES_VERSION && validGame(value.game) && validUndo) {
      restored = { game: value.game, undo: value.undo.slice(-50) };
      initialMessage = '已恢复上次棋局，继续行棋即可。';
    } else {
      requiresNewGame = true;
      initialMessage = '检测到无法无歧义恢复的存档，原数据已保留，请按新规则另开一局。';
    }
  } else if (localStorage.getItem(legacyStorageKey)) {
    requiresNewGame = true;
    initialMessage = '检测到旧轮次规则存档，原数据已保留，请按新规则另开一局。';
  }
} catch { storageUsable = false; }
const game = ref<Game>(restored.game), undo = ref<Game[]>(restored.undo);
const selectedId = ref<string | null>(null), message = ref(initialMessage), feedbackError = ref(false);
const rulesDialog = ref<HTMLDialogElement | null>(null), resetDialog = ref<HTMLDialogElement | null>(null);
const sound = ref(false), saveAvailable = ref(storageUsable), compatibilityWarning = ref(requiresNewGame);
let audio: AudioContext | null = null;
const selected = computed(() => game.value.pieces.find(p => p.id === selectedId.value) ?? null);
const moves = computed(() => selected.value ? legalMoves(game.value.pieces, selected.value) : []);
const active = computed(() => game.value.turn ? PLAYERS[game.value.turn] : null);
const latest = computed(() => game.value.lastMove);
const records = computed(() => game.value.history.slice(-20).reverse());
const turnPosition = computed(() => game.value.turnSlot === null ? '' : game.value.eliminated.length
  ? `双人交替 · 循环位 ${game.value.turnSlot + 1}` : `四拍循环 · 第 ${game.value.turnSlot + 1} 位`);
const px = (x: number) => 50 + x * 55;
const py = (y: number) => 50 + y * 55;
const coordinate = (p: Point) => `(${p.x + 1}, ${p.y + 1})`;
const count = (faction: Faction) => game.value.pieces.filter(p => p.faction === faction).length;
const description = (record: MoveRecord) => `${pieceName(record)} ${coordinate(record.from)} → ${coordinate(record.to)}`;
const eliminatedNames = (record: MoveRecord) => record.eliminated.map(f => PLAYERS[f].name).join('、');
const capturedAt = (point: Point) => !!at(game.value.pieces, point);

watch([game, undo], () => {
  if (compatibilityWarning.value) return;
  try { localStorage.setItem(storageKey, JSON.stringify({ rulesVersion: RULES_VERSION, game: game.value, undo: undo.value.slice(-50) })); saveAvailable.value = true; }
  catch { saveAvailable.value = false; }
}, { deep: true });

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
function cellClick(x: number, y: number) {
  if (compatibilityWarning.value) { notify('旧存档无法确定魏方处于哪个轮次位置，请先按新规则另开一局。', true); return; }
  if (game.value.status !== 'playing') { notify('本局已经结束，可以悔棋复盘或重新开局。'); return; }
  const piece = at(game.value.pieces, { x, y });
  if (piece?.faction === game.value.turn) {
    selectedId.value = selectedId.value === piece.id ? null : piece.id;
    notify(selectedId.value ? `已选中${pieceName(piece)}，圆点是可走位置，红圈表示可吃子。` : `轮到${active.value?.name}行棋。`);
    return;
  }
  if (!selected.value) { notify(`轮到${active.value?.name}，请先选择本方棋子。`, !!piece); return; }
  const result = playMove(toRaw(game.value), selected.value.id, { x, y });
  if (!result.ok) { notify(result.error, true); return; }
  undo.value.push(structuredClone(toRaw(game.value)));
  if (undo.value.length > 50) undo.value.shift();
  game.value = result.game; selectedId.value = null;
  notify(result.notices.join(' ')); tone(!!result.game.lastMove?.captured);
}
function boardClick(event: MouseEvent) {
  if (!selected.value) return;
  const svg = event.currentTarget as SVGSVGElement, matrix = svg.getScreenCTM();
  if (!matrix) return;
  const p = svg.createSVGPoint(); p.x = event.clientX; p.y = event.clientY;
  const actual = p.matrixTransform(matrix.inverse());
  const x = Math.round((actual.x - 50) / 55), y = Math.round((actual.y - 50) / 55);
  if (Math.abs(actual.x - px(x)) <= 26 && Math.abs(actual.y - py(y)) <= 26) cellClick(x, y);
}
function undoMove() {
  const previous = undo.value.pop();
  if (!previous) return;
  game.value = previous; selectedId.value = null;
  notify(`已撤回一步，轮到${active.value?.name ?? '本局已结束'}。`);
}
function reset() {
  compatibilityWarning.value = false;
  game.value = newGame(); undo.value = []; selectedId.value = null;
  notify('棋子已归位，曹操先行。'); resetDialog.value?.close();
}
function resetRequest() {
  if (game.value.history.length) resetDialog.value?.showModal(); else reset();
}
function pieceLabel(piece: Piece) { return `${PLAYERS[piece.faction].nation}方${pieceName(piece)}，第${piece.x + 1}路第${piece.y + 1}线`; }
function onEscape() { selectedId.value = null; notify(active.value ? `轮到${active.value.name}行棋。` : message.value); }
</script>

<template>
  <div class="app-shell" :data-turn-slot="game.turnSlot ?? undefined" @keydown.esc="onEscape">
    <header class="site-header">
      <div class="brand"><span class="brand-seal" aria-hidden="true">弈</span><div><h1>三国象棋</h1><p>THREE KINGDOMS CHESS</p></div></div>
      <div class="header-actions"><span class="mode-tag"><i></i>同屏试玩</span><button class="plain-button" @click="rulesDialog?.showModal()">玩法说明 <span aria-hidden="true">↗</span></button></div>
    </header>
    <main class="play-layout">
      <aside class="players-panel" aria-label="玩家与当前回合">
        <div class="section-label"><span>本局席位</span><span>三人 · 两队</span></div>
        <div class="player-cards">
          <section v-for="faction in ORDER" :key="faction" class="player-card" :class="{active: game.turn === faction, eliminated: game.eliminated.includes(faction)}" :style="{'--faction-color': PLAYERS[faction].color}" :aria-current="game.turn === faction ? 'true' : undefined">
            <div class="player-card-top">
              <div class="avatar" :class="{'avatar-lit': game.turn === faction}">{{ PLAYERS[faction].initial }}<span class="avatar-dot" v-if="game.turn === faction"></span></div>
              <div class="player-name"><span class="nation">{{ PLAYERS[faction].nation }}国</span><h2>{{ PLAYERS[faction].name }}</h2><p>{{ PLAYERS[faction].team }}</p></div>
              <span class="seat-number">0{{ ORDER.indexOf(faction) + 1 }}</span>
            </div>
            <div class="player-card-bottom"><span>{{ count(faction) }} 枚子力</span><strong v-if="game.eliminated.includes(faction)">已出局</strong><strong v-else-if="game.turn === faction" class="turn-label"><i></i>正在行棋</strong><span v-else-if="game.status === 'playing'">等待回合</span><strong v-else>{{ (game.winner === 'wei') === (faction === 'wei') ? '获胜' : '本局结束' }}</strong></div>
          </section>
        </div>
        <div class="turn-order"><span>行棋顺序</span><p><template v-for="(faction, slot) in TURN_CYCLE" :key="slot"><b v-if="slot">›</b><strong :class="{current: game.turnSlot === slot}">{{ PLAYERS[faction].name }}</strong></template></p><small>蜀或吴出局后，魏与剩余一方交替</small></div>
        <div class="alliance-note"><span class="tiny-seal">盟</span><p>刘备与孙权结盟<br><strong>互不吃子，共同对抗曹操</strong></p></div>
      </aside>

      <section class="board-panel" aria-label="三国象棋棋盘">
        <div class="board-heading"><div><span class="eyebrow">秦岭淮河 · 首版棋局</span><h2 v-if="active">轮到 <span :style="{color: active.color}">{{ active.name }}</span> 行棋</h2><h2 v-else>{{ game.winner === 'wei' ? '曹操获胜' : '蜀吴联盟获胜' }}</h2><small v-if="turnPosition" class="turn-position">{{ turnPosition }}</small></div><span class="move-count">第 <strong>{{ game.history.length + (game.status === 'playing' ? 1 : 0) }}</strong> 步</span></div>
        <div v-if="compatibilityWarning" class="legacy-save-banner" role="alert"><div><strong>旧存档已保留</strong><p>旧规则未记录魏方的具体循环位，无法安全续局。</p></div><button class="primary-button" @click="reset">按新规则另开一局</button></div>
        <div class="board-frame">
          <svg class="board-svg" viewBox="0 0 540 595" role="group" aria-label="九路十横线棋盘，坐标从左上角起编号" @click="boardClick">
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
            <g class="coordinates"><text v-for="n in 9" :key="n" :x="px(n-1)" y="25">{{ n }}</text><text v-for="n in 10" :key="`row${n}`" x="24" :y="py(n-1)+4">{{ n }}</text></g>
            <text class="river" x="175" y="305">秦 岭</text><text class="river" x="365" y="305">淮 河</text>
            <g v-if="latest" class="last-trail" aria-hidden="true"><line :x1="px(latest.from.x)" :y1="py(latest.from.y)" :x2="px(latest.to.x)" :y2="py(latest.to.y)" marker-end="url(#trail-tip)"/><rect :x="px(latest.from.x)-18" :y="py(latest.from.y)-18" width="36" height="36" rx="4"/><circle :cx="px(latest.to.x)" :cy="py(latest.to.y)" r="26"/></g>
            <g v-for="point in moves" :key="`${point.x},${point.y}`" class="legal-point" role="button" tabindex="0" :aria-label="`${capturedAt(point) ? '吃子到' : '走到'}第${point.x+1}路第${point.y+1}线`" @click.stop="cellClick(point.x,point.y)" @keydown.enter.prevent.stop="cellClick(point.x,point.y)" @keydown.space.prevent.stop="cellClick(point.x,point.y)">
              <circle :cx="px(point.x)" :cy="py(point.y)" r="23" fill="transparent"/><circle :cx="px(point.x)" :cy="py(point.y)" :r="capturedAt(point) ? 27 : 6" :class="capturedAt(point) ? 'capture-ring' : 'move-dot'"/>
            </g>
            <g v-for="piece in game.pieces" :key="piece.id" class="piece" :class="[piece.faction,{selected: selectedId === piece.id}]" :style="{transform: `translate(${px(piece.x)}px, ${py(piece.y)}px)`}" role="button" tabindex="0" :aria-label="pieceLabel(piece)" :aria-pressed="selectedId === piece.id" @click.stop="cellClick(piece.x,piece.y)" @keydown.enter.prevent.stop="cellClick(piece.x,piece.y)" @keydown.space.prevent.stop="cellClick(piece.x,piece.y)">
              <circle class="selection-ring" r="27"/><circle class="piece-shadow" cy="2.5" r="23"/><circle class="piece-face" r="23"/><circle class="piece-rim" r="19.5"/><text :class="{general: piece.kind === 'king'}" y="1">{{ pieceName(piece) }}</text>
            </g>
          </svg>
        </div>
        <div class="board-tools"><button class="tool-button" :disabled="compatibilityWarning || !undo.length" @click="undoMove"><span aria-hidden="true">↶</span> 悔棋</button><button class="tool-button" @click="resetRequest"><span aria-hidden="true">↻</span> 重新开局</button><button class="tool-button sound-button" :aria-pressed="sound" @click="sound = !sound">音效 {{ sound ? '开' : '关' }}</button></div>
        <p class="feedback" :class="{error: feedbackError}" role="status" aria-live="polite"><span class="feedback-icon" aria-hidden="true">{{ feedbackError ? '!' : '›' }}</span>{{ message }}</p>
        <div v-if="game.status === 'finished'" class="result-banner"><strong>{{ game.winner === 'wei' ? '魏方胜 · 曹操获胜' : '联盟胜 · 刘备与孙权共同获胜' }}</strong><span>本局共 {{ game.history.length }} 步，棋谱保留供复盘。</span></div>
      </section>

      <aside class="history-panel" aria-label="行棋记录">
        <div class="section-label"><span>行棋记录</span><span>{{ game.history.length }} 步</span></div>
        <div class="last-move-card"><span class="eyebrow">上一步</span><template v-if="latest"><h3 :style="{color: PLAYERS[latest.faction].color}">{{ PLAYERS[latest.faction].name }} · {{ pieceName(latest) }}</h3><p>{{ coordinate(latest.from) }} <b>→</b> {{ coordinate(latest.to) }}</p><small>{{ latest.captured ? `吃掉${PLAYERS[latest.captured.faction].name}的${pieceName(latest.captured)}` : '已标记起点和落点' }}</small></template><template v-else><h3>棋局已就绪</h3><p>曹操先行</p><small>走子后保留起点与落点痕迹</small></template></div>
        <ol v-if="records.length" class="move-list"><li v-for="record in records" :key="record.number"><span class="record-number">{{ String(record.number).padStart(2,'0') }}</span><div><strong :style="{color: PLAYERS[record.faction].color}">{{ PLAYERS[record.faction].name }}</strong><p>{{ description(record) }}</p><small v-if="record.eliminated.length">{{ eliminatedNames(record) }}出局</small></div></li></ol>
        <div v-else class="empty-history"><span aria-hidden="true">弈</span><p>第一步，开启新棋局。</p></div>
        <div class="board-legend"><p><i class="legend-dot"></i> 可走位置</p><p><i class="legend-ring"></i> 可以吃子</p><p><i class="legend-square"></i> 上一步起点与落点</p><small>坐标从左上角起：第 1 路、第 1 线。</small></div>
      </aside>
    </main>
    <footer class="site-footer"><span>三人同局，魏蜀吴对弈。</span><span>{{ saveAvailable ? '棋局自动保存在本机' : '本机保存不可用，请保持页面打开' }}</span></footer>
    <dialog ref="rulesDialog" class="rules-dialog"><div class="dialog-heading"><h2>本轮试玩规则</h2><button class="dialog-close" aria-label="关闭规则" @click="rulesDialog?.close()">×</button></div><p>同一页面轮流控制三国。三方存活时按曹操 → 刘备 → 曹操 → 孙权循环，每个位置只走一步。</p><ul><li>蜀或吴出局后，曹操与剩余一方严格交替，不会连续行动。</li><li>锋：向前一或两格；向后、向左、向右一格，不能跳子。</li><li>刘备、孙权：上方底线第 2～8 路，每次横走一格。曹操仍在下方九宫。</li><li>蜀吴互不吃子，也不能落在本方或盟友占据的位置。所有棋子都可以作炮架。</li><li>蜀吴主公被吃或该国困毙，全军清空。曹操出局则联盟胜；蜀吴均出局则曹操胜。</li><li>取消对面笑；其余棋子的基本走法沿用中国象棋。</li></ul><div class="trial-rule"><strong>这一轮的临时约定</strong><p>以吃主公判胜负，不强制应将，也不禁止送将。重复局面的判和次数尚待确认，本版不自动判重复和棋。</p></div><button class="primary-button" @click="rulesDialog?.close()">知道了，继续行棋</button></dialog>
    <dialog ref="resetDialog" class="reset-dialog"><h2>重新开局？</h2><p>当前棋局与行棋记录将清空，三国棋子回到初始位置。</p><div class="dialog-actions"><button class="tool-button" @click="resetDialog?.close()">继续本局</button><button class="primary-button" @click="reset">重新开局</button></div></dialog>
  </div>
</template>
