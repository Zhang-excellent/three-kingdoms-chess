<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  BEAST_KIND_NAMES,
  BEAST_SIDE_NAMES,
} from '../beast-chess.ts';
import type { BeastPiece } from '../beast-chess.ts';

const props = defineProps<{
  piece: BeastPiece;
  selected?: boolean;
}>();

const failed = ref(false);
const imageSource = computed(() => `images/beast-chess/pieces/${props.piece.side}-${props.piece.kind}.png`);
const label = computed(() => `${BEAST_SIDE_NAMES[props.piece.side]}${BEAST_KIND_NAMES[props.piece.kind]}`);
</script>

<template>
  <span class="beast-piece" :class="[piece.side, { selected }]" :data-kind="piece.kind">
    <span class="beast-piece-base" aria-hidden="true"></span>
    <img v-if="!failed" :src="imageSource" :alt="label" draggable="false" @error="failed = true">
    <span v-else class="beast-piece-fallback">{{ BEAST_KIND_NAMES[piece.kind] }}</span>
  </span>
</template>

<style scoped>
.beast-piece{position:absolute;inset:7% 5%;z-index:2;display:grid;place-items:center;border-radius:50%;pointer-events:none;transform-origin:center;transition:transform .16s ease,filter .16s ease}
.beast-piece img{position:relative;z-index:2;width:100%;height:100%;object-fit:contain;border-radius:18%;filter:drop-shadow(0 3px 3px #3e281b45)}
.beast-piece-base{position:absolute;inset:0 1%;border-radius:50%;background:#fff5df;box-shadow:0 1px 4px #56382035}
.beast-piece.upper .beast-piece-base{background:#7d3f1e}
.beast-piece.selected{filter:drop-shadow(0 0 5px #c34732);transform:scale(1.07)}
.beast-piece.selected::after{position:absolute;inset:-5%;z-index:1;content:"";border:2px solid #f8e4b5;border-radius:50%;box-shadow:0 0 0 2px #9c382d,0 0 14px #e9bd6a}
.beast-piece-fallback{position:relative;z-index:3;display:grid;place-items:center;width:72%;aspect-ratio:1;border:2px solid #f1d9ad;border-radius:50%;background:#a64b3c;color:#fff8e8;font:700 clamp(15px,4vw,28px)/1 "STKaiti","KaiTi",serif}
.beast-piece.upper .beast-piece-fallback{background:#66361f;border-color:#d9b777}
</style>
