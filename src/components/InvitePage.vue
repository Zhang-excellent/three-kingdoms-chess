<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ORDER, PLAYERS } from '../game.ts';
import type { Faction } from '../game.ts';
import type { PublicRoomSummary } from '../online.ts';

const props = defineProps<{
  roomCode: string;
  room: PublicRoomSummary | null;
  lookup: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  error: string;
  connection: 'offline' | 'connecting' | 'online' | 'replaced';
  busy: boolean;
  existingRoomCode: string | null;
}>();
const emit = defineEmits<{
  join: [faction: Faction, nickname: string];
  watch: [];
  retry: [];
  lobby: [];
  returnRoom: [];
  exitRoom: [];
}>();

const nickname = ref('');
const selectedFaction = ref<Faction | null>(null);
const occupied = (faction: Faction) => props.room?.players.some(player => player.faction === faction) ?? false;
const available = computed(() => ORDER.filter(faction => !occupied(faction)));
const phaseLabel = computed(() => !props.room ? ''
  : props.room.phase === 'playing' ? '对局已经开始' : props.room.phase === 'finished' ? '对局已结束' : '等待玩家');
const blockedLabel = computed(() => {
  if (!props.room) return '';
  if (props.room.phase === 'playing') return '对局已经开始';
  if (props.room.phase === 'finished') return '对局已结束';
  if (props.room.playerCount >= props.room.maxPlayers) return '房间已满';
  return '暂时无法加入';
});
const canJoin = computed(() => props.lookup === 'ready' && !!props.room?.joinable && !!selectedFaction.value);

watch(() => props.room, room => {
  if (!room) { selectedFaction.value = null; return; }
  const choices = ORDER.filter(faction => !room.players.some(player => player.faction === faction));
  if (!selectedFaction.value || !choices.includes(selectedFaction.value))
    selectedFaction.value = choices[0] ?? null;
}, { immediate: true });
watch(() => props.roomCode, () => { nickname.value = ''; selectedFaction.value = null; });

function submit() {
  if (!canJoin.value || !selectedFaction.value) return;
  emit('join', selectedFaction.value, nickname.value.trim());
}
</script>

<template>
  <main class="lobby-page invite-page">
    <header class="lobby-page-heading">
      <h1>好友邀请</h1>
      <p>房间 <strong>{{ roomCode }}</strong></p>
    </header>

    <section class="lobby-entry-card invite-entry">
      <template v-if="existingRoomCode">
        <span class="lobby-card-kicker">已有房间</span>
        <h2>你已在房间 {{ existingRoomCode }}</h2>
        <p class="invite-note">这个邀请指向房间 {{ roomCode }}。系统不会自动退出或覆盖你当前的席位。</p>
        <div class="entry-actions">
          <button class="primary-button" @click="emit('returnRoom')">返回原房间</button>
          <button class="tool-button" :disabled="busy || connection !== 'online'" @click="emit('exitRoom')">退出原房间并加入邀请</button>
        </div>
        <button class="plain-button invite-back" @click="emit('lobby')">返回大厅</button>
      </template>

      <template v-else-if="lookup === 'loading' || lookup === 'idle'">
        <span class="lobby-card-kicker">好友邀请</span>
        <h2>正在确认房间</h2>
        <p class="invite-note">请稍候，正在向服务器查询这个邀请。</p>
      </template>

      <template v-else-if="lookup === 'missing'">
        <span class="lobby-card-kicker">好友邀请</span>
        <h2>邀请已失效</h2>
        <p class="invite-note">{{ error || '这个房间不存在或已经结束。' }}</p>
        <div class="entry-actions">
          <button class="primary-button" @click="emit('lobby')">返回大厅</button>
          <button class="tool-button" @click="emit('retry')">重新查询</button>
        </div>
      </template>

      <template v-else-if="lookup === 'error'">
        <span class="lobby-card-kicker">好友邀请</span>
        <h2>暂时无法读取邀请</h2>
        <p class="invite-note">{{ error }}</p>
        <div class="entry-actions">
          <button class="primary-button" @click="emit('retry')">重新查询</button>
          <button class="tool-button" @click="emit('lobby')">返回大厅</button>
        </div>
      </template>

      <template v-else-if="room">
        <div class="invite-room-heading">
          <div><span class="lobby-card-kicker">房间 {{ room.code }}</span><h2>{{ phaseLabel }}</h2></div>
          <strong>{{ room.playerCount }}/{{ room.maxPlayers }}</strong>
        </div>
        <div class="invite-player-list">
          <span v-for="(player, index) in room.players" :key="index">
            {{ player.nickname }} · {{ player.faction ? PLAYERS[player.faction].nation + '方' : '未选阵营' }}
          </span>
          <span v-for="slot in room.maxPlayers - room.playerCount" :key="`empty-${slot}`" class="empty">{{ slot === 1 ? '还有一个席位' : `还有 ${slot} 个席位` }}</span>
        </div>

        <template v-if="!room.joinable">
          <p class="invite-note">{{ blockedLabel }}，你可以进入观战。</p>
          <div class="entry-actions">
            <button class="primary-button" :disabled="busy || connection !== 'online'" @click="emit('watch')">进入观战</button>
            <button class="tool-button" @click="emit('lobby')">返回大厅</button>
          </div>
        </template>

        <form v-else @submit.prevent="submit">
          <p class="invite-note">选择空闲阵营后加入，昵称可以留空。</p>
          <div class="faction-choice invite-factions">
            <span>选择阵营</span>
            <div>
              <button v-for="faction in ORDER" :key="faction" type="button" :class="[faction, { selected: selectedFaction === faction }]"
                :disabled="occupied(faction)" @click="selectedFaction = faction">
                {{ PLAYERS[faction].nation }} · {{ PLAYERS[faction].name }}
              </button>
            </div>
          </div>
          <label>昵称<input v-model="nickname" maxlength="16" autocomplete="nickname"></label>
          <p v-if="error" class="connection-note error" role="status">{{ error }}</p>
          <div class="entry-actions">
            <button class="primary-button" type="submit" :disabled="!canJoin || busy || connection !== 'online'">加入房间</button>
            <button class="tool-button" type="button" :disabled="busy || connection !== 'online'" @click="emit('watch')">先观战</button>
          </div>
          <button class="plain-button invite-back" type="button" @click="emit('lobby')">返回大厅</button>
        </form>
      </template>
    </section>
  </main>
</template>

<style scoped>
.invite-page{max-width:720px}.invite-page .lobby-page-heading p{font-size:13px;font-weight:600;color:#756552}
.invite-page .lobby-page-heading strong{color:#8f4437;letter-spacing:2px}
.invite-entry{display:grid;gap:18px;padding:30px}.invite-entry h2{font-size:26px;margin:4px 0}
.invite-note{font-size:13px;line-height:1.8;color:#756552}.invite-room-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.invite-room-heading>strong{font:700 22px "Songti SC",serif;color:#8f4437}.invite-player-list{display:flex;flex-wrap:wrap;gap:7px}
.invite-player-list span{padding:7px 10px;border-radius:7px;background:#f4eee3;font-size:12px;font-weight:600;color:#665847}
.invite-player-list .empty{border:1px dashed #d5c8b6;background:transparent;color:#9a8a76}
.invite-factions{margin:2px 0}.invite-entry label{display:grid;gap:7px;font-size:13px;font-weight:600;color:#625444}
.invite-entry input{border:1px solid #d8cab4;background:#fffefb;border-radius:8px;padding:11px 12px;outline:none;font:inherit;font-size:14px;font-weight:500;color:#43382d}
.invite-entry input::placeholder{color:#8c7a66;font-weight:500;opacity:1}.invite-entry input:focus{border-color:#a78147;box-shadow:0 0 0 3px #a781471b}
.invite-back{justify-self:start;color:#7f705c;border-bottom:1px solid #d2c3aa}
@media(max-width:720px){.invite-entry{padding:20px}.invite-entry h2{font-size:23px}.invite-room-heading>strong{font-size:19px}.entry-actions{display:grid;grid-template-columns:1fr}.entry-actions button{width:100%}}
</style>
