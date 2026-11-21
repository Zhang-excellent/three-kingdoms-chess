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
const imageSource = computed(() =>
  `images/beast-chess/pieces/${props.piece.side}-${props.piece.kind}.png?v=animal-colors-v2`);
const label = computed(() => `${BEAST_SIDE_NAMES[props.piece.side]}${BEAST_KIND_NAMES[props.piece.kind]}`);
</script>

<template>
  <span class="beast-piece" :class="[piece.side, `kind-${piece.kind}`, { selected }]" :data-kind="piece.kind">
    <span class="beast-piece-base" aria-hidden="true"></span>
    <img v-if="!failed" :src="imageSource" :alt="label" draggable="false" @error="failed = true">
    <span v-else class="beast-piece-fallback">{{ BEAST_KIND_NAMES[piece.kind] }}</span>
  </span>
</template>

<style scoped>
.beast-piece{position:absolute;inset:4% 2%;z-index:2;display:grid;place-items:center;border-radius:50%;pointer-events:none;transform-origin:center;transition:transform .16s ease,filter .16s ease}
.beast-piece img{position:relative;z-index:2;width:100%;height:100%;object-fit:contain;border-radius:18%;filter:saturate(1.32) contrast(1.1) brightness(1.04) drop-shadow(0 3px 3px #3e281b52)}
.beast-piece{--beast-accent:#b67a3c;--beast-halo:#f0d6a4}
.beast-piece.kind-elephant{--beast-accent:#71818e;--beast-halo:#c6d2da}
.beast-piece.kind-lion{--beast-accent:#d7a11c;--beast-halo:#ffe18a}
.beast-piece.kind-tiger{--beast-accent:#d86a19;--beast-halo:#ffb45b}
.beast-piece.kind-leopard{--beast-accent:#bd7f12;--beast-halo:#ebbf62}
.beast-piece.kind-wolf{--beast-accent:#7e8995;--beast-halo:#d2d9df}
.beast-piece.kind-dog{--beast-accent:#a7653e;--beast-halo:#e3b38f}
.beast-piece.kind-cat{--beast-accent:#81929b;--beast-halo:#e9f0f1}
.beast-piece.kind-rat{--beast-accent:#8a7460;--beast-halo:#cdb99f}
.beast-piece-base{position:absolute;inset:-4%;border-radius:50%;background:radial-gradient(circle at 45% 38%,#fffdf7,var(--beast-halo));box-shadow:0 0 0 2px var(--beast-accent),0 0 9px color-mix(in srgb,var(--beast-accent) 58%,transparent),0 2px 5px #56382042}
.beast-piece.upper .beast-piece-base{background:radial-gradient(circle at 45% 38%,#9b5c2f,var(--beast-halo))}
.beast-piece.selected{filter:drop-shadow(0 0 5px #c34732);transform:scale(1.07)}
.beast-piece.selected::after{position:absolute;inset:-5%;z-index:1;content:"";border:2px solid #f8e4b5;border-radius:50%;box-shadow:0 0 0 2px #9c382d,0 0 14px #e9bd6a}
.beast-piece-fallback{position:relative;z-index:3;display:grid;place-items:center;width:72%;aspect-ratio:1;border:2px solid #f1d9ad;border-radius:50%;background:#a64b3c;color:#fff8e8;font:700 clamp(15px,4vw,28px)/1 "STKaiti","KaiTi",serif}
.beast-piece.upper .beast-piece-fallback{background:#66361f;border-color:#d9b777}
</style>
