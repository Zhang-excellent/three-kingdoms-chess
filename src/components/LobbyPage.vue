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
const lastFriendAction = ref<'create' | 'join' | null>(null);
const tableTitle = computed(() => tableIntent.value === 'join' && selectedRoom.value
  ? `加入房间 ${selectedRoom.value.code}`
  : `点亮第 ${selectedTableNumber.value} 桌`);
const createRoomInvalid = computed(() => lastFriendAction.value === 'create' && !!props.error);
const joinRoomInvalid = computed(() => lastFriendAction.value === 'join' && !!props.error);
const tableRoomCodeInvalid = computed(() => tableIntent.value === 'create' && !!tableError.value);

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
function tableFactionStatus(faction: Faction): '已占用' | '已选择' | '空位' {
  if (tableIntent.value === 'join' && playerAt(selectedRoom.value, faction)) return '已占用';
  return selectedFaction.value === faction ? '已选择' : '空位';
}
function requestCreate() {
  lastFriendAction.value = 'create';
  emit('create');
}
function requestJoin() {
  lastFriendAction.value = 'join';
  emit('join');
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
  <main class="lobby-page" :class="{ 'friend-lobby-page': mode === 'friends' }">
    <div class="lobby-page-nav">
      <button class="plain-button" @click="emit('home')">← 返回首页</button>
      <div class="lobby-tabs" aria-label="联机入口">
        <button :class="{ active: mode === 'public' }" @click="mode !== 'public' && emit('switchPublic')">公开大厅</button>
        <button :class="{ active: mode === 'friends' }" @click="mode !== 'friends' && emit('switchFriends')">好友组局</button>
      </div>
    </div>

    <header class="lobby-page-heading" :class="{ 'friend-page-heading': mode === 'friends' }">
      <span v-if="mode === 'friends'" class="friend-page-seal" aria-hidden="true">友</span>
      <h1>{{ title }}</h1>
    </header>

    <div v-if="hasRoom" class="lobby-current-room">
      <div><span>你已在一个房间中</span><strong>{{ currentRoomCode ?? '正在恢复房间' }}</strong></div>
      <button class="primary-button" :disabled="!currentRoomCode" @click="emit('resume')">
        {{ currentRoomPhase === 'lobby' ? '返回等待区' : '返回对局' }}
      </button>
    </div>

    <section v-if="mode === 'friends'" class="lobby-entry-grid">
      <form class="lobby-entry-card friend-task-card friend-create-card" @submit.prevent="requestCreate">
        <header class="friend-task-heading">
          <span class="friend-task-seal" aria-hidden="true">开</span>
          <h2>创建房间</h2>
        </header>
        <div class="friend-task-fields">
          <label>昵称：<input :value="nickname" maxlength="16" autocomplete="nickname" @input="emit('updateNickname', ($event.target as HTMLInputElement).value)"></label>
          <label>房间号：<input :value="createCode" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" autocomplete="off" aria-label="创建房间号" placeholder="例如 001234" :class="{ 'is-invalid': createRoomInvalid }" :aria-invalid="createRoomInvalid ? 'true' : undefined" @input="emit('updateCreateCode', ($event.target as HTMLInputElement).value.replace(/[^0-9]/g, ''))"></label>
          <span class="friend-field-note">6 位数字，前导零会保留</span>
        </div>
        <label class="lobby-listed-option friend-checkbox"><input type="checkbox" :checked="listed" @change="emit('updateListed', ($event.target as HTMLInputElement).checked)"><span>在大厅展示这个房间</span></label>
        <button class="primary-button friend-primary-action" type="submit" :disabled="busy || !online || hasRoom">创建房间</button>
      </form>

      <form class="lobby-entry-card friend-task-card lobby-join-card friend-join-card" @submit.prevent="requestJoin">
        <header class="friend-task-heading">
          <span class="friend-task-seal" aria-hidden="true">入</span>
          <h2>加入房间</h2>
        </header>
        <div class="friend-task-fields">
          <label>房间号：<input :value="joinCode" maxlength="6" inputmode="numeric" autocomplete="off" aria-label="加入房间号" placeholder="输入 6 位房间号" :class="{ 'is-invalid': joinRoomInvalid }" :aria-invalid="joinRoomInvalid ? 'true' : undefined" @input="emit('updateJoinCode', ($event.target as HTMLInputElement).value.toUpperCase())"></label>
          <span class="friend-field-note">输入房主分享的 6 位数字房间号</span>
        </div>
        <p class="friend-join-hint">对局已经开始时仍可进入观战。</p>
        <div class="lobby-join-actions">
          <button class="primary-button friend-primary-action" type="submit" :disabled="busy || !online || hasRoom">加入房间</button>
          <button class="tool-button friend-secondary-action" type="button" :disabled="busy || !online || hasRoom" @click="emit('watch')">观战</button>
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
      <h2>组局流程</h2>
      <ol>
        <li><span aria-hidden="true">壹</span><p>创建 6 位数字房间，并决定是否在大厅公开展示。</p></li>
        <li><span aria-hidden="true">贰</span><p>把房间号或邀请链接发给两位朋友。</p></li>
        <li><span aria-hidden="true">叁</span><p>三人分别选择魏、蜀、吴并准备，随后自动开局。</p></li>
      </ol>
    </section>

    <dialog ref="tableDialog" class="lobby-seat-dialog">
      <form @submit.prevent="submitTableDialog">
        <div class="dialog-heading seat-dialog-heading">
          <div><span>{{ tableIntent === 'join' ? '选择席位' : '新设棋桌' }}</span><h2>{{ tableTitle }}</h2></div>
          <button type="button" class="dialog-close" aria-label="关闭" @click="tableDialog?.close()">×</button>
        </div>
        <section class="seat-dialog-section" aria-labelledby="seat-faction-label">
          <div class="seat-section-heading"><strong id="seat-faction-label">阵营席位</strong><span>点击棋子选择</span></div>
          <div class="lobby-seat-factions" role="group" aria-label="选择阵营席位">
            <button v-for="faction in ['wei', 'shu', 'wu'] as const" :key="faction" type="button"
              :class="[faction, { selected: selectedFaction === faction, occupied: tableIntent === 'join' && !!playerAt(selectedRoom, faction) }]"
              :aria-pressed="selectedFaction === faction"
              :disabled="tableIntent === 'join' && !!playerAt(selectedRoom, faction)" @click="chooseTableFaction(faction)">
              <span class="seat-faction-piece" aria-hidden="true">{{ PLAYERS[faction].initial }}</span>
              <span class="seat-faction-copy"><strong>{{ PLAYERS[faction].name }}</strong><small>{{ PLAYERS[faction].nation }}方</small></span>
              <span class="seat-faction-state">{{ tableFactionStatus(faction) }}</span>
            </button>
          </div>
        </section>
        <div class="seat-dialog-fields" :class="{ 'is-create': tableIntent === 'create' }">
          <label>昵称：<input v-model="tableNickname" maxlength="16" autocomplete="nickname"></label>
          <label v-if="tableIntent === 'create'">房间号：<input v-model="tableRoomCode" maxlength="6" inputmode="numeric" autocomplete="off" placeholder="输入 6 位数字房间号" :class="{ 'is-invalid': tableRoomCodeInvalid }" :aria-invalid="tableRoomCodeInvalid ? 'true' : undefined" @input="tableRoomCode = tableRoomCode.replace(/[^0-9]/g, '')"></label>
        </div>
        <p v-if="tableError || error" class="seat-dialog-error" role="alert">{{ tableError || error }}</p>
        <div class="dialog-actions seat-dialog-actions"><button class="tool-button seat-cancel" type="button" @click="tableDialog?.close()">取消</button><button class="primary-button" type="submit" :disabled="busy || !online">{{ tableIntent === 'create' ? '创建并入座' : '加入并入座' }}</button></div>
      </form>
    </dialog>
  </main>
</template>

<style scoped>
.lobby-page,.lobby-seat-dialog{
  --club-paper:#fffdf7;
  --club-paper-warm:#f8f2e7;
  --club-ink:#393129;
  --club-muted:#7f715f;
  --club-line:#d9cbb7;
  --club-line-strong:#bfa777;
  --club-red:#a64b3c;
  --club-red-dark:#8f3d31;
  --club-wood:#a9844e;
  --club-gold:#c09a58;
  --club-danger:#a34438;
  --club-radius:10px;
  --club-shadow:0 16px 42px #59432310;
}
.club-unassigned{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9c503c!important}
.lobby-page-nav>.plain-button{font-size:16px;font-weight:600;color:#5c5042}
.friend-lobby-page .lobby-page-nav{margin-bottom:22px;padding-bottom:14px;border-bottom:1px solid var(--club-line)}
.friend-lobby-page .lobby-tabs{background:#eee6d9;border-color:#d3c4ad;padding:4px;border-radius:11px}
.friend-lobby-page .lobby-tabs button{min-height:34px;padding:0 18px;font-size:13px;font-weight:600}
.friend-page-heading{display:flex;align-items:center;gap:16px;min-height:72px;margin:4px 0 22px}
.friend-page-heading h1{font-size:42px;line-height:1.15;letter-spacing:5px;margin:0;color:var(--club-ink)}
.friend-page-seal{display:grid;place-items:center;width:50px;height:56px;border:1px solid #8e3c30;border-radius:6px;background:linear-gradient(145deg,#b65a49,#944034);color:#fff8e9;font:700 29px/1 "STKaiti","KaiTi",serif;box-shadow:inset 0 0 0 3px #fff5df2e,0 6px 14px #7d3c2c1f;transform:rotate(-2deg)}
.friend-lobby-page .lobby-entry-grid{gap:22px;margin-top:0}
.friend-task-card{position:relative;display:flex;flex-direction:column;gap:18px;min-height:420px;padding:28px 28px 26px;border-color:var(--club-line);border-radius:18px;background:linear-gradient(150deg,#fffef9 0%,#fbf7ee 100%);box-shadow:var(--club-shadow);overflow:hidden;transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease}
.friend-task-card::before{content:"";position:absolute;inset:0 0 auto;height:4px;background:linear-gradient(90deg,var(--club-red),#c7905b 60%,transparent)}
.friend-task-card::after{content:"";position:absolute;right:-54px;bottom:-68px;width:180px;height:180px;border:1px solid #b8996628;border-radius:50%;box-shadow:0 0 0 18px #b899660d,0 0 0 38px #b8996608;pointer-events:none}
.friend-task-card:hover{border-color:#c9b48e;box-shadow:0 20px 48px #59432316;transform:translateY(-2px)}
.friend-task-heading{position:relative;z-index:1;display:flex;align-items:center;gap:13px;padding-bottom:17px;border-bottom:1px solid var(--club-line)}
.friend-task-heading h2{font:700 28px/1.2 "Songti SC","SimSun",serif;color:var(--club-ink);margin:0;letter-spacing:1px}
.friend-task-seal{display:grid;place-items:center;width:36px;height:40px;flex:none;border:1px solid #853a30;border-radius:5px;background:var(--club-red);color:#fff8e9;font:700 22px/1 "STKaiti","KaiTi",serif;box-shadow:inset 0 0 0 2px #fff3dc2e;transform:rotate(-2deg)}
.friend-join-card .friend-task-seal{border-color:#80653e;background:#ad8853}
.friend-task-fields{position:relative;z-index:1;display:grid;gap:10px}
.friend-task-card label{display:grid;gap:7px;margin:0;font-size:13px;font-weight:600;color:#625444}
.friend-task-card input{width:100%;height:46px;min-width:0;border:1px solid var(--club-line);border-radius:var(--club-radius);background:#fffefb;padding:0 13px;outline:none;color:var(--club-ink);font-family:inherit;font-size:15px;font-weight:500;line-height:1.2;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
.friend-task-card input[inputmode="numeric"]{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:16px;letter-spacing:.12em;font-variant-numeric:tabular-nums}
.friend-task-card input::placeholder{color:#94846f;font-weight:500;opacity:1}
.friend-task-card input:hover:not(:focus){border-color:#c8b593}
.friend-task-card input:focus{border-color:var(--club-line-strong);background:#fff;box-shadow:0 0 0 3px #a7814718}
.friend-task-card input.is-invalid{border-color:var(--club-danger);background:#fff9f7;box-shadow:0 0 0 3px #a3443814}
.friend-field-note{margin-top:-3px;padding-left:2px;font-size:11px;line-height:1.55;color:#8b7a65}
.friend-checkbox{display:flex!important;align-items:center;gap:9px;min-height:40px;padding:0 11px;border:1px solid #e0d3bf;border-radius:9px;background:#f8f2e7;font-size:13px!important;font-weight:600!important;color:#635544!important;cursor:pointer}
.friend-checkbox input{width:17px!important;height:17px!important;padding:0;accent-color:var(--club-red)}
.friend-primary-action{width:100%;min-height:46px;margin-top:auto;border-radius:var(--club-radius);font-size:14px;font-weight:600;letter-spacing:.08em;box-shadow:0 7px 15px #8e3d301c}
.friend-primary-action:hover:not(:disabled){background:var(--club-red-dark);box-shadow:0 9px 19px #8e3d3027;transform:translateY(-1px)}
.friend-primary-action:active:not(:disabled){transform:translateY(0);box-shadow:0 4px 10px #8e3d301a}
.friend-primary-action:disabled,.friend-secondary-action:disabled{box-shadow:none;transform:none}
.friend-secondary-action{min-height:46px;padding:0 19px;border-color:#cdbb9f;border-radius:var(--club-radius);background:#fffaf0;color:#705b3c;font-size:13px;font-weight:600;transition:background .16s ease,border-color .16s ease,transform .16s ease,box-shadow .16s ease}
.friend-secondary-action:hover:not(:disabled){border-color:#b79d70;background:#f6eddc;transform:translateY(-1px)}
.friend-secondary-action:active:not(:disabled){transform:translateY(0)}
.friend-primary-action:focus-visible,.friend-secondary-action:focus-visible,.friend-checkbox input:focus-visible,.friend-task-card input:focus-visible{outline:2px solid #8c6d37;outline-offset:2px}
.friend-join-card .friend-task-fields{margin-bottom:1px}
.friend-join-hint{margin:0;font-size:12px;line-height:1.7;color:#877863}
.friend-task-card .lobby-join-actions{grid-template-columns:minmax(0,1fr) auto;gap:10px;margin-top:auto;padding-top:2px}
.friend-flow-note{position:relative;margin-top:24px;padding:24px 4px 4px;border:0;border-top:1px solid var(--club-line);border-bottom:1px solid var(--club-line);border-radius:0;background:transparent}
.friend-flow-note h2{font:700 19px/1.3 "Songti SC","SimSun",serif;color:var(--club-ink);margin:0 0 16px}
.friend-flow-note ol{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:0;margin:0;list-style:none}
.friend-flow-note li{display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;align-items:start;padding:12px 0;border-top:1px solid #e1d6c5;color:#746552}
.friend-flow-note li>span{display:grid;place-items:center;width:26px;height:26px;border:1px solid #c4a66f;border-radius:50%;color:#916d36;font:700 12px/1 "STKaiti","KaiTi",serif}
.friend-flow-note li>p{margin:0;font-size:12px;line-height:1.75}

.lobby-seat-dialog{width:min(620px,calc(100vw - 32px));max-height:calc(100dvh - 24px);padding:0;border-color:#d4c3a8;border-radius:18px;background:linear-gradient(155deg,#fffef9,#fbf6ec);box-shadow:0 28px 100px #2e24183d;overflow:auto}
.lobby-seat-dialog::before{content:"";display:block;height:5px;background:linear-gradient(90deg,var(--club-red),#c48f54 52%,transparent)}
.lobby-seat-dialog form{display:grid;gap:20px;padding:27px 30px 28px}
.seat-dialog-heading{align-items:flex-start;margin:0}
.seat-dialog-heading>div{display:grid;gap:5px}
.seat-dialog-heading>div>span{font-size:10px;font-weight:700;letter-spacing:.18em;color:#a07b43}
.seat-dialog-heading h2{font:700 27px/1.15 "Songti SC","SimSun",serif;color:var(--club-ink);letter-spacing:.02em}
.seat-dialog-heading .dialog-close{display:grid;place-items:center;width:34px;height:34px;padding:0;border:1px solid transparent;border-radius:50%;color:#8f806c;font-size:24px;line-height:1;transition:background .15s ease,color .15s ease,border-color .15s ease}
.seat-dialog-heading .dialog-close:hover{background:#f4ebdc;border-color:#dbc9ae;color:#594a39}
.seat-dialog-heading .dialog-close:focus-visible{outline:2px solid #8c6d37;outline-offset:2px}
.seat-dialog-section{display:grid;gap:10px;padding-top:17px;border-top:1px solid var(--club-line)}
.seat-section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.seat-section-heading strong{font-size:13px;color:#5e5141;letter-spacing:.04em}
.seat-section-heading span{font-size:11px;color:#91816c}
.lobby-seat-factions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.lobby-seat-factions button{--faction:#a64b3c;--faction-soft:#faeee9;position:relative;display:grid;grid-template-columns:45px minmax(0,1fr);grid-template-rows:auto auto;align-items:center;gap:1px 10px;min-height:82px;padding:11px 10px;border:1px solid #d9cbb7;border-radius:11px;background:#fffdf8;color:#675b4c;text-align:left;transition:border-color .16s ease,background .16s ease,box-shadow .16s ease,transform .16s ease}
.lobby-seat-factions button.wei{--faction:#aa4b3d;--faction-soft:#faeee9}
.lobby-seat-factions button.shu{--faction:#343d47;--faction-soft:#eef0f1}
.lobby-seat-factions button.wu{--faction:#2d7757;--faction-soft:#edf5ef}
.lobby-seat-factions button:hover:not(:disabled):not(.selected){border-color:var(--faction);background:var(--faction-soft);transform:translateY(-1px)}
.lobby-seat-factions button.selected{border-color:var(--faction);background:var(--faction-soft);box-shadow:inset 0 0 0 1px var(--faction),0 5px 13px #5943230d}
.lobby-seat-factions button:disabled{opacity:1;border-style:dashed;background:#f2eee7;color:#81776a}
.lobby-seat-factions button:focus-visible{outline:2px solid var(--faction);outline-offset:2px}
.seat-faction-piece{grid-row:1 / span 2;display:grid;place-items:center;width:42px;height:42px;border:1px solid var(--faction);border-radius:50%;background:#fffdf8;color:var(--faction);font:700 23px/1 "STKaiti","KaiTi",serif;box-shadow:inset 0 0 0 3px #fff8e8}
.lobby-seat-factions button.selected .seat-faction-piece{background:var(--faction);color:#fff8e9;box-shadow:inset 0 0 0 2px #fff4df4d}
.lobby-seat-factions button:disabled .seat-faction-piece{filter:grayscale(.45);opacity:.55}
.seat-faction-copy{display:grid;min-width:0;align-self:end}
.seat-faction-copy strong{font:700 14px/1.25 "Songti SC","SimSun",serif;color:#4c4135;white-space:nowrap}
.seat-faction-copy small{font-size:10px;color:#8a7a67}
.seat-faction-state{justify-self:end;align-self:start;padding:2px 6px;border-radius:999px;background:#f1e9de;color:#7f7161;font-size:9px;font-weight:700;white-space:nowrap}
.lobby-seat-factions button.selected .seat-faction-state{background:var(--faction);color:#fff9ea}
.lobby-seat-factions button:disabled .seat-faction-state{background:#e4ddd2;color:#776b5e}
.seat-dialog-fields{display:grid;grid-template-columns:1fr;gap:12px}
.seat-dialog-fields.is-create{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.seat-dialog-fields label{display:grid;gap:7px;font-size:13px;font-weight:600;color:#625444}
.seat-dialog-fields input{width:100%;height:46px;min-width:0;border:1px solid var(--club-line);border-radius:var(--club-radius);background:#fffefb;padding:0 13px;outline:none;color:var(--club-ink);font-family:inherit;font-size:15px;font-weight:500;line-height:1.2;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
.seat-dialog-fields input[inputmode="numeric"]{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:16px;letter-spacing:.12em;font-variant-numeric:tabular-nums}
.seat-dialog-fields input::placeholder{color:#94846f;font-weight:500;opacity:1}
.seat-dialog-fields input:focus{border-color:var(--club-line-strong);box-shadow:0 0 0 3px #a7814718}
.seat-dialog-fields input.is-invalid{border-color:var(--club-danger);background:#fff9f7;box-shadow:0 0 0 3px #a3443814}
.seat-dialog-error{margin:0;padding:9px 11px;border-left:3px solid var(--club-danger);border-radius:0 7px 7px 0;background:#f9ece7;color:#8f4237;font-size:12px!important;line-height:1.6}
.seat-dialog-actions{display:grid;grid-template-columns:auto minmax(140px,1fr);align-items:center;gap:10px;padding-top:17px;border-top:1px solid var(--club-line)}
.seat-dialog-actions button{height:44px;border-radius:var(--club-radius);font-size:13px;font-weight:600}
.seat-cancel{border-color:#d1c1aa!important;background:transparent!important;color:#796a58!important}
.seat-cancel:hover:not(:disabled){background:#f3eadc!important;border-color:#bda77f!important}
.seat-dialog-actions .primary-button{transition:background .16s ease,transform .16s ease,box-shadow .16s ease}
.seat-dialog-actions .primary-button:hover:not(:disabled){background:var(--club-red-dark);transform:translateY(-1px);box-shadow:0 7px 14px #8e3d301c}
.seat-dialog-actions .primary-button:active:not(:disabled){transform:translateY(0)}
.friend-task-card button:disabled,.lobby-seat-dialog button:disabled{cursor:not-allowed}
@media(max-width:900px){
  .friend-task-card{min-height:0}
}
@media(max-width:720px){
  .friend-lobby-page .lobby-page-nav{margin-bottom:18px;gap:12px}
  .friend-page-heading{min-height:0;margin:2px 0 18px;gap:11px}
  .friend-page-heading h1{font-size:34px;letter-spacing:3px}
  .friend-page-seal{width:40px;height:45px;font-size:23px}
  .friend-lobby-page .lobby-entry-grid{gap:14px}
  .friend-task-card{padding:21px 18px 19px;border-radius:14px;gap:15px}
  .friend-task-heading{padding-bottom:13px}
  .friend-task-heading h2{font-size:25px}
  .friend-task-card input,.friend-primary-action,.friend-secondary-action{height:48px}
  .friend-task-card .lobby-join-actions{grid-template-columns:minmax(0,1fr) auto;gap:8px}
  .friend-secondary-action{padding:0 15px}
  .friend-flow-note{padding:20px 2px 2px}
  .friend-flow-note ol{grid-template-columns:1fr;gap:0}
  .friend-flow-note li{padding:10px 0}
  .lobby-seat-dialog{width:calc(100vw - 24px);max-height:calc(100dvh - 16px);border-radius:14px}
  .lobby-seat-dialog form{gap:16px;padding:21px 18px 20px}
  .seat-dialog-heading h2{font-size:23px}
  .lobby-seat-factions{grid-template-columns:1fr;gap:7px}
  .lobby-seat-factions button{min-height:62px;grid-template-columns:42px minmax(0,1fr) auto;grid-template-rows:1fr;padding:9px 10px}
  .seat-faction-piece{grid-row:1;width:38px;height:38px;font-size:21px}
  .seat-faction-copy{align-self:center;gap:2px}
  .seat-faction-state{justify-self:end;align-self:center}
  .seat-dialog-fields,.seat-dialog-fields.is-create{grid-template-columns:1fr}
  .seat-dialog-actions{grid-template-columns:1fr 1fr}
  .seat-dialog-actions button{width:100%}
}
</style>
