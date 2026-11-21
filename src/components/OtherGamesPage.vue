<script setup lang="ts">
const emit = defineEmits<{ five: []; horse: []; chinese: []; beast: [] }>();
</script>

<template>
  <main class="other-games-page">
    <div class="variant-list">
      <button class="variant-entry" type="button" aria-label="进入五兵联盟" @click="emit('five')">
        <span class="variant-entry-seal" aria-hidden="true">兵</span>
        <strong>五兵联盟</strong>
        <span class="variant-entry-arrow" aria-hidden="true">→</span>
      </button>
      <button class="variant-entry horse-entry" type="button" aria-label="进入马棋" @click="emit('horse')">
        <span class="variant-entry-seal" aria-hidden="true">马</span>
        <strong>马棋</strong>
        <span class="variant-entry-arrow" aria-hidden="true">→</span>
      </button>
      <button class="variant-entry chinese-entry" type="button" aria-label="进入中国象棋" @click="emit('chinese')">
        <span class="variant-entry-seal" aria-hidden="true">弈</span>
        <strong>中国象棋</strong>
        <span class="variant-entry-arrow" aria-hidden="true">→</span>
      </button>
      <button class="variant-entry beast-entry" type="button" aria-label="进入斗兽棋" @click="emit('beast')">
        <span class="variant-entry-seal" aria-hidden="true">兽</span>
        <strong>斗兽棋</strong>
        <span class="variant-entry-arrow" aria-hidden="true">→</span>
      </button>
    </div>
  </main>
</template>

<style scoped>
.other-games-page{width:min(900px,100%);min-height:520px;margin:0 auto;padding:72px 0 96px}
.variant-list{display:grid;gap:16px}
.variant-entry{display:grid;grid-template-columns:58px minmax(0,1fr) auto;align-items:center;gap:22px;width:100%;min-height:118px;padding:25px 30px;border:1px solid #d8c7aa;border-radius:16px;background:linear-gradient(145deg,#fffdf8,#f8f1e5);color:#40352a;text-align:left;box-shadow:0 18px 46px #59432310;transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease}
.variant-entry:hover{border-color:#b99a68;box-shadow:0 22px 52px #59432317;transform:translateY(-2px)}
.variant-entry:active{transform:translateY(0)}
.variant-entry:focus-visible{outline:2px solid #8c6d37;outline-offset:3px}
.variant-entry-seal{display:grid;place-items:center;width:54px;height:60px;border:1px solid #853a30;border-radius:6px;background:#a64b3c;color:#fff8e9;font:700 31px/1 "STKaiti","KaiTi",serif;box-shadow:inset 0 0 0 3px #fff3dc2e,0 7px 16px #7d3c2c20;transform:rotate(-2deg)}
.horse-entry .variant-entry-seal{border-color:#2d5660;background:#356d78}
.chinese-entry .variant-entry-seal{border-color:#7a592b;background:#9b7338}
.beast-entry .variant-entry-seal{border-color:#71513a;background:#875a39}
.variant-entry strong{font:700 29px/1.2 "Songti SC","SimSun",serif;letter-spacing:4px}
.variant-entry-arrow{color:#9b7441;font-size:25px;transition:transform .18s ease}
.variant-entry:hover .variant-entry-arrow{transform:translateX(4px)}
@media(max-width:600px){
  .other-games-page{min-height:430px;padding:38px 0 56px}
  .variant-list{gap:12px}
  .variant-entry{grid-template-columns:46px minmax(0,1fr) auto;gap:14px;min-height:94px;padding:18px;border-radius:13px}
  .variant-entry-seal{width:43px;height:48px;font-size:25px}
  .variant-entry strong{font-size:23px;letter-spacing:2px}
}
</style>
