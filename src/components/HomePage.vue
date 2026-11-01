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
  rules: [];
  settings: [];
  resume: [];
}>();
const resumeLabel = computed(() => props.roomPhase === 'lobby' ? '返回房间' : '返回对局');
</script>

<template>
  <main class="home-page">
    <section class="home-hero">
      <div class="home-hero-copy">
        <span class="eyebrow">三人同局 · 独立争胜</span>
        <h1>三国象棋</h1>
        <p class="home-lead">魏、蜀、吴三方轮流行棋，各自争胜。<br>合作与牵制，由你决定。</p>
        <div class="home-primary-actions">
          <button class="primary-button home-main-action" @click="emit('lobby')">进入对战大厅 <span aria-hidden="true">→</span></button>
          <button class="tool-button home-secondary-action" @click="emit('friends')">与好友对弈</button>
        </div>
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

    <section class="home-factions" aria-label="三大阵营">
      <article v-for="(faction, index) in ORDER" :key="faction" class="home-faction-card" :class="faction">
        <span class="home-faction-index">0{{ index + 1 }}</span>
        <div class="home-faction-seal">{{ PLAYERS[faction].initial }}</div>
        <div>
          <span>{{ PLAYERS[faction].nation }}国</span>
          <h2>{{ PLAYERS[faction].name }}</h2>
          <p>{{ index === 0 ? '坐镇北方，先手开局' : index === 1 ? '据守西方，伺机而动' : '列阵东方，后发制人' }}</p>
        </div>
      </article>
    </section>

    <section class="home-actions">
      <button class="home-action-card" @click="emit('lobby')">
        <span class="home-action-kicker">公开对局</span>
        <strong>找棋友</strong>
        <p>查看正在等待的房间，加入还缺人的对局。</p>
        <span class="home-action-link">进入对战大厅 →</span>
      </button>
      <button class="home-action-card" @click="emit('friends')">
        <span class="home-action-kicker">好友组局</span>
        <strong>邀请两位朋友</strong>
        <p>创建 6 位数字房间，或用房间号加入好友。</p>
        <span class="home-action-link">与好友对弈 →</span>
      </button>
      <button class="home-action-card home-local-card" @click="emit('local')">
        <span class="home-action-kicker">单人熟悉规则</span>
        <strong>本地试玩</strong>
        <p>在同一个页面轮流操作魏、蜀、吴三方。</p>
        <span class="home-action-link">开始本地对局 →</span>
      </button>
    </section>

    <section class="home-secondary-row">
      <button class="plain-button" @click="emit('rules')">查看玩法说明</button>
      <button class="plain-button" @click="emit('settings')">声音与设置</button>
    </section>

    <section class="home-about">
      <span class="eyebrow">项目说明</span>
      <h2>一局棋，三方博弈</h2>
      <p>这是仍在试玩的三人象棋版本，不设固定联盟。你可以临时合作，也可以随时反制；只要主公仍在棋盘上，局势就没有结束。</p>
    </section>
  </main>
</template>
