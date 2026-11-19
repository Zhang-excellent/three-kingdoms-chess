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
  other: [];
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

    <section class="home-actions" aria-label="游戏入口">
      <button class="home-action-card home-action-lobby" type="button" aria-label="进入公开大厅" @click="emit('lobby')">
        <strong>公开大厅</strong>
      </button>
      <button class="home-action-card home-action-friends" type="button" aria-label="进入好友对战" @click="emit('friends')">
        <strong>好友对战</strong>
      </button>
      <button class="home-action-card home-action-other" type="button" aria-label="进入其他玩法" @click="emit('other')">
        <strong>其他玩法</strong>
      </button>
      <button class="home-action-card home-action-local" type="button" aria-label="进入本地试玩" @click="emit('local')">
        <strong>本地试玩</strong>
      </button>
    </section>

    <p class="home-tagline">一局棋，三方博弈</p>
  </main>
</template>

<style scoped>
.home-page{padding:20px 0 28px}
.home-hero{min-height:352px;padding:32px 46px;gap:34px}
.home-hero h1{margin:10px 0 15px}
.home-lead{line-height:1.85}
.home-hero-board{width:min(100%,300px)}
.home-return-room{margin-top:18px}
.home-actions{grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:22px}
.home-action-card{
  --home-accent:#a64b3c;
  display:grid;
  place-items:center;
  min-width:0;
  min-height:138px;
  padding:22px 18px;
  border:1px solid #ded2c1;
  border-radius:14px;
  background:#fffdf8;
  color:#40362b;
  text-align:center;
  box-shadow:0 7px 18px #59432308;
  transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease;
}
.home-action-friends{--home-accent:#8c642e}
.home-action-other{--home-accent:#2f735b}
.home-action-local{--home-accent:#3f4852}
.home-action-card strong{
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  color:var(--home-accent);
  font:700 25px/1.25 "Songti SC","SimSun",serif;
  letter-spacing:2.5px;
}
.home-action-card:hover{
  border-color:color-mix(in srgb,var(--home-accent) 45%,#ded2c1);
  background:#fffefa;
  box-shadow:0 10px 22px #59432310;
  transform:translateY(-2px);
}
.home-action-card:active{box-shadow:0 4px 12px #5943230d;transform:translateY(0)}
.home-action-card:focus-visible{outline:2px solid color-mix(in srgb,var(--home-accent) 62%,#8b7655);outline-offset:2px}
.home-tagline{
  margin:22px 0 0;
  color:#766957;
  font:18px/1.6 "Songti SC","SimSun",serif;
  letter-spacing:4px;
  text-align:center;
}

@media(max-width:900px){
  .home-page{padding-top:16px}
  .home-hero{padding:28px 30px;gap:24px}
  .home-hero-board{width:min(100%,250px)}
  .home-actions{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
}

@media(max-width:720px){
  .home-page{padding:10px 0 20px}
  .home-hero{padding:18px 16px;gap:11px}
  .home-hero h1{margin:5px 0 7px}
  .home-lead{line-height:1.7}
  .home-hero-board{width:170px}
  .home-return-room{margin-top:10px;padding:9px 11px}
  .home-actions{gap:9px;margin-top:14px}
  .home-action-card{min-height:118px;padding:16px 10px;border-radius:11px}
  .home-action-card strong{font-size:21px;letter-spacing:1.5px}
  .home-tagline{margin-top:14px;font-size:16px;letter-spacing:3px}
}

@media(max-width:360px){
  .home-action-card{padding:14px 8px}
  .home-action-card strong{font-size:17px;letter-spacing:1px}
}
</style>
