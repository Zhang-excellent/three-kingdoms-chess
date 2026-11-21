<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import BeastChessBoard from './BeastChessBoard.vue';
import {
  BEAST_KIND_NAMES,
  BEAST_SIDE_NAMES,
  beastCoordinate,
  beastPieceAt,
  capturedBeastPieces,
  legalBeastMoves,
  newBeastGame,
  playBeastMove,
  undoBeastMove,
} from '../beast-chess.ts';
import type { BeastGame, BeastPiece, BeastPoint, BeastSide } from '../beast-chess.ts';

const emit = defineEmits<{ other: [] }>();

const game = shallowRef<BeastGame>(newBeastGame());
const selectedId = ref<string | null>(null);
const notice = ref('');
const error = ref('');
const rulesDialog = ref<HTMLDialogElement | null>(null);

const selected = computed<BeastPiece | null>(() => selectedId.value
  ? game.value.pieces.find(piece => piece.id === selectedId.value) ?? null
  : null);
const targets = computed(() => selected.value ? legalBeastMoves(game.value, selected.value.id) : []);
const counts = computed(() => ({
  lower: game.value.pieces.filter(piece => piece.side === 'lower').length,
  upper: game.value.pieces.filter(piece => piece.side === 'upper').length,
}));
const captured = computed(() => capturedBeastPieces(game.value));
const turnText = computed(() => game.value.status === 'playing' && game.value.turn
  ? `轮到${BEAST_SIDE_NAMES[game.value.turn]}行棋`
  : '本局已经结束');
const resultTitle = computed(() => {
  if (game.value.status !== 'finished') return '';
  if (game.value.drawReason === 'threefold') return '三次重复，和棋';
  if (game.value.drawReason === 'halfmove') return '百步无吃子，和棋';
  return game.value.winner ? `${BEAST_SIDE_NAMES[game.value.winner]}获胜` : '本局和棋';
});
const resultDetail = computed(() => {
  if (game.value.finishReason === 'den') return '进攻棋子踏入敌方兽穴。';
  if (game.value.finishReason === 'capture-all') return '对方棋子已全部被吃。';
  if (game.value.finishReason === 'stalemate') return '轮到对方时已没有任何合法走法。';
  if (game.value.finishReason === 'threefold') return '同一完整局面已经出现三次。';
  if (game.value.finishReason === 'halfmove') return '连续一百个半回合没有发生吃子。';
  return '';
});
const lastMoveText = computed(() => {
  const move = game.value.lastMove;
  if (!move) return '尚未走棋';
  const capture = move.captured ? `，吃${BEAST_KIND_NAMES[move.captured.kind]}` : '';
  const jump = move.jumpedRiver ? '，跳过河流' : '';
  return `${BEAST_SIDE_NAMES[move.side]}${BEAST_KIND_NAMES[move.kind]} ${beastCoordinate(move.from)} → ${beastCoordinate(move.to)}${capture}${jump}`;
});

function coordinate(point: BeastPoint): string {
  return beastCoordinate(point);
}

function selectCell(point: BeastPoint) {
  if (game.value.status !== 'playing') return;
  notice.value = '';
  const piece = beastPieceAt(game.value.pieces, point);
  if (piece?.side === game.value.turn) {
    selectedId.value = selectedId.value === piece.id ? null : piece.id;
    error.value = '';
    return;
  }
  if (!selected.value) {
    error.value = piece
      ? `现在轮到${BEAST_SIDE_NAMES[game.value.turn!]}行棋。`
      : '请先选择当前一方的棋子。';
    return;
  }
  if (!targets.value.some(target => target.x === point.x && target.y === point.y)) {
    error.value = piece ? '这不是当前棋子的合法吃子位置。' : '这不是当前棋子的合法落点。';
    return;
  }

  const result = playBeastMove(game.value, selected.value.id, point);
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  game.value = result.game;
  selectedId.value = null;
  error.value = '';
  notice.value = result.notice;
}

function undo() {
  const previous = undoBeastMove(game.value);
  if (!previous) {
    error.value = '当前没有可以撤回的走棋。';
    return;
  }
  game.value = previous;
  selectedId.value = null;
  error.value = '';
  notice.value = '已撤回一步。';
}

function restart() {
  game.value = newBeastGame();
  selectedId.value = null;
  error.value = '';
  notice.value = '已恢复初始局面，下方先行。';
}

function lostPieces(side: BeastSide): string {
  const pieces = captured.value[side];
  return pieces.length
    ? pieces.map(piece => BEAST_KIND_NAMES[piece.kind]).join('、')
    : '无';
}
</script>

<template>
  <main class="beast-page">
    <nav class="beast-page-nav" aria-label="斗兽棋导航">
      <button class="plain-button" type="button" @click="emit('other')">← 返回其他玩法</button>
      <button class="plain-button" type="button" @click="rulesDialog?.showModal()">玩法规则</button>
    </nav>

    <header class="beast-heading">
      <div>
        <span>JUNGLE CHESS</span>
        <h1>斗兽棋</h1>
      </div>
      <p class="beast-turn" :class="game.turn ?? (game.winner ?? 'draw')" aria-live="polite">
        <i aria-hidden="true"></i>{{ turnText }}
      </p>
    </header>

    <section v-if="game.status === 'finished'" class="beast-result" role="status">
      <strong>{{ resultTitle }}</strong>
      <span>{{ resultDetail }}</span>
    </section>

    <div class="beast-layout">
      <section class="beast-board-column" aria-label="斗兽棋对局">
        <div class="beast-board-heading">
          <span>第 {{ game.history.length }} 手</span>
          <span v-if="selected">{{ BEAST_SIDE_NAMES[selected.side] }}{{ BEAST_KIND_NAMES[selected.kind] }} · {{ coordinate(selected) }}</span>
          <span v-else>{{ game.status === 'playing' ? '点棋子查看可走位置' : '可悔棋或重新开始' }}</span>
        </div>
        <BeastChessBoard :pieces="game.pieces" :selected-id="selectedId" :targets="targets"
          :last-move="game.lastMove" :disabled="game.status !== 'playing'" @cell="selectCell" />
        <p v-if="error" class="beast-feedback error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="beast-feedback" role="status">{{ notice }}</p>
        <div class="beast-actions">
          <button class="primary-button" type="button" :disabled="game.history.length === 0" @click="undo">悔棋</button>
          <button class="tool-button" type="button" @click="restart">重新开始</button>
          <button class="tool-button" type="button" @click="emit('other')">返回其他玩法</button>
        </div>
      </section>

      <aside class="beast-side-panel">
        <section class="beast-side" :class="{ active: game.turn === 'upper' }">
          <header><span>上方</span><strong>{{ counts.upper }}</strong></header>
          <p>剩余棋子</p>
          <div class="beast-lost"><span>被吃</span><b>{{ lostPieces('upper') }}</b></div>
        </section>
        <section class="beast-side" :class="{ active: game.turn === 'lower' }">
          <header><span>下方</span><strong>{{ counts.lower }}</strong></header>
          <p>剩余棋子 · 先行</p>
          <div class="beast-lost"><span>被吃</span><b>{{ lostPieces('lower') }}</b></div>
        </section>

        <section class="beast-last-move">
          <span>最近一步</span>
          <strong>{{ lastMoveText }}</strong>
        </section>

        <section class="beast-legend">
          <span><i class="dot"></i>可走位置</span>
          <span><i class="ring"></i>可吃目标</span>
          <span><i class="trail"></i>上一手</span>
        </section>
      </aside>
    </div>

    <dialog ref="rulesDialog" class="beast-rules-dialog">
      <div class="beast-dialog-heading">
        <div><span>HOW TO PLAY</span><h2>斗兽棋规则</h2></div>
        <button type="button" aria-label="关闭玩法规则" @click="rulesDialog?.close()">×</button>
      </div>
      <div class="beast-rules-grid">
        <section><h3>行动与吃子</h3><p>双方轮流走一枚己方棋子，每次上下左右一格。等级高者可吃低者，同级互吃；陆地上的鼠可吃象，象不能吃普通陆地上的鼠。</p></section>
        <section><h3>河流</h3><p>只有鼠能进入河流。水陆之间不能吃子，河中鼠只能吃河中的敌方鼠。狮、虎可横跨两格或纵跨三格连续河流，但任一水格有鼠时不能跳。</p></section>
        <section><h3>陷阱与兽穴</h3><p>进入敌方陷阱的棋子等级变为 0，不能吃子；离开后恢复。进入敌方兽穴立即获胜，也不能进入己方兽穴。</p></section>
        <section><h3>胜负</h3><p>进入敌方兽穴、吃光对方或使对方无合法走法即获胜。同一完整局面第三次出现，或连续 100 个半回合无吃子，判和。</p></section>
      </div>
      <button class="primary-button beast-rules-close" type="button" @click="rulesDialog?.close()">知道了</button>
    </dialog>
  </main>
</template>

<style scoped>
.beast-page{width:min(1180px,100%);margin:0 auto;padding:26px 0 52px;color:#473b30}
.beast-page-nav{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
.beast-page-nav button{font-size:13px}
.beast-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:18px}
.beast-heading>div>span,.beast-dialog-heading span{color:#a1713f;font-size:9px;font-weight:700;letter-spacing:.18em}
.beast-heading h1{margin:3px 0 0;font:700 39px/1.05 "Songti SC","SimSun",serif;letter-spacing:5px}
.beast-turn{display:inline-flex;align-items:center;gap:8px;margin:0 0 3px;padding:7px 13px;border:1px solid #d3c1a5;border-radius:999px;background:#fffdf8;color:#715b3c;font-size:12px;font-weight:700;white-space:nowrap;box-shadow:0 5px 16px #59432309}
.beast-turn i{width:8px;height:8px;border-radius:50%;background:#a64b3c;box-shadow:0 0 0 3px #a64b3c18}
.beast-turn.upper i{background:#5c4634}
.beast-turn.draw i{background:#9a8567}
.beast-result{display:flex;align-items:center;gap:12px;margin-bottom:14px;padding:12px 16px;border:1px solid #c9a368;border-radius:11px;background:linear-gradient(100deg,#fff4d9,#fffdf8);box-shadow:0 8px 24px #6d4c2310}
.beast-result strong{font:700 20px/1.25 "Songti SC","SimSun",serif;color:#873c31}.beast-result span{color:#766450;font-size:12px}
.beast-layout{display:grid;grid-template-columns:minmax(0,1fr) 260px;align-items:start;gap:22px}
.beast-board-column{min-width:0}
.beast-board-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px;padding:0 2px;color:#897863;font-size:10px}
.beast-board-heading span:first-child{padding:4px 8px;border:1px solid #d7c7af;border-radius:999px;background:#fffdf8;white-space:nowrap}
.beast-board-heading span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.beast-feedback{min-height:20px;margin:9px 1px 0;color:#786855;font-size:11px;line-height:1.6}.beast-feedback.error{color:#9a4035}
.beast-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}.beast-actions button{min-height:42px}.beast-actions .primary-button{min-width:104px}
.beast-side-panel{display:grid;gap:11px;min-width:0}
.beast-side{padding:14px 15px;border:1px solid #d9cab5;border-radius:12px;background:linear-gradient(145deg,#fffdf8,#f8f1e6);transition:border-color .16s ease,box-shadow .16s ease}
.beast-side:nth-child(2){background:linear-gradient(145deg,#fffdf8,#f4eee3)}
.beast-side.active{border-color:#a66b43;box-shadow:inset 3px 0 #a64b3c,0 7px 20px #5b40200d}
.beast-side:nth-child(2).active{box-shadow:inset 3px 0 #5c4634,0 7px 20px #5b40200d}
.beast-side header{display:flex;align-items:center;justify-content:space-between}.beast-side header span{font:700 18px/1.2 "Songti SC","SimSun",serif}.beast-side header strong{display:grid;place-items:center;min-width:34px;height:28px;padding:0 8px;border-radius:999px;background:#efe5d5;color:#7b5b3c;font-size:12px}
.beast-side.active header strong{background:#a64b3c;color:#fff8e8}.beast-side:nth-child(2).active header strong{background:#5c4634}
.beast-side>p{margin:4px 0 10px;color:#9a8b76;font-size:9px}
.beast-lost{display:grid;grid-template-columns:34px minmax(0,1fr);gap:7px;padding-top:9px;border-top:1px solid #e6dccd;font-size:10px}.beast-lost span{color:#998974}.beast-lost b{color:#6f5d49;font-weight:600;line-height:1.55;word-break:break-word}
.beast-last-move{padding:15px;border:1px solid #d9cab5;border-radius:12px;background:#fffdf8}.beast-last-move span{display:block;margin-bottom:7px;color:#9b8a74;font-size:9px}.beast-last-move strong{color:#4f4134;font-size:12px;line-height:1.7}
.beast-legend{display:grid;gap:8px;padding:13px 14px;border-top:1px solid #e0d5c5;color:#7f705d;font-size:10px}.beast-legend span{display:flex;align-items:center;gap:8px}.beast-legend i{display:inline-block;flex:none;width:13px;height:13px;border-radius:50%}.beast-legend .dot{border:2px solid #fff3d1;background:#9d6837}.beast-legend .ring{border:2px solid #a73d30;background:#f7e5d9;box-shadow:inset 0 0 0 2px #ffe9b5}.beast-legend .trail{border-radius:4px;border:1px solid #a64b3c;background:#a64b3c18}
.beast-rules-dialog{width:min(720px,calc(100vw - 32px));max-height:calc(100vh - 40px);padding:24px;border:1px solid #d3c0a2;border-radius:16px;background:#fffaf0;color:#493d31;box-shadow:0 28px 80px #35231542}.beast-rules-dialog::backdrop{background:#33281f55;backdrop-filter:blur(2px)}
.beast-dialog-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.beast-dialog-heading h2{margin:3px 0 0;font:700 25px/1.2 "Songti SC","SimSun",serif}.beast-dialog-heading button{display:grid;place-items:center;width:34px;height:34px;border:1px solid #d3c5b1;border-radius:50%;background:#fffdf8;color:#796a58;font-size:20px}
.beast-rules-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:19px 0}.beast-rules-grid section{padding:14px;border:1px solid #e2d6c4;border-radius:10px;background:#fffdf8}.beast-rules-grid h3{margin:0 0 7px;font:700 15px/1.3 "Songti SC","SimSun",serif;color:#6c5132}.beast-rules-grid p{margin:0;color:#746452;font-size:11px;line-height:1.8}.beast-rules-close{display:block;margin-left:auto;min-width:104px}
.beast-page button:focus-visible{outline:2px solid #8c6d37;outline-offset:3px}
@media(max-width:860px){.beast-layout{grid-template-columns:minmax(0,1fr)}.beast-side-panel{grid-template-columns:repeat(2,minmax(0,1fr))}.beast-last-move,.beast-legend{grid-column:1 / -1}.beast-legend{grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid #e0d5c5;border-radius:10px}}
@media(max-width:560px){
  .beast-page{padding:15px 0 34px}.beast-page-nav{margin-bottom:14px}.beast-page-nav button{font-size:12px}.beast-heading{align-items:center;margin-bottom:12px}.beast-heading h1{font-size:31px;letter-spacing:3px}.beast-heading>div>span{font-size:8px}.beast-turn{padding:6px 9px;font-size:10px;gap:6px}.beast-turn i{width:6px;height:6px}.beast-result{align-items:flex-start;flex-direction:column;gap:3px;padding:10px 12px}.beast-result strong{font-size:18px}.beast-result span{font-size:10px}.beast-board-heading{font-size:9px}.beast-board-heading span:last-child{max-width:57vw}.beast-side-panel{grid-template-columns:1fr 1fr;gap:7px}.beast-side{padding:11px}.beast-side header span{font-size:15px}.beast-side header strong{min-width:29px;height:24px;font-size:10px}.beast-side>p{font-size:8px}.beast-lost{grid-template-columns:29px minmax(0,1fr);font-size:9px}.beast-last-move{padding:12px}.beast-last-move strong{font-size:11px}.beast-legend{display:flex;flex-wrap:wrap;gap:8px 12px;padding:10px}.beast-rules-dialog{padding:19px}.beast-rules-grid{grid-template-columns:1fr;max-height:58vh;overflow:auto}.beast-rules-grid section{padding:12px}.beast-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.beast-actions button{width:100%;min-height:44px}.beast-actions button:last-child{grid-column:1 / -1}
}
</style>
