<script setup lang="ts">
import { computed, ref, toRaw } from 'vue';
import { chinesePieceName, chineseSideName } from '../chinese-chess.ts';
import type { ChinesePoint } from '../chinese-chess.ts';
import { replayArchivedChineseGame } from '../chinese-game-history.ts';
import type { ArchivedChineseGameRecord } from '../chinese-game-history.ts';

const props = defineProps<{ record: ArchivedChineseGameRecord }>();
const emit = defineEmits<{ back: [] }>();
const replay = computed(() => replayArchivedChineseGame(toRaw(props.record)));
const index = ref(0);
const flipped = ref(false);
const frames = computed(() => replay.value.ok ? replay.value.replay.frames : []);
const total = computed(() => Math.max(0, frames.value.length - 1));
const current = computed(() => frames.value[index.value] ?? null);
const move = computed(() => index.value > 0 ? props.record.moves[index.value - 1] ?? null : null);
const latest = computed(() => current.value?.lastMove ?? null);
const resultText = computed(() => {
  if (!replay.value.ok) return '';
  if (props.record.endReason === 'draw') return '双方和棋';
  return props.record.winner ? `${chineseSideName(props.record.winner)}获胜` : '本局结束';
});
const reasonText = computed(() => ({
  checkmate: '将死',
  stalemate: '困毙',
  resignation: '认输',
  draw: '双方和棋',
  exit: '主动退出',
  timeout: '断线超时',
} as const)[props.record.endReason]);
const px = (x: number) => 50 + x * 55;
const py = (y: number) => 50 + y * 55;
const viewX = (x: number) => px(flipped.value ? 8 - x : x);
const viewY = (y: number) => py(flipped.value ? 9 - y : y);
const coordinate = (point: ChinesePoint) => `(${point.x + 1}, ${point.y + 1})`;

function first() { index.value = 0; }
function previous() { index.value = Math.max(0, index.value - 1); }
function next() { index.value = Math.min(total.value, index.value + 1); }
function last() { index.value = total.value; }
</script>

<template>
  <section class="chinese-replay-panel" aria-label="中国象棋复盘">
    <header class="chinese-replay-heading">
      <div><span class="eyebrow">CHINESE CHESS REPLAY</span><h2>中国象棋复盘</h2></div>
      <button class="tool-button" type="button" @click="emit('back')">← 返回棋谱列表</button>
    </header>
    <p v-if="!replay.ok" class="recent-state error" role="alert">{{ replay.error }}</p>
    <template v-else>
      <div class="chinese-replay-summary">
        <strong>{{ resultText }}</strong><span>{{ reasonText }} · 共 {{ total }} 手</span>
      </div>
      <div class="chinese-replay-board-frame">
        <svg class="board-svg chinese-replay-board" viewBox="0 0 540 595" role="group" aria-label="中国象棋完整赛后棋盘">
          <defs><linearGradient id="chinese-replay-wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#efdab4"/><stop offset="1" stop-color="#e5c897"/></linearGradient><marker id="chinese-replay-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a77b36"/></marker></defs>
          <rect x="8" y="8" width="524" height="579" rx="8" fill="url(#chinese-replay-wood)"/>
          <rect x="37" y="37" width="466" height="521" fill="none" stroke="#674d2f" stroke-width="1.4"/>
          <g class="grid-lines">
            <line v-for="n in 10" :key="`h${n}`" :x1="px(0)" :x2="px(8)" :y1="py(n-1)" :y2="py(n-1)"/>
            <template v-for="n in 9" :key="`v${n}`"><line :x1="px(n-1)" :x2="px(n-1)" :y1="py(0)" :y2="py(4)"/><line :x1="px(n-1)" :x2="px(n-1)" :y1="py(5)" :y2="py(9)"/></template>
            <line :x1="px(0)" :x2="px(0)" :y1="py(4)" :y2="py(5)"/><line :x1="px(8)" :x2="px(8)" :y1="py(4)" :y2="py(5)"/>
            <path :d="`M${px(3)} ${py(0)} L${px(5)} ${py(2)} M${px(5)} ${py(0)} L${px(3)} ${py(2)} M${px(3)} ${py(7)} L${px(5)} ${py(9)} M${px(5)} ${py(7)} L${px(3)} ${py(9)}`"/>
          </g>
          <g class="coordinates">
            <text v-for="n in 9" :key="n" :x="px(n-1)" y="25">{{ flipped ? 10 - n : n }}</text>
            <text v-for="n in 10" :key="`row${n}`" x="24" :y="py(n-1)+4">{{ flipped ? 11 - n : n }}</text>
          </g>
          <text class="river" x="175" y="305">{{ flipped ? '汉 界' : '楚 河' }}</text>
          <text class="river" x="365" y="305">{{ flipped ? '楚 河' : '汉 界' }}</text>
          <g v-if="latest" class="last-trail" aria-hidden="true">
            <line :x1="viewX(latest.from.x)" :y1="viewY(latest.from.y)" :x2="viewX(latest.to.x)" :y2="viewY(latest.to.y)" marker-end="url(#chinese-replay-tip)"/>
            <rect :x="viewX(latest.from.x)-18" :y="viewY(latest.from.y)-18" width="36" height="36" rx="4"/>
            <circle :cx="viewX(latest.to.x)" :cy="viewY(latest.to.y)" r="26"/>
          </g>
          <g v-for="piece in current?.pieces ?? []" :key="piece.id" class="chinese-replay-piece" :class="piece.side" :style="{transform: `translate(${viewX(piece.x)}px, ${viewY(piece.y)}px)`}">
            <circle class="chinese-replay-piece-shadow" cy="2.5" r="23"/><circle class="chinese-replay-piece-face" r="23"/><circle class="chinese-replay-piece-rim" r="19.5"/>
            <text :class="{general: piece.kind === 'king'}" y="1">{{ chinesePieceName(piece) }}</text>
          </g>
        </svg>
      </div>
      <div class="chinese-replay-controls">
        <button class="tool-button" type="button" :disabled="index === 0" @click="first">初始局面</button>
        <button class="tool-button" type="button" :disabled="index === 0" @click="previous">上一步</button>
        <strong>第 {{ index }} 步／共 {{ total }} 步</strong>
        <button class="tool-button" type="button" :disabled="index === total" @click="next">下一步</button>
        <button class="tool-button" type="button" :disabled="index === total" @click="last">最后一步</button>
        <button class="tool-button" type="button" @click="flipped = !flipped">翻转棋盘</button>
      </div>
      <article class="chinese-replay-move">
        <span class="eyebrow">当前步骤</span>
        <template v-if="move">
          <strong>{{ chineseSideName(move.side) }} · {{ chinesePieceName(move) }}</strong>
          <p>{{ coordinate(move.from) }} → {{ coordinate(move.to) }}</p>
          <small>{{ move.captured ? `吃掉${chineseSideName(move.captured.side)}${chinesePieceName(move.captured)}` : '本步没有吃子' }}</small>
        </template>
        <template v-else><strong>初始局面</strong><p>32 枚棋子按标准中国象棋摆法就位。</p></template>
      </article>
    </template>
  </section>
</template>

<style scoped>
.chinese-replay-panel{display:grid;gap:16px;padding:20px 24px 26px}.chinese-replay-heading{display:flex;align-items:center;justify-content:space-between;gap:14px}.chinese-replay-heading h2{margin:4px 0 0;font:700 25px/1.2 "Songti SC","SimSun",serif}.chinese-replay-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border:1px solid #d8c7aa;border-radius:9px;background:#f8f1e5}.chinese-replay-summary strong{color:#8f4135}.chinese-replay-summary span{color:#7f705d;font-size:11px}.chinese-replay-board-frame{max-width:610px;width:100%;margin:0 auto;padding:5px;border:1px solid #b08c52;border-radius:12px;background:#c49e61;box-shadow:0 18px 35px #6b4f2712}.chinese-replay-board{display:block;width:100%;height:auto}.chinese-replay-board .grid-lines line,.chinese-replay-board .grid-lines path{fill:none;stroke:#674d2f;stroke-width:1}.chinese-replay-board .coordinates text{text-anchor:middle;fill:#7b6240;font-size:10px}.chinese-replay-board .river{text-anchor:middle;fill:#715334;font:18px "STKaiti","KaiTi",serif}.chinese-replay-board .last-trail{fill:none;stroke:#a77b36;stroke-width:2}.chinese-replay-piece{pointer-events:none}.chinese-replay-piece-shadow{fill:#603f3270}.chinese-replay-piece-face{stroke-width:1.6;filter:drop-shadow(0 2px 2px #0002)}.chinese-replay-piece.red .chinese-replay-piece-face{fill:#b6503e;stroke:#83392e}.chinese-replay-piece.black .chinese-replay-piece-face{fill:#343e48;stroke:#202b36}.chinese-replay-piece-rim{fill:none;stroke:#fff3d9;stroke-width:.8;opacity:.52}.chinese-replay-piece text{text-anchor:middle;dominant-baseline:central;fill:#fff6e3;font:27px "STKaiti","KaiTi","Songti SC",serif}.chinese-replay-piece text.general{font-size:32px;font-weight:600}.chinese-replay-controls{display:flex;align-items:center;justify-content:center;gap:7px;flex-wrap:wrap}.chinese-replay-controls strong{padding:6px 10px;border-radius:999px;background:#f2eadc;color:#6f5b3c;font-size:11px}.chinese-replay-controls button{min-height:36px}.chinese-replay-move{padding:13px 14px;border:1px solid #dfd1bd;border-radius:10px;background:#fffdf8}.chinese-replay-move strong{display:block;margin-top:5px;font:700 16px/1.3 "Songti SC","SimSun",serif}.chinese-replay-move p{margin:6px 0 0;color:#665746;font-size:12px}.chinese-replay-move small{display:block;margin-top:5px;color:#8a7963;font-size:10px}@media(max-width:560px){.chinese-replay-panel{padding:16px}.chinese-replay-heading{align-items:flex-start}.chinese-replay-heading h2{font-size:21px}.chinese-replay-controls{display:grid;grid-template-columns:1fr 1fr}.chinese-replay-controls strong{grid-column:1/-1;text-align:center}.chinese-replay-controls button{width:100%}}
</style>
