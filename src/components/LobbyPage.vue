<script setup lang="ts">
import { computed } from 'vue';
import { PLAYERS } from '../game.ts';
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
  join: [code?: string];
  watch: [code?: string];
  updateNickname: [value: string];
  updateCreateCode: [value: string];
  updateJoinCode: [value: string];
  updateListed: [value: boolean];
}>();

const online = computed(() => props.connection === 'online');
const phaseLabel = (phase: RoomPhase) => phase === 'lobby' ? '等待中' : phase === 'playing' ? '对局中' : '已结束';
const factionLabel = (faction: keyof typeof PLAYERS | null) => faction ? `${PLAYERS[faction].nation} · ${PLAYERS[faction].name}` : '未选阵营';
const title = computed(() => props.mode === 'public' ? '公开对战大厅' : '与好友对弈');
const subtitle = computed(() => props.mode === 'public'
  ? '选择有空位的房间加入，或创建自己的房间等待棋友。'
  : '创建 6 位数字房间，把号码或邀请链接发给朋友。');
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
      <p>{{ subtitle }}</p>
    </header>

    <div v-if="hasRoom" class="lobby-current-room">
      <div><span>你已在一个房间中</span><strong>{{ currentRoomCode ?? '正在恢复房间' }}</strong></div>
      <button class="primary-button" :disabled="!currentRoomCode" @click="emit('resume')">
        {{ currentRoomPhase === 'lobby' ? '返回等待区' : '返回对局' }}
      </button>
    </div>

    <section class="lobby-entry-grid">
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

    <section v-if="mode === 'public'" class="public-room-section" aria-label="公开房间列表" aria-live="polite">
      <div class="public-room-heading">
        <div><span class="eyebrow">实时更新</span><h2>公开房间</h2></div>
        <span>{{ rooms.length }} 桌</span>
      </div>
      <div v-if="rooms.length" class="public-room-list">
        <article v-for="room in rooms" :key="room.code" class="public-room-card">
          <div class="public-room-main">
            <div class="public-room-code"><span>房间</span><strong>{{ room.code }}</strong></div>
            <div class="public-room-meta">
              <span class="room-phase" :class="room.phase">{{ phaseLabel(room.phase) }}</span>
              <span>{{ room.playerCount }}/{{ room.maxPlayers }} 席</span>
            </div>
          </div>
          <div class="public-room-players">
            <span v-for="(player, index) in room.players" :key="`${room.code}-${index}`" :class="{ offline: !player.online }">
              {{ player.nickname }} · {{ factionLabel(player.faction) }}
            </span>
            <span v-for="slot in room.maxPlayers - room.playerCount" :key="`empty-${slot}`" class="empty">空位</span>
          </div>
          <div class="public-room-actions">
            <button v-if="room.joinable" class="primary-button" :disabled="busy || !online || hasRoom" @click="emit('join', room.code)">加入</button>
            <button class="tool-button" :disabled="busy || !online || hasRoom" @click="emit('watch', room.code)">观战</button>
          </div>
        </article>
      </div>
      <div v-else-if="loaded" class="public-room-empty">
        <span aria-hidden="true">弈</span>
        <h3>大厅还没有房间</h3>
        <p>创建一个公开房间，让正在大厅的棋友加入。</p>
        <button class="primary-button" :disabled="busy || !online || hasRoom" @click="emit('create')">创建第一个房间</button>
      </div>
      <div v-else class="public-room-empty">
        <p>正在获取公开房间…</p>
      </div>
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
