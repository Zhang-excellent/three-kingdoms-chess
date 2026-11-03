<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRaw, watch } from 'vue';
import { ORDER, PLAYERS, RULES_VERSION, at, legalMoves, newGame, pieceName, playMove, validGame } from './game.ts';
import type { Faction, Game, MoveRecord, Piece, Point } from './game.ts';
import { screenPoint } from './board-view.ts';
import { useOnlineRoom } from './useOnlineRoom.ts';
import { AUDIO_SETTINGS_KEY, GameAudio, MoveSoundTracker, loadAudioSettings } from './audio.ts';
import { MUSIC_PLAYLISTS, musicTrack, tracksInPlaylist } from './music-catalog.ts';
import { buildGameRecord, gameRecordFileName } from './game-record.ts';
import { parseGameRecord } from './game-replay.ts';
import type { ReplayDocument } from './game-replay.ts';
import { appRouteUrl, parseAppRoute } from './navigation.ts';
import type { AppPage } from './navigation.ts';
import HomePage from './components/HomePage.vue';
import LobbyPage from './components/LobbyPage.vue';
import InvitePage from './components/InvitePage.vue';
import RoomWaiting from './components/RoomWaiting.vue';

const storageKey = 'three-kingdoms-chess:win-loss-v1';
const legacyStorageKeys = ['three-kingdoms-chess:independent-v1', 'three-kingdoms-chess:turn-cycle-v1', 'three-kingdoms-chess:capture-v0.1'];
let restored: { game: Game; undo: Game[] } = { game: newGame(), undo: [] };
let initialMessage = '请选择一枚魏方棋子，曹操先行。';
let requiresNewGame = false;
let storageUsable = true;
try {
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    try {
      const value = JSON.parse(raw);
      const validUndo = Array.isArray(value?.undo) && value.undo.every(validGame);
      if (value?.rulesVersion === RULES_VERSION && validGame(value.game) && validUndo) {
        restored = { game: value.game, undo: value.undo.slice(-50) };
        initialMessage = '';
      } else requiresNewGame = true;
    } catch { requiresNewGame = true; }
    if (requiresNewGame) initialMessage = '检测到无法无歧义恢复的存档，原数据已保留，请按新规则另开一局。';
  } else if (legacyStorageKeys.some(key => localStorage.getItem(key))) {
    requiresNewGame = true;
    initialMessage = '检测到旧规则、初始布局或名次存档，原数据已保留，请按当前规则另开一局。';
  }
} catch { storageUsable = false; }
const localGame = ref<Game>(restored.game), undo = ref<Game[]>(restored.undo);
const selectedId = ref<string | null>(null), message = ref(initialMessage), feedbackError = ref(false);
const localPanel = ref<'play' | 'replay'>('play');
const replayDocument = ref<ReplayDocument | null>(null);
const replayIndex = ref(0), replayFileName = ref(''), replayImportError = ref('');
const replayDragActive = ref(false), replayPlaying = ref(false);
const replaySpeed = ref<'slow' | 'normal' | 'fast'>('normal');
const replayFileInput = ref<HTMLInputElement | null>(null);
let replayTimer: number | null = null;
const rulesDialog = ref<HTMLDialogElement | null>(null), resetDialog = ref<HTMLDialogElement | null>(null);
const resignDialog = ref<HTMLDialogElement | null>(null), exitDialog = ref<HTMLDialogElement | null>(null);
const settingsDialog = ref<HTMLDialogElement | null>(null);
const inviteDialog = ref<HTMLDialogElement | null>(null), inviteLinkInput = ref<HTMLTextAreaElement | null>(null);
const inviteLink = ref(''), inviteCopyResult = ref<'copied' | 'manual' | 'no-room'>('manual');
const pendingRoomNavigation = ref<{ next: AppPage; code: string | null; method: 'push' | 'replace' | 'none'; href?: string } | null>(null);
const leavingRoom = ref(false), inviteActionError = ref('');
const audioSettings = ref(loadAudioSettings()), audioMessage = ref('');
const availableTracks = computed(() => tracksInPlaylist(audioSettings.value.musicPlaylistId));
const selectedTrackName = computed(() => musicTrack(audioSettings.value.musicTrackId)?.name ?? '暂无歌曲');
const gameAudio = new GameAudio(), moveSoundTracker = new MoveSoundTracker();
let musicUiRequest = 0;
async function playSelectedMusic(choose = false) {
  const request = ++musicUiRequest;
  const problem = choose ? await gameAudio.chooseMusic(audioSettings.value) : await gameAudio.setMusic(audioSettings.value, true);
  if (request === musicUiRequest) audioMessage.value = problem ?? '';
}
const resumeRememberedMusic = () => {
  if (audioSettings.value.musicEnabled)
    void playSelectedMusic();
};
onMounted(() => {
  if (audioSettings.value.musicEnabled) document.addEventListener('pointerdown', resumeRememberedMusic, { once: true });
  window.addEventListener('popstate', syncPageFromLocation);
  void activatePage(initialRoute.page, initialRoute.roomCode, true);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', resumeRememberedMusic);
  window.removeEventListener('popstate', syncPageFromLocation);
  stopReplayPlayback();
  gameAudio.dispose();
});
const saveAvailable = ref(storageUsable), compatibilityWarning = ref(requiresNewGame);
const online = useOnlineRoom();
const initialRoute = parseAppRoute(location.href), page = ref<AppPage>(initialRoute.page);
const requestedRoomCode = ref(initialRoute.roomCode), lobbyListed = ref(true);
const { mode, nickname, createCode, joinCode, room, self, connection, error: onlineError, busy: onlineBusy,
  spectating, watchCode, watchingCode, hasSession, savedRoomCode, lobbyRooms, lobbyLoaded,
  inviteRoom, inviteLookup, inviteLookupError, inviteUrl } = online;
const fallbackGame = newGame();
const liveGame = computed(() => online.mode.value === 'online' ? (online.room.value?.game ?? fallbackGame) : localGame.value);
const isReplaying = computed(() => online.mode.value === 'local' && localPanel.value === 'replay' && !!replayDocument.value);
const replayFrame = computed(() => replayDocument.value?.frames[replayIndex.value] ?? null);
const game = computed(() => isReplaying.value && replayFrame.value ? replayFrame.value : liveGame.value);
const previousGame = computed(() => online.room.value?.phase === 'lobby' && online.room.value.game?.status === 'finished' ? online.room.value.game : null);
const showGame = computed(() => (page.value === 'room' && !!room.value && room.value.phase !== 'lobby')
  || (page.value === 'spectate' && !!room.value && room.value.phase !== 'lobby')
  || page.value === 'local');
const roomRouteMismatch = computed(() => page.value === 'room' && !!requestedRoomCode.value
  && !!room.value && room.value.code !== requestedRoomCode.value);
const showLobbyPage = computed(() => page.value === 'lobby' || page.value === 'friends');
const showInvitePage = computed(() => page.value === 'room' && !!requestedRoomCode.value
  && (roomRouteMismatch.value || (!room.value && !hasSession.value)));
const rematchBusy = ref(false);
const ownFaction = computed(() => online.mode.value === 'online' ? online.faction.value : null);
const flipOverride = ref(false);
const flipped = computed(() => (ownFaction.value === 'shu' || ownFaction.value === 'wu') !== flipOverride.value);
watch([ownFaction, mode], () => { flipOverride.value = false; });
const roomPlayer = (faction: Faction) => online.room.value?.players.find(player => player.faction === faction);
const playerDisplayName = (faction: Faction) => mode.value === 'online'
  ? roomPlayer(faction)?.nickname || PLAYERS[faction].name
  : PLAYERS[faction].name;
const activePlayerName = computed(() => game.value.turn ? playerDisplayName(game.value.turn) : '');
const winnerDisplayName = computed(() => game.value.winner ? playerDisplayName(game.value.winner) : '');
type PlayerStatusTone = 'active' | 'offline' | 'result' | 'out';
function playerStatuses(faction: Faction): Array<{ label: string; tone: PlayerStatusTone }> {
  const statuses: Array<{ label: string; tone: PlayerStatusTone }> = [];
  const player = mode.value === 'online' ? roomPlayer(faction) : undefined;
  if (player && !player.online) statuses.push({ label: '离线', tone: 'offline' });
  if (game.value.eliminated.includes(faction)) statuses.push({ label: '已出局', tone: 'out' });
  else if (game.value.status === 'finished') {
    const result = game.value.results[faction];
    if (result !== 'playing') statuses.push({ label: result === 'won' ? '胜利' : result === 'draw' ? '和棋' : '失败', tone: 'result' });
  } else if (isReplaying.value && replayCurrentStep.value?.faction === faction) statuses.push({ label: '本步', tone: 'active' });
  else if (!isReplaying.value && game.value.turn === faction) statuses.push({ label: '行棋中', tone: 'active' });
  return statuses;
}
const factionTaken = (faction: Faction) => !!online.room.value?.players.some(player => player.id !== online.room.value?.selfId && player.faction === faction);
const drawOffer = computed(() => online.mode.value === 'online' ? online.room.value?.drawOffer ?? null : null);
const canOfferDraw = computed(() => !spectating.value && !!ownFaction.value && game.value.status === 'playing'
  && game.value.turn === ownFaction.value && !game.value.eliminated.includes(ownFaction.value) && !drawOffer.value);
const canRespondDraw = computed(() => !!drawOffer.value && !!ownFaction.value && ownFaction.value !== drawOffer.value.proposer
  && drawOffer.value.eligible.includes(ownFaction.value) && !drawOffer.value.votes[ownFaction.value]);
const ownDrawVote = computed(() => ownFaction.value && drawOffer.value ? drawOffer.value.votes[ownFaction.value] : undefined);
const drawAcceptedCount = computed(() => drawOffer.value?.eligible.filter(faction => drawOffer.value?.votes[faction] === 'accept').length ?? 0);
const drawEligibleNames = computed(() => drawOffer.value?.eligible.map(faction => playerDisplayName(faction)).join('、') ?? '');
const selected = computed(() => game.value.pieces.find(p => p.id === selectedId.value) ?? null);
const moves = computed(() => selected.value ? legalMoves(game.value.pieces, selected.value) : []);
const active = computed(() => game.value.turn ? PLAYERS[game.value.turn] : null);
const highlightedFaction = computed<Faction | null>(() => isReplaying.value
  ? replayCurrentStep.value?.faction ?? null
  : game.value.status === 'playing' ? game.value.turn : null);
const latest = computed(() => game.value.lastMove);
const records = computed(() => game.value.history.slice(-20).reverse());
const replayCurrentStep = computed(() => replayDocument.value && replayIndex.value > 0
  ? replayDocument.value.moves[replayIndex.value - 1] ?? null : null);
const replayTotal = computed(() => replayDocument.value?.moves.length ?? 0);
const replayCanGoBack = computed(() => isReplaying.value && replayIndex.value > 0);
const replayCanGoForward = computed(() => isReplaying.value && replayIndex.value < replayTotal.value);
const resultLabel = (current: Game, faction: Faction) => current.results[faction] === 'won' ? '胜利'
  : current.results[faction] === 'lost' ? '失败' : current.results[faction] === 'draw' ? '和棋' : '对局中';
const losersText = computed(() => ORDER.filter(faction => game.value.results[faction] === 'lost').map(faction => playerDisplayName(faction)).join('、'));
const drawingText = computed(() => ORDER.filter(faction => game.value.results[faction] === 'draw').map(faction => playerDisplayName(faction)).join('、'));
const px = (x: number) => 50 + x * 55;
const py = (y: number) => 50 + y * 55;
const viewX = (x: number) => px(flipped.value ? 8 - x : x);
const viewY = (y: number) => py(flipped.value ? 9 - y : y);
const coordinate = (p: Point) => `(${p.x + 1}, ${p.y + 1})`;
const count = (faction: Faction) => game.value.pieces.filter(p => p.faction === faction).length;
const description = (record: MoveRecord) => `${pieceName(record)} ${coordinate(record.from)} → ${coordinate(record.to)}`;
const eliminatedNames = (record: MoveRecord) => record.eliminated.map(f => PLAYERS[f].name).join('、');
const capturedAt = (point: Point) => !!at(game.value.pieces, point);
const currentRoomPhase = computed(() => room.value?.phase ?? null);
const resumeRoomLabel = computed(() => currentRoomPhase.value === 'lobby' ? '返回等待区' : '返回对局');
const lobbyPageMode = computed<'public' | 'friends'>(() => page.value === 'lobby' ? 'public' : 'friends');

function historyFor(next: AppPage, code: string | null, method: 'push' | 'replace' | 'none') {
  if (method === 'none') return;
  const href = appRouteUrl(location.href, next, code);
  if (method === 'replace') history.replaceState({ page: next }, '', href);
  else history.pushState({ page: next }, '', href);
}

function leavesRoom(next: AppPage, code: string | null): boolean {
  if (hasSession.value)
    return next !== 'room' || code !== (room.value?.code ?? savedRoomCode.value);
  if (page.value === 'spectate' && spectating.value)
    return next !== 'spectate' || code !== watchingCode.value;
  return false;
}

const needsPlayingExitConfirmation = () => hasSession.value && room.value?.phase === 'playing'
  && !!ownFaction.value && !game.value.eliminated.includes(ownFaction.value);

async function applyNavigation(target: NonNullable<typeof pendingRoomNavigation.value>): Promise<void> {
  page.value = target.next;
  requestedRoomCode.value = target.code;
  selectedId.value = null;
  if (target.href) history.replaceState({ page: target.next }, '', target.href);
  else historyFor(target.next, target.code, target.method);
  await activatePage(target.next, target.code);
}

async function completeRoomDeparture(): Promise<void> {
  const target = pendingRoomNavigation.value;
  if (!target || leavingRoom.value) return;
  leavingRoom.value = true;
  try {
    if (page.value === 'spectate' && spectating.value) {
      online.exitWatching();
    } else if (hasSession.value) {
      const ack = await online.leaveRoom();
      if (!ack.ok) {
        onlineError.value = ack.error;
        pendingRoomNavigation.value = null;
        return;
      }
    }
    pendingRoomNavigation.value = null;
    leavingRoom.value = false;
    await applyNavigation(target);
  } finally {
    leavingRoom.value = false;
  }
}

async function activatePage(next: AppPage, code: string | null, initial = false) {
  if (next !== 'spectate' && spectating.value) online.exitWatching();
  if (next === 'spectate') {
    if (!spectating.value) online.openWatchEntry();
    if (code && !initial && (!spectating.value || watchingCode.value !== code)) {
      watchCode.value = code;
      await online.startWatching();
    }
    return;
  }
  if (next === 'local') {
    void online.unsubscribeLobby();
    online.useLocal();
    return;
  }
  if (next === 'home') {
    void online.unsubscribeLobby();
    return;
  }
  if (next === 'lobby') {
    online.connect();
    const ack = await online.subscribeLobby();
    if (!ack.ok) onlineError.value = ack.error;
    return;
  }
  void online.unsubscribeLobby();
  online.connect();
  if (next === 'room' && code) joinCode.value = code;
}

async function navigatePage(next: AppPage, code: string | null = null, method: 'push' | 'replace' = 'push') {
  if (leavingRoom.value) return;
  if (leavesRoom(next, code)) {
    pendingRoomNavigation.value = { next, code, method };
    if (needsPlayingExitConfirmation()) exitDialog.value?.showModal();
    else await completeRoomDeparture();
    return;
  }
  await applyNavigation({ next, code, method });
}

function openHomePage() { void navigatePage('home'); }
function openLobbyPage() { void navigatePage('lobby'); }
function openFriendsPage() { void navigatePage('friends'); }
function openSpectateEntry() { void navigatePage('spectate', null, 'replace'); }
function openLocalPage() { void navigatePage('local'); }
function openCurrentRoom() {
  const code = room.value?.code ?? savedRoomCode.value;
  void navigatePage('room', code, 'replace');
}

async function syncPageFromLocation() {
  const route = parseAppRoute(location.href);
  if (leavesRoom(route.page, route.roomCode)) {
    const targetHref = location.href;
    const currentHref = page.value === 'room'
      ? appRouteUrl(location.href, 'room', room.value?.code ?? savedRoomCode.value)
      : appRouteUrl(location.href, 'spectate', watchingCode.value);
    history.replaceState({ page: page.value }, '', currentHref);
    pendingRoomNavigation.value = { next: route.page, code: route.roomCode, method: 'replace', href: targetHref };
    if (needsPlayingExitConfirmation()) exitDialog.value?.showModal();
    else await completeRoomDeparture();
    return;
  }
  await applyNavigation({ next: route.page, code: route.roomCode, method: 'none' });
}

watch([localGame, undo], () => {
  if (compatibilityWarning.value) return;
  try { localStorage.setItem(storageKey, JSON.stringify({ rulesVersion: RULES_VERSION, game: localGame.value, undo: undo.value.slice(-50) })); saveAvailable.value = true; }
  catch { saveAvailable.value = false; }
}, { deep: true });

watch(audioSettings, value => {
  try { localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(value)); } catch { /* Sound settings are optional. */ }
  gameAudio.setMusicVolume(value.musicVolume);
  if (!value.musicEnabled) void gameAudio.setMusic(value);
}, { deep: true });

watch([game, mode, room, connection], () => {
  if (isReplaying.value) return;
  const live = mode.value === 'local' || (connection.value === 'online' && !!room.value && room.value.phase !== 'lobby');
  const scope = mode.value === 'local' ? 'local' : `${room.value?.code ?? ''}:${room.value?.round ?? ''}`;
  const effect = moveSoundTracker.observe(game.value, scope, live);
  if (effect) gameAudio.playEffect(effect, audioSettings.value);
}, { immediate: true, flush: 'sync' });

watch(() => online.room.value?.version, () => {
  if (online.mode.value !== 'online') return;
  selectedId.value = null;
  feedbackError.value = false;
});
watch(() => online.room.value?.drawOffer, (offer, previous) => {
  if (previous && !offer && online.room.value?.phase === 'playing') notify('和棋申请未通过，对局继续。');
});
watch([page, requestedRoomCode, hasSession, room], ([currentPage, code, hasRoomSession, currentRoom]) => {
  if (currentPage === 'room' && code && !hasRoomSession && !currentRoom && !spectating.value)
    void online.inspectInvite(code);
}, { immediate: true });
watch(page, current => { if (current !== 'local') stopReplayPlayback(); });
watch(localPanel, current => { if (current !== 'replay') stopReplayPlayback(); });

function notify(text: string, error = false) { message.value = text; feedbackError.value = error; }
function stopReplayPlayback() {
  if (replayTimer !== null) window.clearInterval(replayTimer);
  replayTimer = null; replayPlaying.value = false;
}
function switchLocalPanel(panel: 'play' | 'replay') {
  if (localPanel.value === panel) return;
  stopReplayPlayback(); selectedId.value = null;
  localPanel.value = panel;
  replayImportError.value = '';
}
function jumpReplay(index: number) {
  if (!replayDocument.value) return;
  stopReplayPlayback();
  replayIndex.value = Math.max(0, Math.min(index, replayDocument.value.moves.length));
  selectedId.value = null; feedbackError.value = false;
}
function startReplayPlayback() {
  if (!replayDocument.value || replayPlaying.value) return;
  if (replayIndex.value >= replayDocument.value.moves.length) jumpReplay(0);
  replayPlaying.value = true;
  const delay = replaySpeed.value === 'slow' ? 1400 : replaySpeed.value === 'fast' ? 360 : 760;
  replayTimer = window.setInterval(() => {
    if (!replayDocument.value || replayIndex.value >= replayDocument.value.moves.length) {
      stopReplayPlayback(); return;
    }
    replayIndex.value++;
    selectedId.value = null;
  }, delay);
}
function toggleReplayPlayback() {
  if (replayPlaying.value) stopReplayPlayback();
  else startReplayPlayback();
}
function setReplaySpeed(speed: 'slow' | 'normal' | 'fast') {
  replaySpeed.value = speed;
  if (replayPlaying.value) {
    stopReplayPlayback();
    startReplayPlayback();
  }
}
async function importReplayFile(file: File) {
  replayImportError.value = '';
  if (!/\.md$/i.test(file.name)) {
    replayImportError.value = '请选择三国象棋导出的 .md 棋谱文件。';
    return;
  }
  if (file.size > 5_000_000) {
    replayImportError.value = '棋谱文件超过 5 MB，无法导入。';
    return;
  }
  try {
    const result = parseGameRecord(await file.text());
    if (!result.ok) {
      replayImportError.value = `导入失败：${result.error}`;
      return;
    }
    stopReplayPlayback();
    replayDocument.value = result.replay;
    replayIndex.value = 0;
    replayFileName.value = file.name;
    localPanel.value = 'replay';
    selectedId.value = null;
  } catch {
    replayImportError.value = '读取棋谱文件失败，请确认文件完整且可访问。';
  }
}
function chooseReplayFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  if (file) void importReplayFile(file);
  input.value = '';
}
function dropReplayFile(event: DragEvent) {
  replayDragActive.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) void importReplayFile(file);
}
async function toggleMusic() {
  audioSettings.value.musicEnabled = !audioSettings.value.musicEnabled;
  if (audioSettings.value.musicEnabled) await playSelectedMusic(true);
  else { musicUiRequest++; audioMessage.value = ''; await gameAudio.setMusic(audioSettings.value); }
}
function choosePlaylist(event: Event) {
  const playlistId = (event.target as HTMLSelectElement).value;
  const first = tracksInPlaylist(playlistId)[0];
  if (!first) return;
  audioSettings.value.musicPlaylistId = playlistId;
  audioSettings.value.musicTrackId = first.id;
  audioMessage.value = '';
  void playSelectedMusic(true);
}
function chooseTrack(event: Event) {
  const trackId = (event.target as HTMLSelectElement).value;
  if (!availableTracks.value.some(track => track.id === trackId)) return;
  audioSettings.value.musicTrackId = trackId;
  audioMessage.value = '';
  void playSelectedMusic(true);
}
async function previewSelectedMusic() {
  const request = ++musicUiRequest;
  const problem = await gameAudio.previewMusic(audioSettings.value);
  if (request === musicUiRequest) audioMessage.value = problem ?? '';
}
async function cellClick(x: number, y: number) {
  if (isReplaying.value) return;
  if (spectating.value) { notify('正在观战，不能操作棋子。', true); return; }
  if (drawOffer.value) { notify('请先处理和棋申请，再继续行棋。', true); return; }
  if (online.mode.value === 'local' && compatibilityWarning.value) { notify('旧规则存档不能按三方独立规则续局，请另开一局。', true); return; }
  if (game.value.status !== 'playing') { notify(online.mode.value === 'online' ? '本局已结束，可以点击“再来一局”。' : '本局已经结束，可以悔棋复盘或重新开局。'); return; }
  const piece = at(game.value.pieces, { x, y });
  if (piece?.faction === game.value.turn) {
    if (online.mode.value === 'online' && piece.faction !== ownFaction.value) { notify(`你控制的是${ownFaction.value ? PLAYERS[ownFaction.value].nation : '未选择'}方，不能操作其他阵营。`, true); return; }
    selectedId.value = selectedId.value === piece.id ? null : piece.id;
    notify(selectedId.value ? `已选中${pieceName(piece)}，圆点是可走位置，红圈表示可吃子。` : `轮到${active.value?.name}行棋。`);
    return;
  }
  if (!selected.value) { notify(`轮到${active.value?.name}，请先选择本方棋子。`, !!piece); return; }
  if (online.mode.value === 'online') {
    const result = await online.move(selected.value.id, { x, y });
    if (!result.ok) { notify(result.error, true); return; }
    selectedId.value = null; feedbackError.value = false; return;
  }
  const result = playMove(toRaw(localGame.value), selected.value.id, { x, y });
  if (!result.ok) { notify(result.error, true); return; }
  undo.value.push(structuredClone(toRaw(localGame.value)));
  if (undo.value.length > 50) undo.value.shift();
  localGame.value = result.game; selectedId.value = null;
  notify(result.notices.join(' '));
}
function boardInput(clientX: number, clientY: number, svg: SVGSVGElement) {
  if (!selected.value) return;
  const matrix = svg.getScreenCTM();
  if (!matrix) return;
  const p = svg.createSVGPoint(); p.x = clientX; p.y = clientY;
  const actual = p.matrixTransform(matrix.inverse());
  const point = screenPoint(actual.x, actual.y, flipped.value);
  if (point) void cellClick(point.x, point.y);
}
function boardClick(event: MouseEvent) { boardInput(event.clientX, event.clientY, event.currentTarget as SVGSVGElement); }
function boardTouch(event: TouchEvent) {
  const touch = event.changedTouches[0];
  if (!touch) return;
  event.preventDefault();
  const target = event.target instanceof Element ? event.target.closest<SVGGElement>('[data-board-x]') : null;
  if (target) { void cellClick(Number(target.dataset.boardX), Number(target.dataset.boardY)); return; }
  boardInput(touch.clientX, touch.clientY, event.currentTarget as SVGSVGElement);
}
function undoMove() {
  if (online.mode.value === 'online') { notify('联机模式禁用单方悔棋。', true); return; }
  const previous = undo.value.pop();
  if (!previous) return;
  localGame.value = previous; selectedId.value = null;
  notify(`已撤回一步，轮到${active.value?.name ?? '本局已结束'}。`);
}
function reset() {
  if (online.mode.value === 'online') { notify('联机模式不能由单方重新开局。', true); return; }
  compatibilityWarning.value = false;
  localGame.value = newGame(); undo.value = []; selectedId.value = null;
  notify('三方独立对弈，棋子已归位，曹操先行。'); resetDialog.value?.close();
}
function resetRequest() {
  if (game.value.history.length) resetDialog.value?.showModal(); else reset();
}
function pieceLabel(piece: Piece) { return `${PLAYERS[piece.faction].nation}方${pieceName(piece)}，第${piece.x + 1}路第${piece.y + 1}线`; }
function onEscape() { selectedId.value = null; notify(active.value ? `轮到${active.value.name}行棋。` : message.value); }
async function copyInvite() {
  const link = inviteUrl.value;
  inviteLink.value = link ?? '';
  if (!link) {
    inviteCopyResult.value = 'no-room';
    inviteDialog.value?.showModal();
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(link);
    inviteCopyResult.value = 'copied';
  } catch {
    inviteCopyResult.value = 'manual';
  }
  inviteDialog.value?.showModal();
}
function selectInviteLink() {
  inviteLinkInput.value?.focus();
  inviteLinkInput.value?.select();
}
async function createOnlineRoom() {
  await online.createRoom(lobbyListed.value);
  if (room.value) await navigatePage('room', room.value.code, 'replace');
}
async function claimTableSeat(roomCode: string, faction: Faction, guestName: string) {
  const result = await online.claimSeat(roomCode, faction, guestName, true);
  if (result.ok) await navigatePage('room', result.data.roomCode, 'replace');
}
async function createTableAt(faction: Faction, guestName: string, roomCode: string) {
  const result = await online.claimSeat(roomCode, faction, guestName, true);
  if (result.ok) await navigatePage('room', result.data.roomCode, 'replace');
}
async function joinOnlineRoom(code?: string) {
  await online.joinRoom(code);
  if (room.value) await navigatePage('room', room.value.code, 'replace');
}
async function joinInvitedRoom(faction: Faction, guestName: string) {
  if (!requestedRoomCode.value) return;
  inviteActionError.value = '';
  const result = await online.claimSeat(requestedRoomCode.value, faction, guestName, true);
  if (result.ok) {
    await navigatePage('room', result.data.roomCode, 'replace');
    return;
  }
  inviteActionError.value = result.error;
  await online.inspectInvite(requestedRoomCode.value);
}
function retryInvite() {
  if (requestedRoomCode.value) void online.inspectInvite(requestedRoomCode.value);
}
function watchInvitedRoom() {
  if (requestedRoomCode.value) void watchOnlineRoom(requestedRoomCode.value);
}
async function watchOnlineRoom(code?: string) {
  const roomCode = (code ?? watchCode.value).trim().toUpperCase();
  if (roomCode) watchCode.value = roomCode;
  await navigatePage('spectate', roomCode || null, 'replace');
}
function leaveRoomForLobby() {
  void navigatePage('lobby', null, 'replace');
}
function requestInviteExit() {
  const invitation = requestedRoomCode.value;
  if (!invitation) return;
  void navigatePage('room', invitation, 'replace');
}
function exportGameRecord(current: Game) {
  if (!current.history.length) return;
  try {
    const exportedAt = new Date(), filename = gameRecordFileName(exportedAt);
    const url = URL.createObjectURL(new Blob([buildGameRecord(current, exportedAt)], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.hidden = true;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    notify(`棋谱已导出：${filename}`);
  } catch { notify('浏览器无法导出棋谱。', true); }
}
function requestLeave() {
  void navigatePage('lobby', null, 'replace');
}
function confirmLeave() {
  exitDialog.value?.close();
  void completeRoomDeparture();
}
function cancelExitRequest() {
  pendingRoomNavigation.value = null;
  exitDialog.value?.close();
}
function exitWatchingToLobby() {
  void navigatePage('lobby', null, 'replace');
}
async function confirmResign() {
  resignDialog.value?.close();
  const result = await online.resign();
  notify(result.ok ? '已认输出局，可以留在房间查看后续对局。' : result.error, !result.ok);
}
async function requestDraw() {
  const result = await online.offerDraw();
  notify(result.ok ? '已提出和棋申请，请等待其他存活阵营回应。' : result.error, !result.ok);
}
async function respondToDraw(vote: 'accept' | 'reject') {
  const result = await online.respondDraw(vote);
  if (!result.ok) { notify(result.error, true); return; }
  if (vote === 'reject') notify('已拒绝和棋申请，对局继续。');
  else if (result.data.state.phase === 'finished') notify('全部存活阵营同意，本局和棋。');
  else notify('已同意和棋，等待其他阵营回应。');
}
async function releaseOffline(playerId: string) {
  const result = await online.releaseOffline(playerId);
  if (!result.ok) notify(result.error, true);
}
async function requestRematch() {
  if (rematchBusy.value || room.value?.phase !== 'finished') return;
  rematchBusy.value = true;
  try {
    const result = await online.rematch();
    if (!result.ok) notify(result.error, true);
  } finally { rematchBusy.value = false; }
}
</script>

<template>
  <div class="app-shell" :data-turn-slot="game.turnSlot ?? undefined" @keydown.esc="onEscape">
    <header class="site-header">
      <button class="brand brand-button" aria-label="返回游戏首页" @click="openHomePage">
        <span class="brand-seal" aria-hidden="true">弈</span><span><strong>三国象棋</strong><small>THREE KINGDOMS CHESS</small></span>
      </button>
      <div class="header-actions">
        <button class="plain-button" :class="{ active: page === 'home' }" @click="openHomePage">首页</button>
        <button class="plain-button" :class="{ active: page === 'lobby' }" @click="openLobbyPage">对战大厅</button>
        <button class="plain-button" :class="{ active: page === 'friends' }" @click="openFriendsPage">好友组局</button>
        <button class="plain-button" :class="{ active: page === 'spectate' }" @click="openSpectateEntry">观战</button>
        <button v-if="hasSession && page !== 'room'" class="plain-button room-return-button" @click="openCurrentRoom">{{ resumeRoomLabel }}</button>
        <button class="plain-button" @click="settingsDialog?.showModal()">设置</button>
        <button class="plain-button" @click="rulesDialog?.showModal()">玩法说明</button>
      </div>
    </header>
    <p v-if="onlineError && page === 'home'" class="app-notice error" role="alert">{{ onlineError }}</p>

    <HomePage v-if="page === 'home'" :has-room="hasSession" :room-code="room?.code ?? savedRoomCode" :room-phase="currentRoomPhase"
      @lobby="openLobbyPage" @friends="openFriendsPage" @local="openLocalPage" @resume="openCurrentRoom" />

    <LobbyPage v-else-if="showLobbyPage" :mode="lobbyPageMode" :rooms="lobbyRooms" :nickname="nickname"
      :create-code="createCode" :join-code="joinCode" :listed="lobbyListed" :busy="onlineBusy" :connection="connection"
      :error="onlineError || (roomRouteMismatch ? `你仍在房间 ${room?.code}。请先返回原房间并退出，再加入 ${requestedRoomCode}。` : '')"
      :loaded="lobbyLoaded" :has-room="hasSession"
      :current-room-code="room?.code ?? savedRoomCode" :current-room-phase="currentRoomPhase"
      @home="openHomePage" @switch-public="openLobbyPage" @switch-friends="openFriendsPage" @resume="openCurrentRoom"
      @create="createOnlineRoom" @create-table="createTableAt" @join="joinOnlineRoom" @join-seat="claimTableSeat" @watch="watchOnlineRoom"
      @update-nickname="nickname = $event" @update-create-code="createCode = $event"
      @update-join-code="joinCode = $event" @update-listed="lobbyListed = $event" />

    <InvitePage v-else-if="showInvitePage && requestedRoomCode" :room-code="requestedRoomCode"
      :room="inviteRoom" :lookup="inviteLookup" :error="inviteActionError || inviteLookupError || onlineError"
      :connection="connection" :busy="onlineBusy"
      :existing-room-code="roomRouteMismatch ? (room?.code ?? savedRoomCode) : null"
      @join="joinInvitedRoom" @watch="watchInvitedRoom" @retry="retryInvite" @lobby="openLobbyPage"
      @return-room="openCurrentRoom" @exit-room="requestInviteExit" />

    <main v-else-if="page === 'spectate' && (!room || room.phase === 'lobby')" class="online-shell">
      <section class="online-entry watch-entry">
        <h2>{{ room ? `正在观战 · 房间 ${room.code}` : '输入房间号观战' }}</h2>
        <p v-if="room">{{ room.phase === 'lobby' ? '等待玩家准备' : '棋局正在进行' }}</p>
        <div v-if="room" class="lobby-players"><article v-for="player in room.players" :key="player.id"><span class="online-dot" :class="{off: !player.online}"></span><div><strong>{{ player.nickname }}</strong><small>{{ player.online ? '在线' : '离线' }}</small></div><b>{{ player.faction ? PLAYERS[player.faction].nation + '方' : '未选阵营' }}</b><em>{{ player.ready ? '已准备' : '未准备' }}</em></article></div>
        <div v-if="room" class="room-heading-actions"><button class="tool-button" @click="exitWatchingToLobby">退出观战</button><button class="tool-button" @click="exitWatchingToLobby">更换房间</button></div>
        <form v-else class="join-row watch-join" @submit.prevent="watchOnlineRoom()"><input v-model="watchCode" maxlength="6" inputmode="numeric" autocomplete="off" aria-label="观战房间号" placeholder="输入 6 位房间号" @input="watchCode = watchCode.toUpperCase()"><button class="primary-button" type="button" :disabled="onlineBusy || connection !== 'online'" @click="watchOnlineRoom()">进入观战</button></form>
        <button v-if="!room" class="tool-button" @click="openLobbyPage">返回联机大厅</button>
        <p v-if="connection !== 'online' || onlineError" class="connection-note" :class="{error: onlineError}">{{ onlineError || '连接中断，正在重连…' }}</p>
        <div v-if="previousGame" class="previous-game"><div class="previous-game-heading"><strong>上一局结果</strong><button class="record-export-button" @click="exportGameRecord(previousGame)">导出棋谱</button></div><p v-for="faction in ORDER" :key="faction">{{ PLAYERS[faction].name }} · {{ resultLabel(previousGame, faction) }}</p><details><summary>查看上一局棋谱（{{ previousGame.history.length }} 步）</summary><ol><li v-for="record in previousGame.history" :key="record.number">{{ record.number }}. {{ PLAYERS[record.faction].name }} · {{ description(record) }}</li></ol></details></div>
      </section>
    </main>

    <main v-else-if="page === 'room' && !room" class="online-shell">
      <section class="online-entry room-recovery">
        <span class="eyebrow">房间</span><h2>正在恢复房间状态</h2>
        <p>{{ hasSession ? '正在使用本机保存的重连凭证恢复席位。' : '请先输入昵称加入这个房间。' }}</p>
        <p v-if="onlineError" class="connection-note error" role="status">{{ onlineError }}</p>
        <div class="entry-actions"><button class="primary-button" @click="openCurrentRoom" :disabled="!hasSession">重试恢复</button><button class="tool-button" @click="openLobbyPage">返回大厅</button></div>
      </section>
    </main>

    <main v-else-if="page === 'room' && room?.phase === 'lobby'" class="online-shell">
      <RoomWaiting v-if="room" :room="room" :connection="connection" :error="onlineError"
        @copy-invite="copyInvite" @leave="requestLeave" @choose-faction="online.chooseFaction"
        @ready="online.setReady" @release-offline="releaseOffline" @export-record="exportGameRecord" />
    </main>

    <template v-else-if="showGame">
      <section v-if="mode === 'local'" class="local-workbench" :class="{ 'drag-active': replayDragActive }"
        @dragenter.prevent="replayDragActive = true" @dragover.prevent="replayDragActive = true"
        @dragleave.prevent="replayDragActive = false" @drop.prevent="dropReplayFile">
        <div class="local-view-tabs" role="tablist" aria-label="本地试玩模式">
          <button :class="{ active: localPanel === 'play' }" :aria-selected="localPanel === 'play'" @click="switchLocalPanel('play')">自由试玩 / 录谱</button>
          <button :class="{ active: localPanel === 'replay' }" :aria-selected="localPanel === 'replay'" @click="switchLocalPanel('replay')">棋谱复盘</button>
        </div>
        <div v-if="localPanel === 'replay'" class="replay-file-action">
          <span v-if="replayFileName" :title="replayFileName">{{ replayFileName }}</span>
          <span v-else>选择或拖入 `.md` 棋谱</span>
          <button class="tool-button" type="button" @click="replayFileInput?.click()">{{ replayDocument ? '更换棋谱' : '选择棋谱' }}</button>
        </div>
        <input ref="replayFileInput" class="replay-file-input" type="file" accept=".md,text/markdown,text/plain" @change="chooseReplayFile">
      </section>
      <p v-if="mode === 'local' && replayImportError" class="replay-import-error" role="alert">{{ replayImportError }}</p>

      <section v-if="mode === 'local' && localPanel === 'replay' && !replayDocument" class="replay-empty"
        @dragenter.prevent="replayDragActive = true" @dragover.prevent="replayDragActive = true"
        @dragleave.prevent="replayDragActive = false" @drop.prevent="dropReplayFile">
        <span class="replay-empty-seal" aria-hidden="true">谱</span>
        <h2>导入棋谱回看全局</h2>
        <p>选择或拖入三国象棋导出的 `.md` 棋谱。</p>
        <button class="primary-button" type="button" @click="replayFileInput?.click()">选择棋谱文件</button>
      </section>

      <section v-else-if="isReplaying" class="replay-console" aria-label="棋谱复盘控制">
        <div class="replay-console-head">
          <div><strong>棋谱复盘</strong><span>{{ replayFileName }}</span></div>
          <b>第 {{ replayIndex }} 步 / 共 {{ replayTotal }} 步</b>
        </div>
        <div class="replay-controls">
          <button class="tool-button" :disabled="!replayCanGoBack" @click="jumpReplay(0)">初始局面</button>
          <button class="tool-button" :disabled="!replayCanGoBack" @click="jumpReplay(replayIndex - 1)">上一步</button>
          <button class="primary-button replay-play-button" :disabled="replayTotal === 0" @click="toggleReplayPlayback">{{ replayPlaying ? '暂停' : '自动播放' }}</button>
          <button class="tool-button" :disabled="!replayCanGoForward" @click="jumpReplay(replayIndex + 1)">下一步</button>
          <button class="tool-button" :disabled="!replayCanGoForward" @click="jumpReplay(replayTotal)">最后一步</button>
          <div class="replay-speed" aria-label="自动播放速度">
            <button v-for="speed in (['slow', 'normal', 'fast'] as const)" :key="speed" :class="{ active: replaySpeed === speed }" @click="setReplaySpeed(speed)">{{ speed === 'slow' ? '慢' : speed === 'normal' ? '正常' : '快' }}</button>
          </div>
        </div>
        <p class="replay-declared-result">文件记录结果：{{ replayDocument?.declaredResult || '未注明' }}</p>
        <div v-for="warning in replayDocument?.warnings" :key="warning.message" class="replay-warning">
          <strong>棋谱提示</strong>
          <p>{{ warning.message }}</p>
          <details><summary>查看核对详情</summary><ul><li v-for="detail in warning.details" :key="detail">{{ detail }}</li></ul></details>
        </div>
      </section>

      <main v-if="localPanel !== 'replay' || replayDocument" class="play-layout" :class="{ 'is-replay': isReplaying }">
      <aside class="players-panel" aria-label="玩家与当前回合">
        <div class="section-label"><span>本局席位</span></div>
        <div class="player-cards">
          <section v-for="faction in ORDER" :key="faction" class="player-card"
            :class="{active: highlightedFaction === faction, eliminated: game.eliminated.includes(faction), offline: mode === 'online' && roomPlayer(faction) && !roomPlayer(faction)?.online}"
            :style="{'--faction-color': PLAYERS[faction].color}"
            :aria-current="highlightedFaction === faction ? 'true' : undefined">
            <div class="player-card-top">
              <div class="avatar" :class="{'avatar-lit': highlightedFaction === faction}">{{ PLAYERS[faction].initial }}<span class="avatar-dot" v-if="highlightedFaction === faction"></span></div>
              <div class="player-name">
                <h2 tabindex="0" :title="playerDisplayName(faction)" :aria-label="`${playerDisplayName(faction)}，${PLAYERS[faction].name}`">{{ playerDisplayName(faction) }}</h2>
                <span class="player-name-tooltip" aria-hidden="true">{{ playerDisplayName(faction) }}</span>
              </div>
            </div>
            <div class="player-card-bottom">
              <span>{{ count(faction) }} 枚子力</span>
              <div class="player-status-list">
                <strong v-for="status in playerStatuses(faction)" :key="status.label" class="player-status" :class="`status-${status.tone}`">{{ status.label }}</strong>
              </div>
            </div>
          </section>
        </div>
        <div v-if="game.status === 'finished'" class="ranking-card"><strong>本局结果</strong><p v-for="faction in ORDER" :key="faction">{{ playerDisplayName(faction) }} · {{ resultLabel(game, faction) }}</p></div>
      </aside>

      <section class="board-panel" aria-label="三国象棋棋盘">
        <div class="board-heading"><div class="board-heading-copy"><span v-if="mode === 'online' && !isReplaying" class="room-chip">房间 {{ room?.code }}</span><h2 v-if="isReplaying && replayCurrentStep">第 {{ replayIndex }} 步 · <span :style="{color: PLAYERS[replayCurrentStep.faction].color}">{{ PLAYERS[replayCurrentStep.faction].name }}</span> 行棋</h2><h2 v-else-if="isReplaying">初始局面</h2><h2 v-else-if="game.status === 'playing' && active">轮到 <span :style="{color: active.color}">{{ activePlayerName }}</span> 行棋</h2><h2 v-else-if="game.status === 'finished' && game.winner"><span :style="{color: PLAYERS[game.winner].color}">{{ winnerDisplayName }}</span> 获胜</h2><h2 v-else-if="game.status === 'finished'">本局和棋</h2></div><span v-if="isReplaying" class="move-count">第 <strong>{{ replayIndex }}</strong> / {{ replayTotal }} 步</span><span v-else class="move-count">第 <strong>{{ game.history.length + (game.status === 'playing' ? 1 : 0) }}</strong> 步</span></div>
        <div v-if="mode === 'online' && connection !== 'online'" class="network-banner" role="alert">连接中断，正在重连…</div>
        <div v-if="mode === 'local' && compatibilityWarning" class="legacy-save-banner" role="alert"><div><strong>旧存档已保留</strong><p>旧规则、旧初始布局或名次存档不能按当前规则安全续局。</p></div><button class="primary-button" @click="reset">按新规则另开一局</button></div>
        <div v-if="drawOffer" class="draw-offer-card" role="status" aria-live="polite">
          <div><span class="eyebrow">和棋申请</span><strong>{{ playerDisplayName(drawOffer.proposer) }}发起和棋</strong><p>{{ drawEligibleNames }}须全部同意；已同意 {{ drawAcceptedCount }}/{{ drawOffer.eligible.length }}</p></div>
          <div v-if="canRespondDraw" class="draw-offer-actions"><button class="tool-button" :disabled="connection !== 'online'" @click="respondToDraw('reject')">拒绝</button><button class="primary-button" :disabled="connection !== 'online'" @click="respondToDraw('accept')">同意和棋</button></div>
          <span v-else-if="ownDrawVote === 'accept'" class="draw-waiting">已同意，等待其他阵营</span>
          <span v-else-if="drawOffer.proposer === ownFaction" class="draw-waiting">等待其他阵营回应</span>
        </div>
        <div class="board-frame">
          <svg class="board-svg" viewBox="0 0 540 595" role="group" :aria-label="`九路十横线棋盘，${flipped ? '已翻转' : '标准'}视角；坐标标识为标准坐标`" @click="boardClick" @touchend="boardTouch">
            <defs>
              <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#efdab4"/><stop offset="1" stop-color="#e5c897"/></linearGradient>
              <pattern id="grain" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M0 6 H18 M0 15 H18" stroke="#755935" stroke-opacity=".035"/></pattern>
              <marker id="trail-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a77b36"/></marker>
            </defs>
            <rect x="8" y="8" width="524" height="579" rx="8" fill="url(#wood)"/>
            <rect x="8" y="8" width="524" height="579" rx="8" fill="url(#grain)"/>
            <rect x="37" y="37" width="466" height="521" fill="none" stroke="#674d2f" stroke-width="1.4"/>
            <g class="grid-lines">
              <line v-for="n in 10" :key="`h${n}`" :x1="px(0)" :x2="px(8)" :y1="py(n-1)" :y2="py(n-1)"/>
              <template v-for="n in 9" :key="`v${n}`"><line :x1="px(n-1)" :x2="px(n-1)" :y1="py(0)" :y2="py(4)"/><line :x1="px(n-1)" :x2="px(n-1)" :y1="py(5)" :y2="py(9)"/></template>
              <line :x1="px(0)" :x2="px(0)" :y1="py(4)" :y2="py(5)"/><line :x1="px(8)" :x2="px(8)" :y1="py(4)" :y2="py(5)"/>
              <path :d="`M${px(3)} ${py(0)} L${px(5)} ${py(2)} M${px(5)} ${py(0)} L${px(3)} ${py(2)} M${px(3)} ${py(7)} L${px(5)} ${py(9)} M${px(5)} ${py(7)} L${px(3)} ${py(9)}`"/>
            </g>
            <g class="coordinates"><text v-for="n in 9" :key="n" :x="px(n-1)" y="25">{{ flipped ? 10 - n : n }}</text><text v-for="n in 10" :key="`row${n}`" x="24" :y="py(n-1)+4">{{ flipped ? 11 - n : n }}</text></g>
            <text class="river" x="175" y="305">{{ flipped ? '秦 岭' : '淮 河' }}</text><text class="river" x="365" y="305">{{ flipped ? '淮 河' : '秦 岭' }}</text>
            <g v-if="latest" class="last-trail" aria-hidden="true"><line :x1="viewX(latest.from.x)" :y1="viewY(latest.from.y)" :x2="viewX(latest.to.x)" :y2="viewY(latest.to.y)" marker-end="url(#trail-tip)"/><rect :x="viewX(latest.from.x)-18" :y="viewY(latest.from.y)-18" width="36" height="36" rx="4"/><circle :cx="viewX(latest.to.x)" :cy="viewY(latest.to.y)" r="26"/></g>
            <g v-for="point in moves" :key="`${point.x},${point.y}`" class="legal-point" role="button" tabindex="0" :data-board-x="point.x" :data-board-y="point.y" :aria-label="`${capturedAt(point) ? '吃子到' : '走到'}第${point.x+1}路第${point.y+1}线`" @click.stop="cellClick(point.x,point.y)" @keydown.enter.prevent.stop="cellClick(point.x,point.y)" @keydown.space.prevent.stop="cellClick(point.x,point.y)">
              <circle :cx="viewX(point.x)" :cy="viewY(point.y)" r="23" fill="transparent"/><circle :cx="viewX(point.x)" :cy="viewY(point.y)" :r="capturedAt(point) ? 27 : 6" :class="capturedAt(point) ? 'capture-ring' : 'move-dot'"/>
            </g>
            <g v-for="piece in game.pieces" :key="piece.id" class="piece" :class="[piece.faction,{selected: selectedId === piece.id}]" :style="{transform: `translate(${viewX(piece.x)}px, ${viewY(piece.y)}px)`}" role="button" tabindex="0" :data-board-x="piece.x" :data-board-y="piece.y" :aria-label="pieceLabel(piece)" :aria-pressed="selectedId === piece.id" @click.stop="cellClick(piece.x,piece.y)" @keydown.enter.prevent.stop="cellClick(piece.x,piece.y)" @keydown.space.prevent.stop="cellClick(piece.x,piece.y)">
              <circle class="selection-ring" r="27"/><circle class="piece-shadow" cy="2.5" r="23"/><circle class="piece-face" r="23"/><circle class="piece-rim" r="19.5"/><text :class="{general: piece.kind === 'king'}" y="1">{{ pieceName(piece) }}</text>
            </g>
          </svg>
        </div>
        <div class="board-tools"><button v-if="mode === 'local' && !isReplaying" class="tool-button" :disabled="compatibilityWarning || !undo.length" @click="undoMove"><span aria-hidden="true">↶</span> 悔棋</button><button v-if="mode === 'local' && !isReplaying" class="tool-button" @click="resetRequest"><span aria-hidden="true">↻</span> 重新开局</button><button v-if="mode === 'online' && !spectating && room?.phase === 'finished'" class="primary-button rematch-button" :disabled="rematchBusy || connection !== 'online'" @click="requestRematch">{{ rematchBusy ? '请稍候…' : '再来一局' }}</button><button class="tool-button flip-button" :aria-pressed="flipped" @click="flipOverride = !flipOverride">翻转棋盘</button><button v-if="isReplaying" class="tool-button" @click="switchLocalPanel('play')">退出复盘</button><button v-if="mode === 'online' && !spectating && room?.phase === 'playing' && ownFaction && !game.eliminated.includes(ownFaction)" class="tool-button draw-button" :disabled="!canOfferDraw || connection !== 'online'" :title="game.turn === ownFaction ? '向其他存活阵营发起和棋' : '只有轮到自己行棋时才能提和'" @click="requestDraw">提和</button><button v-if="mode === 'online' && !spectating && room?.phase === 'playing' && ownFaction && !game.eliminated.includes(ownFaction)" class="tool-button resign-button" @click="resignDialog?.showModal()">认输</button><button v-if="mode === 'online' && !spectating" class="tool-button leave-button" @click="requestLeave">退出房间</button><button v-if="spectating" class="tool-button leave-button" @click="exitWatchingToLobby">退出观战</button></div>
        <p v-if="feedbackError || (!isReplaying && mode === 'local' && !!message)" class="feedback" :class="{error: feedbackError}" role="status" aria-live="polite"><span class="feedback-icon" aria-hidden="true">{{ feedbackError ? '!' : '›' }}</span>{{ message }}</p>
        <div v-if="game.status === 'finished'" class="result-banner"><strong>{{ game.winner ? `${winnerDisplayName}获胜` : '和棋' }}</strong><span v-if="game.winner">{{ losersText }}失败。本局共 {{ game.history.length }} 步。</span><span v-else>{{ drawingText }}同意和棋{{ losersText ? `；${losersText}此前失败` : '' }}。本局共 {{ game.history.length }} 步。</span></div>
      </section>

      <aside class="history-panel" aria-label="行棋记录">
        <div class="section-label history-heading"><span>{{ isReplaying ? `复盘记录 · ${replayTotal} 步` : `行棋记录 · ${game.history.length} 步` }}</span><button v-if="!isReplaying" class="record-export-button" :disabled="!game.history.length" @click="exportGameRecord(game)">导出棋谱</button></div>
        <div class="last-move-card"><span class="eyebrow">{{ isReplaying ? '当前步骤' : '上一步' }}</span><template v-if="latest"><h3 :style="{color: PLAYERS[latest.faction].color}">{{ PLAYERS[latest.faction].name }} · {{ pieceName(latest) }}</h3><p>{{ coordinate(latest.from) }} <b>→</b> {{ coordinate(latest.to) }}</p><small>{{ latest.captured ? `吃掉${PLAYERS[latest.captured.faction].nation}方${pieceName(latest.captured)}` : '已标记起点和落点' }}</small></template><template v-else><h3>{{ isReplaying ? '初始局面' : '棋局已就绪' }}</h3><p>{{ isReplaying ? '尚未行棋' : '曹操先行' }}</p><small>{{ isReplaying ? '可使用上方控件逐步查看' : '走子后保留起点与落点痕迹' }}</small></template></div>
        <ol v-if="isReplaying && replayDocument" class="move-list replay-move-list"><li v-for="(record, index) in replayDocument.moves" :key="record.number" :class="{ current: replayIndex === index + 1 }" tabindex="0" @click="jumpReplay(index + 1)" @keydown.enter.prevent="jumpReplay(index + 1)" @keydown.space.prevent="jumpReplay(index + 1)"><span class="record-number">{{ String(record.number).padStart(2,'0') }}</span><div><strong :style="{color: PLAYERS[record.faction].color}">{{ PLAYERS[record.faction].name }}</strong><p>{{ description(record) }}</p><small v-if="record.captured" class="capture-record">吃掉{{ PLAYERS[record.captured.faction].nation }}方{{ pieceName(record.captured) }}</small><small v-if="record.eliminated.length">{{ eliminatedNames(record) }}出局，判为失败</small></div></li></ol>
        <ol v-else-if="records.length" class="move-list"><li v-for="record in records" :key="record.number"><span class="record-number">{{ String(record.number).padStart(2,'0') }}</span><div><strong :style="{color: PLAYERS[record.faction].color}">{{ PLAYERS[record.faction].name }}</strong><p>{{ description(record) }}</p><small v-if="record.eliminated.length">{{ eliminatedNames(record) }}出局，判为失败</small></div></li></ol>
        <div v-else class="empty-history"><span aria-hidden="true">弈</span><p>{{ isReplaying ? '棋谱没有行棋记录。' : '第一步，开启新棋局。' }}</p></div>
        <details class="board-legend"><summary>标记说明</summary><div class="board-legend-items"><p><i class="legend-dot"></i> 可走位置</p><p><i class="legend-ring"></i> 可以吃子</p><p><i class="legend-square"></i> 上一步起点与落点</p></div></details>
      </aside>
      </main>
    </template>
    <footer class="site-footer"><span>三人同局，魏蜀吴对弈 · 当前为试玩规则。</span><span v-if="page === 'local'">{{ saveAvailable ? '棋局自动保存在本机' : '本机保存不可用，请保持页面打开' }}</span></footer>
    <dialog ref="rulesDialog" class="rules-dialog"><div class="dialog-heading"><h2>本轮试玩规则</h2><button class="dialog-close" aria-label="关闭规则" @click="rulesDialog?.close()">×</button></div><p>本地模式可在同一页面轮流控制三国；联机模式中三人各控制自己的阵营。魏 → 蜀 → 吴循环，每方每回合只走一步。曹操视角上方左吴右蜀，魏方默认标准视角；刘备、孙权默认使用相同的 180° 视角，翻转只改变个人看到的画面与点击换算。输入房间号可只读观战。</p><ul><li>三方独立竞争。初始共 29 枚：魏 16、蜀 6、吴 7；上方中路中卒归吴方。任意不同阵营可以按棋子走法互相吃子；同国棋子不能互吃。</li><li>主公被吃、困毙或认输，该国失败并清空全部棋子；剩余两国严格交替。</li><li>最后存活的一方获胜，其余两方失败。首位出局后对局继续；曹操先出局时蜀吴继续争胜。</li><li>联机对弈中，只有轮到自己行棋时才能提和；所有存活阵营同意后本局和棋。已有一方出局时，剩余两方均同意即可。</li><li>锋：向前一或两格；向后、向左、向右一格，不能跳子。</li><li>刘备、孙权：上方底线第 2～8 路，每次横走一格。曹操仍在下方九宫。</li><li>任意棋子都可以作炮架。取消对面笑；其余棋子的基本走法沿用中国象棋。</li></ul><div class="trial-rule"><strong>这一轮的临时约定</strong><p>以吃主公判出局，不强制应将，也不禁止送将。重复局面的自动判和次数尚待确认；本版仅采用全部存活阵营同意的手动和棋。</p></div><button class="primary-button" @click="rulesDialog?.close()">知道了，继续行棋</button></dialog>
    <dialog ref="settingsDialog" class="settings-dialog">
      <div class="dialog-heading"><h2>声音设置</h2><button class="dialog-close" aria-label="关闭设置" @click="settingsDialog?.close()">×</button></div>
      <div class="audio-control"><label for="music-toggle">背景音乐</label><button id="music-toggle" class="tool-button" :aria-pressed="audioSettings.musicEnabled" @click="toggleMusic">{{ audioSettings.musicEnabled ? '开启' : '关闭' }}</button><label for="music-volume">音乐音量 {{ Math.round(audioSettings.musicVolume * 100) }}%</label><input id="music-volume" v-model.number="audioSettings.musicVolume" type="range" min="0" max="1" step="0.01" aria-label="音乐音量"></div>
      <div class="music-choice"><label for="music-playlist">歌单</label><select id="music-playlist" :value="audioSettings.musicPlaylistId" @change="choosePlaylist"><option v-for="playlist in MUSIC_PLAYLISTS" :key="playlist.id" :value="playlist.id">{{ playlist.name }}</option></select><label for="music-track">歌曲</label><select id="music-track" :value="audioSettings.musicTrackId" @change="chooseTrack"><option v-for="track in availableTracks" :key="track.id" :value="track.id">{{ track.name }}</option></select><div class="music-choice-footer"><p>当前选择：{{ selectedTrackName }}</p><button id="music-preview" class="tool-button" @click="previewSelectedMusic">试听</button></div></div>
      <div class="audio-control"><label for="effects-toggle">落子音效</label><button id="effects-toggle" class="tool-button" :aria-pressed="audioSettings.effectsEnabled" @click="audioSettings.effectsEnabled = !audioSettings.effectsEnabled">{{ audioSettings.effectsEnabled ? '开启' : '关闭' }}</button><label for="effects-volume">音效音量 {{ Math.round(audioSettings.effectsVolume * 100) }}%</label><input id="effects-volume" v-model.number="audioSettings.effectsVolume" type="range" min="0" max="1" step="0.01" aria-label="音效音量"></div><p v-if="audioMessage" class="connection-note error" role="status">{{ audioMessage }}</p><p v-if="audioSettings.musicEnabled && !audioMessage" class="audio-hint">若浏览器暂停播放，请关闭后重新开启音乐。</p>
    </dialog>
    <dialog ref="resetDialog" class="reset-dialog"><h2>重新开局？</h2><p>当前棋局与行棋记录将清空，三国棋子回到初始位置。</p><div class="dialog-actions"><button class="tool-button" @click="resetDialog?.close()">继续本局</button><button class="primary-button" @click="reset">重新开局</button></div></dialog>
    <dialog ref="resignDialog" class="reset-dialog"><h2>确认认输？</h2><p>本国立即失败并清空棋子；你仍可留在房间查看。</p><div class="dialog-actions"><button class="tool-button" @click="resignDialog?.close()">继续对局</button><button class="primary-button" @click="confirmResign">确认认输</button></div></dialog>
    <dialog ref="exitDialog" class="reset-dialog" @cancel.prevent="cancelExitRequest"><h2>确认退出房间？</h2><p>离开对局页面会按当前规则退出并结算席位，随后继续当前操作。若恰好断网，将先记录退出意图，重连后完成退出。</p><div class="dialog-actions"><button class="tool-button" type="button" @click="cancelExitRequest">继续对局</button><button class="primary-button" type="button" :disabled="leavingRoom" @click="confirmLeave">{{ leavingRoom ? '正在退出…' : '确认退出' }}</button></div></dialog>
    <dialog ref="inviteDialog" class="invite-copy-dialog">
      <div class="dialog-heading">
        <h2>{{ inviteCopyResult === 'copied' ? '邀请链接已复制' : inviteCopyResult === 'no-room' ? '暂无有效房间' : '请手动复制邀请链接' }}</h2>
        <button type="button" class="dialog-close" aria-label="关闭邀请链接" @click="inviteDialog?.close()">×</button>
      </div>
      <p v-if="inviteCopyResult === 'copied'">链接已写入剪贴板，可以直接发给好友。</p>
      <p v-else-if="inviteCopyResult === 'manual'">浏览器未能自动复制，请长按或全选下面的完整网址后复制。</p>
      <p v-else>当前没有已确认的房间，无法生成邀请链接。</p>
      <textarea v-if="inviteLink" ref="inviteLinkInput" class="invite-link-text" :value="inviteLink" readonly rows="3"
        aria-label="完整邀请链接" @focus="selectInviteLink"></textarea>
      <div class="dialog-actions">
        <button v-if="inviteLink" class="tool-button" type="button" @click="selectInviteLink">全选链接</button>
        <button class="primary-button" type="button" @click="inviteDialog?.close()">关闭</button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.watch-entry .join-row input{font-size:14px;font-weight:500}
.watch-entry .join-row input::placeholder{color:#8c7a66;font-weight:500;opacity:1}
.watch-entry .join-row .primary-button{font-size:12px;font-weight:600}
.invite-copy-dialog{width:min(560px,calc(100vw - 32px));padding:26px}
.invite-copy-dialog p{font-size:13px;line-height:1.8;color:#756552}
.invite-copy-dialog .dialog-actions{margin-top:16px}
.invite-link-text{width:100%;margin-top:14px;padding:11px 12px;border:1px solid #d8cab4;border-radius:8px;background:#fffefb;color:#43382d;font:500 13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;resize:none;outline:none}
.invite-link-text:focus{border-color:#a78147;box-shadow:0 0 0 3px #a781471b}
.players-panel .section-label{justify-content:flex-start;margin-bottom:13px;letter-spacing:.08em}
.players-panel,.board-panel,.history-panel,.player-cards{min-width:0}
.player-cards{gap:10px}
.player-card{min-width:0;min-height:112px;padding:13px 14px;border-radius:11px;background:linear-gradient(145deg,#fbf8f2,#f7f2e9);transition:background .2s ease,border-color .2s ease,box-shadow .2s ease,opacity .2s ease}
.player-card:hover,.player-card:focus-within{z-index:3}
.player-card.active{background:#fffdf8;box-shadow:inset 3px 0 var(--faction-color),0 7px 18px #77582c10}
.player-card.offline:not(.active){border-style:dashed;background:#f3f0ea}
.player-card.eliminated{opacity:.58}
.player-card-top{gap:11px;min-width:0}
.player-card .avatar{width:44px;height:44px;font-size:24px;background:#eee6da}
.player-card .avatar.avatar-lit{background:var(--faction-color);color:#fff7e8;box-shadow:0 0 0 4px color-mix(in srgb,var(--faction-color) 12%,transparent),0 0 18px color-mix(in srgb,var(--faction-color) 16%,transparent)}
.player-name{position:relative;flex:1;min-width:0}
.player-name h2{max-width:100%;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#3f352b;font:700 21px/1.25 "Songti SC","SimSun",serif;letter-spacing:.02em;outline:none}
.player-name h2:focus-visible{border-radius:3px;box-shadow:0 0 0 2px #fffdf8,0 0 0 4px var(--faction-color)}
.player-name-tooltip{position:absolute;left:0;top:calc(100% + 5px);z-index:8;max-width:210px;padding:6px 9px;border:1px solid #cdbb9f;border-radius:6px;background:#fffdf7;box-shadow:0 8px 20px #4934201c;color:#4d4033;font-size:11px;font-weight:600;line-height:1.45;white-space:normal;opacity:0;pointer-events:none;transform:translateY(-3px);transition:opacity .14s ease,transform .14s ease}
.player-name h2:hover+.player-name-tooltip,.player-name h2:focus-visible+.player-name-tooltip{opacity:1;transform:translateY(0)}
.player-card-bottom{display:flex;align-items:center;justify-content:space-between;gap:7px;margin-top:11px;padding-top:10px;border-top:1px solid #e4dbcd;font-size:10px;color:#897b68}
.player-status-list{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}
.player-status{padding:2px 7px;border:1px solid transparent;border-radius:999px;font-size:9px;font-weight:700;line-height:1.5;white-space:nowrap}
.player-status.status-active{border-color:color-mix(in srgb,var(--faction-color) 35%,transparent);background:color-mix(in srgb,var(--faction-color) 10%,#fffdf8);color:var(--faction-color)}
.player-status.status-offline{border-color:#cfc5b7;background:#f0ece5;color:#786e61}
.player-status.status-out{border-color:#cfb9ad;background:#f6ebe6;color:#9c4f43}
.player-status.status-result{border-color:#cbbd9e;background:#f4eddf;color:#755f3c}
.ranking-card{margin-top:18px}
.board-heading{align-items:flex-end;margin-bottom:14px}
.board-heading-copy{display:grid;gap:5px;min-width:0}
.room-chip{justify-self:start;padding:3px 8px;border:1px solid #d8c9b2;border-radius:999px;background:#faf5eb;color:#826f56;font-size:10px;font-weight:600;letter-spacing:.05em}
.board-heading h2{margin:0;color:#3d352c;font-size:23px;font-weight:600;letter-spacing:.01em}
.board-heading h2{overflow-wrap:anywhere}
.board-heading h2 span{font-weight:700}
.move-count{margin-bottom:1px;background:#fffdf8}
.history-panel .board-legend{display:block;margin-top:20px;padding-top:13px}
.history-panel .board-legend summary{display:flex;align-items:center;justify-content:space-between;gap:10px;list-style:none;cursor:pointer;color:#796a57;font-size:11px;font-weight:600}
.history-panel .board-legend summary::-webkit-details-marker{display:none}
.history-panel .board-legend summary::after{content:"展开";color:#a08049;font-size:10px;font-weight:500}
.history-panel .board-legend[open] summary::after{content:"收起"}
.history-panel .board-legend summary:focus-visible{outline:2px solid #9b7b45;outline-offset:4px;border-radius:3px}
.board-legend-items{display:grid;gap:8px;padding-top:11px}
.history-panel .board-legend-items p{margin:0}
.local-workbench{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:18px auto 0;padding:9px 11px;border:1px solid #d9cbb7;border-radius:12px;background:#fffdf8;box-shadow:0 8px 24px #59432308;transition:border-color .16s ease,box-shadow .16s ease}
.local-workbench.drag-active{border-color:#a78147;box-shadow:0 0 0 3px #a7814718}
.local-view-tabs{display:inline-flex;gap:3px;padding:3px;border-radius:9px;background:#efe7d9}
.local-view-tabs button{min-height:36px;padding:0 15px;border:0;border-radius:7px;background:transparent;color:#796a57;font-size:12px;font-weight:600}
.local-view-tabs button.active{background:#fffdf8;color:#8e4236;box-shadow:0 1px 5px #59432317}
.local-view-tabs button:focus-visible,.replay-controls button:focus-visible,.replay-speed button:focus-visible,.replay-file-action button:focus-visible,.replay-move-list li:focus-visible{outline:2px solid #997545;outline-offset:2px}
.replay-file-action{display:flex;align-items:center;gap:10px;min-width:0;color:#877762;font-size:11px}
.replay-file-action>span{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.replay-file-action .tool-button{min-height:36px;border-color:#d4c4ac;background:#fffaf0}
.replay-file-input{display:none}
.replay-import-error{margin:10px auto 0;max-width:1110px;padding:10px 13px;border-left:3px solid #a34438;border-radius:0 7px 7px 0;background:#f8eae5;color:#8f4237;font-size:12px}
.replay-empty{max-width:720px;margin:28px auto 0;padding:42px 28px;text-align:center;border:1px dashed #d2c1a6;border-radius:16px;background:#fffdf8}
.replay-empty-seal{display:grid;place-items:center;width:54px;height:60px;margin:0 auto 15px;border:1px solid #a94c3e;border-radius:6px;background:#a94c3e;color:#fff7e8;font:700 30px/1 "STKaiti","KaiTi",serif;box-shadow:inset 0 0 0 3px #fff4df2b;transform:rotate(-2deg)}
.replay-empty h2{margin:0 0 8px;font:700 23px "Songti SC","SimSun",serif;color:#453a2e}
.replay-empty p{margin:0 0 20px;color:#857762;font-size:12px}
.replay-console{max-width:1110px;margin:12px auto 0;padding:15px 17px;border:1px solid #d9cbb7;border-radius:13px;background:linear-gradient(145deg,#fffdf8,#f8f2e7);box-shadow:0 9px 26px #5943230a}
.replay-console-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:12px}
.replay-console-head>div{display:grid;gap:2px;min-width:0}
.replay-console-head strong{font:700 18px "Songti SC","SimSun",serif;color:#43392e}
.replay-console-head span{max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#897a65;font-size:10px}
.replay-console-head>b{flex:none;padding:4px 9px;border-radius:999px;background:#f0e7d8;color:#785e39;font-size:11px;font-weight:600}
.replay-controls{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.replay-controls>button{min-height:38px;padding:7px 11px;border:1px solid #d4c4ac;background:#fffdf8;font-size:11px}
.replay-controls>.replay-play-button{min-width:84px;border-color:#a64b3c;background:#a64b3c;color:#fff7e6;font-size:12px}
.replay-play-button:hover:not(:disabled){background:#8f3d31}
.replay-speed{display:inline-flex;margin-left:auto;padding:3px;border:1px solid #d4c4ac;border-radius:8px;background:#eee6d8}
.replay-speed button{min-height:30px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:#756652;font-size:10px}
.replay-speed button.active{background:#fffdf8;color:#8e4236;box-shadow:0 1px 4px #59432315}
.replay-declared-result{margin:10px 0 0;color:#786956;font-size:11px}
.replay-warning{margin-top:10px;padding:10px 12px;border-left:3px solid #bf8e51;border-radius:0 8px 8px 0;background:#f7eedf;color:#785d38}
.replay-warning strong{font-size:12px}.replay-warning p{margin:4px 0 0;font-size:11px;line-height:1.65}
.replay-warning details{margin-top:7px;font-size:10px;color:#7f6b50}.replay-warning summary{cursor:pointer;font-weight:600}
.replay-warning ul{margin:7px 0 0;padding-left:18px;line-height:1.7}
.replay-move-list li{cursor:pointer;padding-right:8px;border-radius:6px;transition:background .14s ease}
.replay-move-list li:hover{background:#f6efe3}.replay-move-list li.current{background:#f1e6d3;box-shadow:inset 3px 0 #a77a3e}
.history-panel .replay-move-list{padding-right:2px}
.history-panel .replay-move-list .capture-record{color:#8c6a3f}
@media(max-width:900px){
  .player-card{min-height:0}
}
@media(max-width:720px){
  .local-workbench{align-items:stretch;flex-direction:column;gap:9px;padding:8px}
  .local-view-tabs{display:grid;grid-template-columns:1fr 1fr}
  .local-view-tabs button{min-height:40px;padding:0 8px}
  .replay-file-action{justify-content:space-between}
  .replay-file-action>span{max-width:60vw}
  .replay-console{margin-top:10px;padding:13px 12px}
  .replay-console-head{align-items:flex-start;gap:8px}
  .replay-console-head strong{font-size:17px}.replay-console-head>b{font-size:10px}
  .replay-controls{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
  .replay-controls>button{width:100%;min-height:40px;padding:6px}
  .replay-controls>.replay-play-button{min-width:0}
  .replay-speed{grid-column:1 / -1;justify-self:start;margin-left:0;margin-top:2px}
  .replay-speed button{min-width:52px;min-height:32px}
  .replay-empty{margin:18px 0 0;padding:34px 18px}
  .replay-import-error{margin-top:9px}
  .play-layout{grid-template-columns:minmax(0,1fr)}
  .players-panel,.board-panel,.history-panel{width:100%}
  .players-panel .section-label{margin-bottom:10px}
  .player-cards{grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
  .player-card{min-height:132px;padding:10px 8px 9px;border-radius:9px}
  .player-card-top{flex-direction:column;align-items:center;gap:6px}
  .player-card .avatar{width:35px;height:35px;font-size:20px}
  .player-name{width:100%;text-align:center}
  .player-name h2{font-size:15px;line-height:1.3}
  .player-name-tooltip{left:50%;top:calc(100% + 4px);max-width:180px;transform:translate(-50%,-3px);text-align:left}
  .player-name h2:hover+.player-name-tooltip,.player-name h2:focus-visible+.player-name-tooltip{transform:translate(-50%,0)}
  .player-card-bottom{align-items:flex-start;flex-direction:column;gap:5px;margin-top:8px;padding-top:7px;font-size:8px}
  .player-status-list{justify-content:flex-start;gap:3px}
  .player-status{padding:1px 5px;font-size:8px}
  .board-heading{align-items:flex-start;gap:9px}
  .room-chip{font-size:9px;padding:2px 6px}
  .board-heading h2{font-size:18px}
  .move-count{padding:4px 8px}
}
</style>
