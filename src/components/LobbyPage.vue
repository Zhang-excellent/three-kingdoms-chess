<script setup lang="ts">
import { computed, ref } from 'vue';
import { PLAYERS } from '../game.ts';
import type { Faction } from '../game.ts';
import { PUBLIC_ROOM_CODE } from '../online.ts';
import type { PublicRoomSummary, RoomPhase } from '../online.ts';

const props = defineProps<{
  mode: 'public' | 'friends';
  rooms: PublicRoomSummary[];
  nickname: string;
  createCode: string;
  joinCode: string;
  listed: boolean;
  busy: boolean;
  connection: 'offline' | 'connecting' | 'online' | 'replaced';
  error: string;
  loaded: boolean;
  hasRoom: boolean;
  currentRoomCode: string | null;
  currentRoomPhase: RoomPhase | null;
}>();
const emit = defineEmits<{
  home: [];
  switchPublic: [];
  switchFriends: [];
  resume: [];
  create: [];
  createTable: [faction: Faction, nickname: string, roomCode: string];
  joinSeat: [roomCode: string, faction: Faction, nickname: string];
  join: [code?: string];
  watch: [code?: string];
  updateNickname: [value: string];
  updateCreateCode: [value: string];
  updateJoinCode: [value: string];
  updateListed: [value: boolean];
}>();

const online = computed(() => props.connection === 'online');
const phaseLabel = (phase: RoomPhase) => phase === 'lobby' ? '等待中' : phase === 'playing' ? '对局中' : '已结束';
const title = computed(() => props.mode === 'public' ? '公开对战大厅' : '好友对弈');
const publicRoom = computed(() => props.rooms.find(room => room.code === PUBLIC_ROOM_CODE) ?? null);
const tableSlots = computed(() => Array.from({ length: 9 }, (_, index) =>
  props.rooms.filter(room => room.code !== PUBLIC_ROOM_CODE)[index] ?? null));
const playerAt = (room: PublicRoomSummary | null, faction: keyof typeof PLAYERS) =>
  room?.players.find(player => player.faction === faction) ?? null;
const unassignedPlayers = (room: PublicRoomSummary | null) =>
  room?.players.filter(player => !player.faction) ?? [];
const tableDialog = ref<HTMLDialogElement | null>(null);
const tableIntent = ref<'join' | 'create'>('join');
const selectedRoom = ref<PublicRoomSummary | null>(null);
const selectedFaction = ref<Faction>('wei');
const selectedTableNumber = ref(1);
const tableNickname = ref('');
const tableRoomCode = ref('');
const tableError = ref('');
const tableTitle = computed(() => tableIntent.value === 'join' && selectedRoom.value
  ? `加入房间 ${selectedRoom.value.code}`
  : `点亮第 ${selectedTableNumber.value} 桌`);

function openTableDialog(room: PublicRoomSummary | null, faction: Faction, tableNumber: number) {
  if (props.hasRoom || props.busy || !online.value) return;
  if (room && (!room.joinable || playerAt(room, faction))) {
    if (!room.joinable) emit('watch', room.code);
    return;
  }
  tableIntent.value = room ? 'join' : 'create';
  selectedRoom.value = room;
  selectedFaction.value = faction;
  selectedTableNumber.value = tableNumber;
  tableNickname.value = props.nickname;
  tableRoomCode.value = '';
  tableError.value = '';
  tableDialog.value?.showModal();
}
function openTableCenter(room: PublicRoomSummary | null, tableNumber: number) {
  if (room && !room.joinable) { emit('watch', room.code); return; }
  const faction = (['wei', 'shu', 'wu'] as Faction[]).find(item => !playerAt(room, item)) ?? 'wei';
  openTableDialog(room, faction, tableNumber);
}
function chooseTableFaction(faction: Faction) {
  const occupied = playerAt(selectedRoom.value, faction);
  if (tableIntent.value === 'join' && occupied) return;
  selectedFaction.value = faction;
}
function submitTableDialog() {
  tableError.value = '';
  if (tableIntent.value === 'create' && !/^\d{6}$/.test(tableRoomCode.value)) {
    tableError.value = '房间号需要是 6 位数字。';
    return;
  }
  if (tableIntent.value === 'join' && selectedRoom.value)
    emit('joinSeat', selectedRoom.value.code, selectedFaction.value, tableNickname.value.trim());
  else emit('createTable', selectedFaction.value, tableNickname.value.trim(), tableRoomCode.value);
}
</script>

<template>
  <main class="lobby-page">
    <div class="lobby-page-nav">
      <button class="plain-button" @click="emit('home')">← 返回首页</button>
      <div class="lobby-tabs" aria-label="联机入口">
        <button :class="{ active: mode === 'public' }" @click="mode !== 'public' && emit('switchPublic')">公开大厅</button>
        <button :class="{ active: mode === 'friends' }" @click="mode !== 'friends' && emit('switchFriends')">好友组局</button>
      </div>
    </div>

    <header class="lobby-page-heading">
      <h1>{{ title }}</h1>
    </header>

    <div v-if="hasRoom" class="lobby-current-room">
      <div><span>你已在一个房间中</span><strong>{{ currentRoomCode ?? '正在恢复房间' }}</strong></div>
      <button class="primary-button" :disabled="!currentRoomCode" @click="emit('resume')">
        {{ currentRoomPhase === 'lobby' ? '返回等待区' : '返回对局' }}
      </button>
    </div>

    <section v-if="mode === 'friends'" class="lobby-entry-grid">
      <form class="lobby-entry-card" @submit.prevent="emit('create')">
        <span class="lobby-card-kicker">创建房间</span>
        <h2>开一桌等朋友</h2>
        <label>昵称：<input :value="nickname" maxlength="16" autocomplete="nickname" placeholder="可不填" @input="emit('updateNickname', ($event.target as HTMLInputElement).value)"></label>
        <label>6 位数字房间号<input :value="createCode" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" autocomplete="off" aria-label="创建房间号" placeholder="例如 001234" @input="emit('updateCreateCode', ($event.target as HTMLInputElement).value.replace(/[^0-9]/g, ''))"></label>
        <label class="lobby-listed-option"><input type="checkbox" :checked="listed" @change="emit('updateListed', ($event.target as HTMLInputElement).checked)">在大厅展示这个房间</label>
        <button class="primary-button" type="submit" :disabled="busy || !online || hasRoom">创建房间</button>
      </form>

      <form class="lobby-entry-card lobby-join-card" @submit.prevent="emit('join')">
        <span class="lobby-card-kicker">加入房间</span>
        <h2>已有房间号</h2>
        <label>房间号<input :value="joinCode" maxlength="6" inputmode="numeric" autocomplete="off" aria-label="加入房间号" placeholder="输入 6 位房间号" @input="emit('updateJoinCode', ($event.target as HTMLInputElement).value.toUpperCase())"></label>
        <p>对局已经开始时仍可进入观战。</p>
        <div class="lobby-join-actions">
          <button class="primary-button" type="submit" :disabled="busy || !online || hasRoom">加入房间</button>
          <button class="tool-button" type="button" :disabled="busy || !online || hasRoom" @click="emit('watch')">观战</button>
        </div>
      </form>
    </section>

    <p v-if="connection !== 'online' || error" class="connection-note" :class="{ error }">{{ error || '连接中断，正在重连…' }}</p>

    <section v-if="mode === 'public'" class="public-room-section chess-club-hall" aria-label="大厅桌位" aria-live="polite">
      <div class="public-room-heading">
        <span>10 张桌</span>
      </div>
      <div class="chess-club-tables">
        <article class="chess-club-table public-table" :class="{ active: publicRoom?.playerCount }">
          <button type="button" class="club-seat wei" :class="{ occupied: playerAt(publicRoom, 'wei') }" :disabled="hasRoom || busy || !online || !!playerAt(publicRoom, 'wei')" @click="openTableDialog(publicRoom, 'wei', 1)">
            <span class="club-seat-mark">曹</span><span><strong>曹操</strong><small>{{ playerAt(publicRoom, 'wei')?.nickname ?? '空位' }}</small></span>
          </button>
          <div class="club-table-center" :class="{ watchable: publicRoom && !publicRoom.joinable }" @click="publicRoom && !publicRoom.joinable && emit('watch', publicRoom.code)">
            <span class="club-table-label">常驻棋桌</span>
            <strong>公开房间</strong>
            <small>{{ publicRoom ? `${phaseLabel(publicRoom.phase)} · ${publicRoom.playerCount}/3 席` : '等待开局' }}</small>
            <small v-if="unassignedPlayers(publicRoom).length" class="club-unassigned">
              {{ unassignedPlayers(publicRoom).map(player => player.nickname).join('、') }} · 待选阵营
            </small>
            <div class="club-table-actions">
              <button v-if="publicRoom?.joinable" class="primary-button" :disabled="busy || !online || hasRoom" @click.stop="openTableCenter(publicRoom, 1)">选择席位</button>
              <button class="tool-button" :disabled="busy || !online || hasRoom || !publicRoom" @click.stop="publicRoom && emit('watch', publicRoom.code)">观战</button>
            </div>
          </div>
          <button type="button" class="club-seat shu" :class="{ occupied: playerAt(publicRoom, 'shu') }" :disabled="hasRoom || busy || !online || !!playerAt(publicRoom, 'shu')" @click="openTableDialog(publicRoom, 'shu', 1)">
            <span class="club-seat-mark">刘</span><span><strong>刘备</strong><small>{{ playerAt(publicRoom, 'shu')?.nickname ?? '空位' }}</small></span>
          </button>
          <button type="button" class="club-seat wu" :class="{ occupied: playerAt(publicRoom, 'wu') }" :disabled="hasRoom || busy || !online || !!playerAt(publicRoom, 'wu')" @click="openTableDialog(publicRoom, 'wu', 1)">
            <span class="club-seat-mark">孙</span><span><strong>孙权</strong><small>{{ playerAt(publicRoom, 'wu')?.nickname ?? '空位' }}</small></span>
          </button>
        </article>

        <article v-for="(room, index) in tableSlots" :key="index" class="chess-club-table" :class="{ active: room, empty: !room }">
          <template v-for="faction in ['wei', 'shu', 'wu'] as const" :key="faction">
            <button type="button" class="club-seat" :class="[faction, { occupied: playerAt(room, faction) }]"
              :disabled="hasRoom || busy || !online || !!playerAt(room, faction) || (!!room && !room.joinable)"
              @click="openTableDialog(room, faction, index + 2)">
              <span class="club-seat-mark">{{ PLAYERS[faction].initial }}</span>
              <span><strong>{{ PLAYERS[faction].name }}</strong><small>{{ playerAt(room, faction)?.nickname ?? '空位' }}</small></span>
            </button>
            <div v-if="faction === 'wei'" class="club-table-center" :class="{ watchable: room && !room.joinable }" @click="room && !room.joinable && emit('watch', room.code)">
              <span class="club-table-label">第 {{ index + 2 }} 桌</span>
              <strong>{{ room?.code ?? '空桌' }}</strong>
              <small>{{ room ? `${phaseLabel(room.phase)} · ${room.playerCount}/3 席` : '点击空位创建' }}</small>
              <small v-if="unassignedPlayers(room).length" class="club-unassigned">
                {{ unassignedPlayers(room).map(player => player.nickname).join('、') }} · 待选阵营
              </small>
              <div class="club-table-actions">
                <button v-if="!room" class="primary-button" :disabled="busy || !online || hasRoom" @click.stop="openTableCenter(null, index + 2)">创建</button>
                <template v-else>
                  <button v-if="room.joinable" class="primary-button" :disabled="busy || !online || hasRoom" @click.stop="openTableCenter(room, index + 2)">选择席位</button>
                  <button class="tool-button" :disabled="busy || !online || hasRoom" @click.stop="emit('watch', room.code)">观战</button>
                </template>
              </div>
            </div>
          </template>
        </article>
      </div>
      <p v-if="!loaded" class="club-loading">正在连接棋社…</p>
    </section>

    <section v-else class="friend-flow-note">
      <h2>组局怎么进行？</h2>
      <ol>
        <li>创建 6 位数字房间，并决定是否在大厅公开展示。</li>
        <li>把房间号或邀请链接发给两位朋友。</li>
        <li>三人分别选择魏、蜀、吴并准备，随后自动开局。</li>
      </ol>
    </section>

    <dialog ref="tableDialog" class="lobby-seat-dialog">
      <form @submit.prevent="submitTableDialog">
        <div class="dialog-heading"><h2>{{ tableTitle }}</h2><button type="button" class="dialog-close" aria-label="关闭" @click="tableDialog?.close()">×</button></div>
        <p class="lobby-seat-as">席位：{{ PLAYERS[selectedFaction].nation }}方 · {{ PLAYERS[selectedFaction].name }}</p>
        <div class="lobby-seat-factions">
          <button v-for="faction in ['wei', 'shu', 'wu'] as const" :key="faction" type="button" :class="[faction, { selected: selectedFaction === faction }]"
            :disabled="tableIntent === 'join' && !!playerAt(selectedRoom, faction)" @click="chooseTableFaction(faction)">
            {{ PLAYERS[faction].nation }} · {{ PLAYERS[faction].name }}
          </button>
        </div>
        <label>昵称：<input v-model="tableNickname" maxlength="16" autocomplete="nickname" placeholder="可不填"></label>
        <label v-if="tableIntent === 'create'">房间号：<input v-model="tableRoomCode" maxlength="6" inputmode="numeric" autocomplete="off" placeholder="输入 6 位数字房间号" @input="tableRoomCode = tableRoomCode.replace(/[^0-9]/g, '')"></label>
        <p v-if="tableError || error" class="connection-note error" role="status">{{ tableError || error }}</p>
        <div class="dialog-actions"><button class="tool-button" type="button" @click="tableDialog?.close()">取消</button><button class="primary-button" type="submit" :disabled="busy || !online">{{ tableIntent === 'create' ? '创建并入座' : '加入并入座' }}</button></div>
      </form>
    </dialog>
  </main>
</template>

<style scoped>
.club-unassigned{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9c503c!important}
.lobby-card-kicker{font-size:10px;font-weight:700}
.lobby-entry-card h2{font-size:24px}
.lobby-entry-card label{font-size:13px;font-weight:600;color:#625444}
.lobby-entry-card input{font-size:14px;font-weight:500;color:#43382d}
.lobby-entry-card input::placeholder{color:#8c7a66;font-weight:500;opacity:1}
.lobby-entry-card .lobby-listed-option{font-size:12px;font-weight:600}
.lobby-join-card>p{font-size:12px;font-weight:500;line-height:1.7}
.lobby-seat-dialog label{font-size:13px;font-weight:600;color:#625444}
.lobby-seat-dialog input{font-size:14px;font-weight:500;color:#43382d}
.lobby-seat-dialog input::placeholder{color:#8c7a66;font-weight:500;opacity:1}
.lobby-seat-as{font-size:12px;font-weight:600}
.lobby-seat-factions button{font-size:11px;font-weight:600}
</style>
