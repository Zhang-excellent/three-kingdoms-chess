<script setup lang="ts">
import { computed } from 'vue';
import { PLAYERS } from '../game.ts';
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
  createTable: [];
  join: [code?: string];
  watch: [code?: string];
  updateNickname: [value: string];
  updateCreateCode: [value: string];
  updateJoinCode: [value: string];
  updateListed: [value: boolean];
}>();

const online = computed(() => props.connection === 'online');
const phaseLabel = (phase: RoomPhase) => phase === 'lobby' ? '等待中' : phase === 'playing' ? '对局中' : '已结束';
const title = computed(() => props.mode === 'public' ? '公开对战大厅' : '与好友对弈');
const subtitle = computed(() => props.mode === 'public'
  ? ''
  : '创建 6 位数字房间，把号码或邀请链接发给朋友。');
const publicRoom = computed(() => props.rooms.find(room => room.code === PUBLIC_ROOM_CODE) ?? null);
const tableSlots = computed(() => Array.from({ length: 9 }, (_, index) =>
  props.rooms.filter(room => room.code !== PUBLIC_ROOM_CODE)[index] ?? null));
const playerAt = (room: PublicRoomSummary | null, faction: keyof typeof PLAYERS) =>
  room?.players.find(player => player.faction === faction) ?? null;
function activateTable(room: PublicRoomSummary | null) {
  if (!room) emit('createTable');
  else if (room.joinable) emit('join', room.code);
  else emit('watch', room.code);
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
      <span class="eyebrow">游客体验 · 无需登录</span>
      <h1>{{ title }}</h1>
      <p v-if="subtitle">{{ subtitle }}</p>
    </header>

    <div v-if="hasRoom" class="lobby-current-room">
      <div><span>你已在一个房间中</span><strong>{{ currentRoomCode ?? '正在恢复房间' }}</strong></div>
      <button class="primary-button" :disabled="!currentRoomCode" @click="emit('resume')">
        {{ currentRoomPhase === 'lobby' ? '返回等待区' : '返回对局' }}
      </button>
    </div>

    <section v-if="mode === 'public'" class="public-player-entry">
      <label for="lobby-nickname">你的昵称</label>
      <input id="lobby-nickname" :value="nickname" maxlength="16" autocomplete="nickname" placeholder="先填写昵称，再点击桌位加入" @input="emit('updateNickname', ($event.target as HTMLInputElement).value)">
      <span>共 10 张桌 · 第一张为常驻公开桌</span>
    </section>

    <section v-if="mode === 'friends'" class="lobby-entry-grid">
      <form class="lobby-entry-card" @submit.prevent="emit('create')">
        <span class="lobby-card-kicker">创建房间</span>
        <h2>开一桌等朋友</h2>
        <label>你的昵称<input :value="nickname" maxlength="16" autocomplete="nickname" placeholder="最多 16 个字符" @input="emit('updateNickname', ($event.target as HTMLInputElement).value)"></label>
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

    <section v-if="mode === 'public'" class="public-room-section chess-club-hall" aria-label="棋社桌位" aria-live="polite">
      <div class="public-room-heading">
        <h2>棋社桌位</h2><span>10 张桌</span>
      </div>
      <div class="chess-club-tables">
        <article class="chess-club-table public-table" :class="{ active: publicRoom?.playerCount }">
          <div class="club-seat wei" :class="{ occupied: playerAt(publicRoom, 'wei') }"><span class="club-seat-mark">曹</span><div><strong>曹操</strong><small>{{ playerAt(publicRoom, 'wei')?.nickname ?? '空位' }}</small></div></div>
          <div class="club-table-center">
            <span class="club-table-label">常驻棋桌</span>
            <strong>公开房间</strong>
            <small>{{ publicRoom ? `${phaseLabel(publicRoom.phase)} · ${publicRoom.playerCount}/3 席` : '等待开局' }}</small>
            <div class="club-table-actions">
              <button class="primary-button" :disabled="busy || !online || hasRoom || !publicRoom?.joinable" @click="activateTable(publicRoom)">加入</button>
              <button class="tool-button" :disabled="busy || !online || hasRoom || !publicRoom" @click="publicRoom && emit('watch', publicRoom.code)">观战</button>
            </div>
          </div>
          <div class="club-seat shu" :class="{ occupied: playerAt(publicRoom, 'shu') }"><span class="club-seat-mark">刘</span><div><strong>刘备</strong><small>{{ playerAt(publicRoom, 'shu')?.nickname ?? '空位' }}</small></div></div>
          <div class="club-seat wu" :class="{ occupied: playerAt(publicRoom, 'wu') }"><span class="club-seat-mark">孙</span><div><strong>孙权</strong><small>{{ playerAt(publicRoom, 'wu')?.nickname ?? '空位' }}</small></div></div>
        </article>

        <article v-for="(room, index) in tableSlots" :key="index" class="chess-club-table" :class="{ active: room, empty: !room }">
          <template v-for="faction in ['wei', 'shu', 'wu'] as const" :key="faction">
            <div class="club-seat" :class="[faction, { occupied: playerAt(room, faction) }]">
              <span class="club-seat-mark">{{ PLAYERS[faction].initial }}</span>
              <div><strong>{{ PLAYERS[faction].name }}</strong><small>{{ playerAt(room, faction)?.nickname ?? '空位' }}</small></div>
            </div>
            <div v-if="faction === 'wei'" class="club-table-center">
              <span class="club-table-label">第 {{ index + 2 }} 桌</span>
              <strong>{{ room?.code ?? '空桌' }}</strong>
              <small>{{ room ? `${phaseLabel(room.phase)} · ${room.playerCount}/3 席` : '点击点亮这桌' }}</small>
              <div class="club-table-actions">
                <button v-if="!room" class="primary-button" :disabled="busy || !online || hasRoom" @click="emit('createTable')">创建</button>
                <template v-else>
                  <button v-if="room.joinable" class="primary-button" :disabled="busy || !online || hasRoom" @click="emit('join', room.code)">加入</button>
                  <button class="tool-button" :disabled="busy || !online || hasRoom" @click="emit('watch', room.code)">观战</button>
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
  </main>
</template>
