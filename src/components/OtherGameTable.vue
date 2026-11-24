<script setup lang="ts">
import { computed } from 'vue';
import { backendAssetUrl } from '../network-config.ts';

type Side = 'red' | 'black';
interface TablePlayer {
  side: Side;
  nickname: string;
  avatar: string | null;
  identity: 'account' | 'guest';
  ready: boolean;
}

const props = withDefaults(defineProps<{
  title: string;
  eyebrow: string;
  phase: 'lobby' | 'playing' | 'finished';
  players: TablePlayer[];
  busy: boolean;
  sideNames?: Partial<Record<Side, string>>;
  watchEnabled?: boolean;
}>(), {
  watchEnabled: true,
});
const emit = defineEmits<{ seat: [side: Side]; watch: [] }>();

const guestAvatar = 'images/guest-avatar.svg';
const playerFor = (side: Side) => props.players.find(player => player.side === side);
const sideName = (side: Side) => props.sideNames?.[side] ?? (side === 'red' ? '红方' : '黑方');
const avatarFor = (side: Side) => {
  const player = playerFor(side);
  return player ? backendAssetUrl(player.avatar) || guestAvatar : null;
};
const statusText = computed(() => {
  if (props.phase === 'playing') return props.watchEnabled === false ? '迷雾对局进行中 · 第一版暂不开放观战' : '对局中 · 点击桌子观战';
  if (props.phase === 'finished') return props.watchEnabled === false ? '本局结束 · 仅对局双方可见终局棋盘' : '本局结束 · 查看棋盘';
  if (props.players.length === 2) return '双方已入座 · 等待准备';
  if (props.players.length === 1) return '等待另一位棋友';
  return `空桌 · 请选择${sideName('red')}或${sideName('black')}`;
});
const canWatch = computed(() => props.watchEnabled !== false && props.phase !== 'lobby');
const occupiedCount = computed(() => props.players.length);
</script>

<template>
  <section class="game-table-scene" aria-labelledby="game-table-title">
    <div class="game-table-caption">
      <span>{{ eyebrow }}</span>
      <strong>{{ occupiedCount }}/2 人</strong>
    </div>
    <div class="game-table-row">
      <button v-for="side in (['red', 'black'] as const)" :key="side" type="button"
        class="game-table-seat" :class="[side, { occupied: !!playerFor(side) }]"
        :disabled="busy || phase !== 'lobby' || !!playerFor(side)"
        :aria-label="`${sideName(side)}席位，${playerFor(side) ? playerFor(side)!.nickname : '空位'}`"
        @click="emit('seat', side)">
        <span class="game-avatar-frame">
          <img v-if="avatarFor(side)" :src="avatarFor(side)!" alt="">
          <span v-else class="game-avatar-placeholder" aria-hidden="true"></span>
        </span>
        <strong>{{ playerFor(side)?.nickname || '空位' }}</strong>
        <small>{{ sideName(side) }} · {{ playerFor(side) ? (playerFor(side)!.ready ? '已准备' : '已入座') : '点击入座' }}</small>
      </button>

      <button class="game-table-center" :class="{ active: phase === 'playing', finished: phase === 'finished' }"
        type="button" :disabled="!canWatch" @click="emit('watch')">
        <span class="game-table-seal" aria-hidden="true">弈</span>
        <span class="eyebrow">{{ canWatch ? '棋桌已开局' : '公开棋桌' }}</span>
        <strong id="game-table-title">{{ title }}</strong>
        <small>{{ statusText }}</small>
      </button>
    </div>
    <p class="game-table-hint">{{ phase === 'lobby' ? '点击左右头像选择阵营并入座；入座后再进入棋盘。'
      : watchEnabled === false ? '迷雾象棋第一版关闭观战；对局双方刷新或断线后仍会恢复各自视野。'
      : '对局已经开始，请点击中间桌子进入旁观。' }}</p>
  </section>
</template>

<style scoped>
.game-table-scene{display:grid;gap:12px;padding:24px;border:1px solid #cdbb9f;border-radius:18px;background:linear-gradient(145deg,#f7f0e3,#eadcc3);box-shadow:0 20px 48px #5943231a}.game-table-caption{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 2px;color:#796344;font-size:10px;letter-spacing:.12em;text-transform:uppercase}.game-table-caption strong{font-weight:600;letter-spacing:0}.game-table-row{display:grid;grid-template-columns:minmax(120px,180px) minmax(260px,1fr) minmax(120px,180px);align-items:stretch;gap:14px}.game-table-seat{--seat:#a64b3c;display:grid;justify-items:center;align-content:center;gap:8px;min-width:0;min-height:210px;padding:16px 10px;border:2px solid #cbbba3;border-radius:14px;background:linear-gradient(155deg,#f3ede2,#e6dbca);color:#625340;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}.game-table-seat.red{grid-column:1}.game-table-seat.black{--seat:#343e48;grid-column:3}.game-table-center{grid-column:2;grid-row:1}.game-table-seat:not(:disabled):hover{transform:translateY(-3px);border-color:var(--seat);box-shadow:0 12px 24px #59432315}.game-table-seat.occupied{border-color:#4f789d;background:linear-gradient(155deg,#e8f0f7,#d8e6f1);box-shadow:inset 0 0 0 2px #ffffff80;cursor:default;opacity:1}.game-avatar-frame{display:grid;place-items:center;width:88px;height:88px;overflow:hidden;border:3px solid #f7edda;border-radius:14px;background:#d3c8b8;box-shadow:0 0 0 2px #a9916d,0 8px 16px #4a392624}.game-table-seat.occupied .game-avatar-frame{box-shadow:0 0 0 2px #4f789d,0 8px 16px #314a6429}.game-avatar-frame img{width:100%;height:100%;object-fit:cover}.game-avatar-placeholder{width:52px;height:58px;border-radius:50% 50% 42% 42%;background:#a59b8d;position:relative;opacity:.72}.game-avatar-placeholder::before{content:"";position:absolute;left:50%;top:-23px;width:34px;height:34px;border-radius:50%;background:inherit;transform:translateX(-50%)}.game-table-seat strong{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 15px/1.3 "Songti SC","SimSun",serif}.game-table-seat small{color:#88765e;font-size:10px;text-align:center}.game-table-center{position:relative;display:grid;place-items:center;align-content:center;gap:7px;min-width:0;min-height:210px;padding:20px;border:2px solid #b79c73;border-radius:16px;background:linear-gradient(145deg,#efe1c8,#d8c2a0);color:#5c4935;box-shadow:inset 0 0 0 4px #fff8e666,inset 0 0 35px #7b59321a;transition:background .2s ease,border-color .2s ease,transform .18s ease}.game-table-center:not(:disabled):hover{transform:translateY(-2px)}.game-table-center.active{border-color:#527ca2;background:linear-gradient(145deg,#eaf2f8,#cedfeb);color:#38536a;box-shadow:inset 0 0 0 4px #ffffff80,0 10px 28px #385d7b1f}.game-table-center.finished{background:linear-gradient(145deg,#ebe7df,#d6d0c5)}.game-table-seal{display:grid;place-items:center;width:50px;height:50px;border:1px solid #ad936c;border-radius:50%;background:#fff8e980;color:#8d6a37;font:700 27px/1 "STKaiti","KaiTi",serif}.game-table-center .eyebrow{font-size:9px;color:#8e7657}.game-table-center strong{font:700 23px/1.25 "Songti SC","SimSun",serif;letter-spacing:.06em}.game-table-center small{max-width:280px;color:#806d57;font-size:11px;line-height:1.6;text-align:center}.game-table-hint{margin:0;color:#88775f;font-size:10px;line-height:1.65;text-align:center}@media(max-width:700px){.game-table-scene{padding:14px}.game-table-row{grid-template-columns:1fr 1fr;gap:9px}.game-table-center{grid-column:1/-1;grid-row:2;min-height:150px}.game-table-seat.red{grid-column:1;grid-row:1}.game-table-seat.black{grid-column:2;grid-row:1}.game-table-seat{min-height:160px}.game-avatar-frame{width:72px;height:72px}.game-table-center strong{font-size:21px}}
</style>
