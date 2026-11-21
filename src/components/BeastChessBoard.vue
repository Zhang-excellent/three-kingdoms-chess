<script setup lang="ts">
import { computed } from 'vue';
import BeastChessPiece from './BeastChessPiece.vue';
import {
  BEAST_KIND_NAMES,
  BEAST_SIDE_NAMES,
  beastCoordinate,
  beastPieceAt,
} from '../beast-chess.ts';
import type {
  BeastMove,
  BeastPiece,
  BeastPoint,
} from '../beast-chess.ts';

const props = defineProps<{
  pieces: BeastPiece[];
  selectedId: string | null;
  targets: BeastPoint[];
  lastMove: BeastMove | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{ cell: [point: BeastPoint] }>();
const boardSource = 'images/beast-chess/board.png';

const cells = computed(() => Array.from({ length: 9 }, (_, row) => Array.from(
  { length: 7 },
  (_, x) => ({ x, y: 8 - row }),
)).flat());

const isTarget = (point: BeastPoint) => props.targets.some(target => target.x === point.x && target.y === point.y);
const isLastPoint = (point: BeastPoint, key: 'from' | 'to') => !!props.lastMove
  && props.lastMove[key].x === point.x
  && props.lastMove[key].y === point.y;
const isLastPath = (point: BeastPoint) => !!props.lastMove?.jumpedRiver
  && props.lastMove.path.some(path => path.x === point.x && path.y === point.y);

function pieceAt(point: BeastPoint): BeastPiece | null {
  return beastPieceAt(props.pieces, point);
}

function coordinate(point: BeastPoint): string {
  return beastCoordinate(point);
}

function cellLabel(point: BeastPoint): string {
  const piece = pieceAt(point);
  if (piece) {
    const side = BEAST_SIDE_NAMES[piece.side];
    const kind = BEAST_KIND_NAMES[piece.kind];
    return `${side}${kind}，${coordinate(point)}${isTarget(point) ? '，可吃子' : ''}`;
  }
  return isTarget(point) ? `走到${coordinate(point)}` : `${coordinate(point)}空格`;
}
</script>

<template>
  <div class="beast-board-frame">
    <img class="beast-board-image" :src="boardSource" alt="木质斗兽棋棋盘">
    <div class="beast-board-grid" role="group" aria-label="斗兽棋棋盘">
      <button v-for="point in cells" :key="coordinate(point)" type="button" class="beast-cell"
        :class="{
          'has-piece': !!pieceAt(point),
          target: isTarget(point),
          'capture-target': isTarget(point) && !!pieceAt(point),
          selected: !!pieceAt(point) && pieceAt(point)?.id === selectedId,
          'last-from': isLastPoint(point, 'from'),
          'last-to': isLastPoint(point, 'to'),
          'last-path': isLastPath(point),
        }" :data-coordinate="coordinate(point)" :data-x="point.x" :data-y="point.y"
        :aria-label="cellLabel(point)" :disabled="disabled" @click="emit('cell', point)">
        <BeastChessPiece v-if="pieceAt(point)" :piece="pieceAt(point)!" :selected="pieceAt(point)?.id === selectedId" />
        <span v-if="isTarget(point) && !pieceAt(point)" class="beast-target-dot" aria-hidden="true"></span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.beast-board-frame{position:relative;width:100%;aspect-ratio:1;overflow:hidden;border:1px solid #b88e58;border-radius:14px;background:#d9a85f;box-shadow:0 20px 50px #3e2b1724,inset 0 0 0 5px #f1d8ad55}
.beast-board-image{display:block;width:100%;height:100%;object-fit:contain;user-select:none;pointer-events:none}
.beast-board-grid{position:absolute;left:6.3796%;top:5.7416%;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));grid-template-rows:repeat(9,minmax(0,1fr));width:87.1611%;height:87.8788%}
.beast-cell{position:relative;min-width:0;min-height:0;margin:0;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;outline:none;transition:background .14s ease,box-shadow .14s ease}
.beast-cell::before{position:absolute;inset:3%;z-index:1;border:1px solid transparent;border-radius:8px;content:"";pointer-events:none;transition:border-color .14s ease,background .14s ease,box-shadow .14s ease}
.beast-cell:hover:not(:disabled)::before{background:#fff8e912;border-color:#7e4a2660}
.beast-cell:focus-visible{box-shadow:inset 0 0 0 3px #fff9df,inset 0 0 0 5px #8d3f31}
.beast-cell.selected::before{border-color:#9e3e31;background:#fff2d020;box-shadow:inset 0 0 13px #e5bb6b55}
.beast-cell.last-from::before{border-color:#8b6d3d88;box-shadow:inset 0 0 0 1px #fff2d055}
.beast-cell.last-to::before{border-color:#a64b3c;background:#a64b3c12;box-shadow:inset 0 0 0 2px #f3d99c70}
.beast-cell.last-path::before{border-color:#d5c47a88;background:#d6b65516}
.beast-cell.target::before{border-color:#80653188;background:#fff8dd15}
.beast-cell.capture-target::before{border:2px solid #a73d30;background:#a73d3010;box-shadow:inset 0 0 0 2px #ffe9b5,0 0 9px #a73d3060}
.beast-cell:disabled{cursor:default}
.beast-target-dot{position:absolute;left:50%;top:50%;z-index:4;width:21%;aspect-ratio:1;transform:translate(-50%,-50%);border:2px solid #fff3d1;border-radius:50%;background:#9d6837;box-shadow:0 1px 5px #3d281c66}
@media(max-width:640px){
  .beast-board-frame{width:calc(100vw - 8px);margin-left:calc((100% - (100vw - 8px)) / 2);border-radius:10px;box-shadow:0 12px 28px #3e2b1720,inset 0 0 0 3px #f1d8ad55}
  .beast-cell{border-radius:5px}
  .beast-cell::before{inset:1%;border-radius:5px}
  .beast-target-dot{width:28%;border-width:1px}
}
</style>
