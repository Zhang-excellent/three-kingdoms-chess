<script setup lang="ts">
import { computed } from 'vue';
import { ORDER, PLAYERS } from '../game.ts';
import type { RoomPhase } from '../online.ts';

const props = defineProps<{
  hasRoom: boolean;
  roomCode: string | null;
  roomPhase: RoomPhase | null;
}>();
const emit = defineEmits<{
  lobby: [];
  friends: [];
  local: [];
  resume: [];
}>();
const resumeLabel = computed(() => props.roomPhase === 'lobby' ? '返回房间' : '返回对局');
</script>

<template>
  <main class="home-page">
    <section class="home-hero">
      <div class="home-hero-copy">
        <h1>三国象棋</h1>
        <p class="home-lead">魏、蜀、吴三方轮流行棋，各自争胜。<br>合作与牵制，由你决定。</p>
        <div v-if="hasRoom" class="home-return-room">
          <div><strong>你的房间还在</strong><span>{{ roomCode ? `房间 ${roomCode}` : '正在恢复房间信息' }}</span></div>
          <button class="primary-button" @click="emit('resume')">{{ resumeLabel }}</button>
        </div>
      </div>
      <div class="home-hero-board" aria-label="三国象棋棋盘预览">
        <span class="home-board-line horizontal one"></span>
        <span class="home-board-line horizontal two"></span>
        <span class="home-board-line vertical one"></span>
        <span class="home-board-line vertical two"></span>
        <span class="home-board-label">淮河 · 秦岭</span>
        <span v-for="faction in ORDER" :key="faction" class="home-board-piece" :class="faction">
          {{ PLAYERS[faction].initial }}
        </span>
      </div>
    </section>

    <section class="home-actions">
      <button class="home-action-card" @click="emit('lobby')">
        <strong>公开大厅</strong>
      </button>
      <button class="home-action-card" @click="emit('friends')">
        <strong>好友对战</strong>
      </button>
      <button class="home-action-card home-local-card" @click="emit('local')">
        <strong>本地试玩</strong>
      </button>
    </section>

    <section class="home-about">
      <span class="eyebrow">项目说明</span>
      <h2>一局棋，三方博弈</h2>
      <p>这是仍在试玩的三人象棋版本，不设固定联盟。你可以临时合作，也可以随时反制；只要主公仍在棋盘上，局势就没有结束。</p>
    </section>
  </main>
</template>

<style scoped>
.home-action-card{display:grid;place-items:center;text-align:center;padding:28px 22px;min-height:128px}
.home-action-card strong{font-size:26px;letter-spacing:3px}
</style>
