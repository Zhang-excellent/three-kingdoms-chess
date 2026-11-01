<script setup lang="ts">
import { computed } from 'vue';
import { ORDER, PLAYERS, pieceName } from '../game.ts';
import type { Game, Faction, MoveRecord } from '../game.ts';
import type { RoomView } from '../online.ts';

const props = defineProps<{
  room: RoomView;
  connection: 'offline' | 'connecting' | 'online' | 'replaced';
  error: string;
}>();
const emit = defineEmits<{
  copyInvite: [];
  leave: [];
  chooseFaction: [faction: Faction];
  ready: [value: boolean];
  releaseOffline: [playerId: string];
  exportRecord: [game: Game];
}>();

const self = computed(() => props.room.players.find(player => player.id === props.room.selfId) ?? null);
const previousGame = computed(() => props.room.game?.status === 'finished' ? props.room.game : null);
const factionTaken = (faction: Faction) => props.room.players.some(player => player.id !== props.room.selfId && player.faction === faction);
const resultLabel = (game: Game, faction: Faction) => game.results[faction] === 'won' ? '胜利'
  : game.results[faction] === 'lost' ? '失败' : game.results[faction] === 'draw' ? '和棋' : '对局中';
const coordinate = (point: { x: number; y: number }) => `(${point.x + 1}, ${point.y + 1})`;
const description = (record: MoveRecord) => `${pieceName(record)} ${coordinate(record.from)} → ${coordinate(record.to)}`;
</script>

<template>
  <section class="room-lobby">
    <div class="room-heading">
      <div><span class="eyebrow">等待三人准备</span><h2>房间 {{ room.code }}</h2><p>邀请两位朋友，三人到齐并准备后自动开局。</p></div>
      <div class="room-heading-actions"><button class="tool-button" @click="emit('copyInvite')">复制邀请链接</button><button class="tool-button leave-button" @click="emit('leave')">退出房间</button></div>
    </div>

    <div class="lobby-players">
      <article v-for="player in room.players" :key="player.id" :class="{ self: player.id === room.selfId }">
        <span class="online-dot" :class="{ off: !player.online }"></span>
        <div><strong>{{ player.nickname }}</strong><small>{{ player.id === room.selfId ? '这是你' : player.online ? '在线' : '已断线，席位最多保留 60 秒' }}</small></div>
        <b>{{ player.faction ? `${PLAYERS[player.faction].nation}方` : '未选阵营' }}</b>
        <em>{{ player.ready ? '已准备' : '未准备' }}</em>
        <button v-if="!player.online && player.id !== room.selfId" class="tool-button release-button" :disabled="connection !== 'online'" @click="emit('releaseOffline', player.id)">释放席位</button>
      </article>
      <article v-for="slot in 3 - room.players.length" :key="`empty-${slot}`" class="empty"><span>等待朋友加入…</span></article>
    </div>

    <div class="faction-choice">
      <span>选择你的阵营</span>
      <div>
        <button v-for="faction in ORDER" :key="faction" :class="[faction, { selected: self?.faction === faction }]"
          :disabled="factionTaken(faction) || connection !== 'online'" @click="emit('chooseFaction', faction)">
          {{ PLAYERS[faction].nation }} · {{ PLAYERS[faction].name }}
        </button>
      </div>
    </div>
    <button class="primary-button ready-button" :disabled="!self?.faction || connection !== 'online'" @click="emit('ready', !self?.ready)">
      {{ self?.ready ? '取消准备' : '我已准备' }}
    </button>
    <p class="lobby-tip">三人全部在线、阵营不同且准备完毕后自动开局。</p>
    <p v-if="error" class="connection-note error">{{ error }}</p>

    <div v-if="previousGame" class="previous-game">
      <div class="previous-game-heading"><strong>上一局结果</strong><button class="record-export-button" @click="emit('exportRecord', previousGame)">导出棋谱</button></div>
      <p v-for="faction in ORDER" :key="faction">{{ PLAYERS[faction].name }} · {{ resultLabel(previousGame, faction) }}</p>
      <details>
        <summary>查看上一局棋谱（{{ previousGame.history.length }} 步）</summary>
        <ol><li v-for="record in previousGame.history" :key="record.number">{{ record.number }}. {{ PLAYERS[record.faction].name }} · {{ description(record) }}</li></ol>
      </details>
    </div>
  </section>
</template>
