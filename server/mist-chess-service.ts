import { randomBytes, randomUUID } from 'node:crypto';
import {
  MIST_CHESS_GAME_ID,
  drawMistGame,
  newMistGame,
  playMistMove,
  projectMistGame,
  resignMistGame,
  spectatorMistGame,
} from '../src/mist-chess.ts';
import { isChineseSide } from '../src/chinese-chess.ts';
import type {
  MistAck,
  MistGame,
  MistMoveIntent,
  MistPhase,
  MistPlayerView,
  MistReceipt,
  MistState,
} from '../src/mist-chess.ts';
import type { ChineseSide } from '../src/chinese-chess.ts';
import type {
  ArchivedMistGameRecord,
  ArchivedMistParticipant,
  MistArchivedEndReason,
} from '../src/mist-game-history.ts';

interface MistPlayer {
  id: string;
  token: string;
  nickname: string;
  avatar: string | null;
  accountId: string | null;
  side: ChineseSide;
  ready: boolean;
  online: boolean;
  offlineUntil: number | null;
  socketId: string | null;
}

interface StoredAck {
  fingerprint: string;
  ack: MistAck<{ state: MistState }>;
}

type PersistReason = MistArchivedEndReason | 'move';

interface ActionSuccess<T = undefined> {
  ok: true;
  ack: MistAck<T>;
  changed?: boolean;
  replacedSocketId?: string;
  departedSocketId?: string;
}

interface ActionFailure {
  ok: false;
  ack: MistAck<never>;
  changed?: boolean;
}

type ActionResult<T = undefined> = ActionSuccess<T> | ActionFailure;

const cleanNickname = (value: unknown): string =>
  typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 16) : '';

export class MistChessService {
  private readonly onChanged: (service: MistChessService) => void;
  private readonly disconnectGraceMs: number;
  private readonly now: () => number;
  private readonly onCompleted: (record: ArchivedMistGameRecord) => void;
  private phase: MistPhase = 'lobby';
  private version = 1;
  private round = 1;
  private game: MistGame | null = null;
  private gameId: string | null = null;
  private gameStartedAt: number | null = null;
  private initialGame: MistGame | null = null;
  private startedParticipants: ArchivedMistParticipant[] = [];
  private gamePersisted = false;
  private drawOfferBy: ChineseSide | null = null;
  private players: MistPlayer[] = [];
  private readonly socketPlayers = new Map<string, string>();
  private readonly socketAccounts = new Map<string, string | null>();
  private readonly socketAvatars = new Map<string, string | null>();
  private readonly lobbyWatchers = new Set<string>();
  private readonly observers = new Set<string>();
  private readonly requests = new Map<string, Map<string, StoredAck>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    onChanged: (service: MistChessService) => void,
    disconnectGraceMs = 60_000,
    now: () => number = Date.now,
    onCompleted: (record: ArchivedMistGameRecord) => void = () => undefined,
  ) {
    this.onChanged = onChanged;
    this.disconnectGraceMs = disconnectGraceMs;
    this.now = now;
    this.onCompleted = onCompleted;
  }

  setSocketAccount(socketId: string, accountId: string | null, avatar: string | null = null): void {
    this.socketAccounts.set(socketId, accountId);
    this.socketAvatars.set(socketId, avatar);
  }

  join(nicknameValue: unknown, sideValue: unknown, socketId: string): ActionResult<MistReceipt> {
    if (this.socketPlayers.has(socketId)) return this.fail('ALREADY_SEATED', '你已经在这个房间中。');
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '当前对局已经开始，请等待下一局。');
    if (this.players.length >= 2) return this.fail('ROOM_FULL', '两个席位都已坐满。');
    if (!isChineseSide(sideValue)) return this.fail('INVALID_SIDE', '请选择红方或黑方。');
    if (this.players.some(player => player.side === sideValue))
      return this.fail('SIDE_TAKEN', `${sideValue === 'red' ? '红方' : '黑方'}席位已经被占用。`);
    const accountId = this.socketAccounts.get(socketId) ?? null;
    if (accountId && this.players.some(player => player.accountId === accountId))
      return this.fail('ACCOUNT_ALREADY_SEATED', '这个账号已经在迷雾象棋房间中。');
    const nickname = cleanNickname(nicknameValue);
    if (!accountId && !nickname) return this.fail('NICKNAME_REQUIRED', '未登录玩家需要填写昵称。');
    const player: MistPlayer = {
      id: randomUUID(),
      token: randomBytes(32).toString('base64url'),
      nickname: nickname || '账号玩家',
      avatar: accountId ? this.socketAvatars.get(socketId) ?? null : null,
      accountId,
      side: sideValue,
      ready: false,
      online: true,
      offlineUntil: null,
      socketId,
    };
    this.players.push(player);
    this.lobbyWatchers.delete(socketId);
    this.observers.delete(socketId);
    this.bindSocket(player, socketId);
    this.version++;
    return { ok: true, changed: true, ack: { ok: true, data: this.receipt(player) } };
  }

  inspect(socketId?: string): MistAck<MistState> {
    if (socketId && !this.socketPlayers.has(socketId) && !this.observers.has(socketId))
      this.lobbyWatchers.add(socketId);
    return { ok: true, data: this.state(null) };
  }

  resume(tokenValue: unknown, socketId: string): ActionResult<MistReceipt> {
    const found = this.findPlayer(tokenValue);
    if (!found.ok) return found;
    if (!this.accountMatches(found.player, socketId))
      return this.fail('AUTH_MISMATCH', '当前账号与席位不一致，请重新进入。');
    const replacedSocketId = found.player.socketId && found.player.socketId !== socketId
      ? found.player.socketId : undefined;
    this.cancelExpiry(found.player.id);
    if (replacedSocketId) this.socketPlayers.delete(replacedSocketId);
    found.player.online = true;
    found.player.offlineUntil = null;
    found.player.avatar = found.player.accountId ? this.socketAvatars.get(socketId) ?? null : null;
    this.lobbyWatchers.delete(socketId);
    this.observers.delete(socketId);
    this.bindSocket(found.player, socketId);
    this.version++;
    return {
      ok: true,
      changed: true,
      replacedSocketId,
      ack: { ok: true, data: this.receipt(found.player) },
    };
  }

  chooseSide(tokenValue: unknown, sideValue: unknown, socketId: string): ActionResult<{ state: MistState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '开局后不能更换阵营。', found.player);
    if (!isChineseSide(sideValue)) return this.fail('INVALID_SIDE', '请选择红方或黑方。', found.player);
    if (this.players.some(player => player !== found.player && player.side === sideValue))
      return this.fail('SIDE_TAKEN', '这个阵营已经有玩家。', found.player);
    found.player.side = sideValue;
    found.player.ready = false;
    this.version++;
    return this.stateResult(found.player);
  }

  setReady(tokenValue: unknown, readyValue: unknown, socketId: string): ActionResult<{ state: MistState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '对局已经开始。', found.player);
    found.player.ready = readyValue === true;
    this.version++;
    if (this.players.length === 2 && this.players.every(player => player.online && player.ready)) {
      this.game = newMistGame();
      this.gameId = randomUUID();
      this.gameStartedAt = this.now();
      this.initialGame = structuredClone(this.game);
      this.startedParticipants = this.players.map(player => ({
        playerId: player.id,
        userId: player.accountId,
        nickname: player.nickname,
        side: player.side,
        result: 'draw',
      }));
      this.gamePersisted = false;
      this.phase = 'playing';
      this.drawOfferBy = null;
      this.requests.clear();
      this.version++;
    }
    return this.stateResult(found.player);
  }

  rematch(tokenValue: unknown, socketId: string): ActionResult<{ state: MistState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'finished') return this.fail('GAME_NOT_FINISHED', '本局尚未结束。', found.player);
    this.resetToLobby();
    return this.stateResult(found.player);
  }

  move(tokenValue: unknown, intentValue: unknown, socketId: string): ActionResult<{ state: MistState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    const { player } = found;
    const intent = intentValue as Partial<MistMoveIntent> | null;
    if (!intent || typeof intent.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(intent.requestId)
      || !Number.isInteger(intent.version) || typeof intent.pieceId !== 'string'
      || !intent.to || !Number.isInteger(intent.to.x) || !Number.isInteger(intent.to.y))
      return this.fail('INVALID_REQUEST', '走棋请求格式不正确。', player);
    const fingerprint = JSON.stringify([intent.version, intent.pieceId, intent.to.x, intent.to.y]);
    const playerRequests = this.requests.get(player.id) ?? new Map<string, StoredAck>();
    this.requests.set(player.id, playerRequests);
    const stored = playerRequests.get(intent.requestId);
    if (stored) {
      if (stored.fingerprint !== fingerprint)
        return this.fail('REQUEST_ID_REUSED', '请求编号已用于另一手棋。', player);
      if (stored.ack.ok) return { ok: true, ack: { ok: true, data: { state: this.state(player) } } };
      return { ok: false, ack: stored.ack };
    }
    if (this.phase !== 'playing' || !this.game)
      return this.fail('GAME_NOT_PLAYING', '棋局尚未开始或已经结束。', player);
    if (intent.version !== this.version)
      return this.fail('STALE_VERSION', '局面已经更新，请重新同步。', player);
    if (player.side !== this.game.turn)
      return this.fail('NOT_YOUR_TURN', '现在不是你的回合。', player);
    const piece = this.game.pieces.find(item => item.id === intent.pieceId);
    if (!piece || piece.side !== player.side)
      return this.fail('NOT_YOUR_PIECE', '只能操作本方棋子。', player);
    const result = playMistMove(this.game, intent.pieceId, intent.to);
    if (!result.ok) return this.fail('ILLEGAL_MOVE', '这一步无法执行，请重新选择。', player);
    this.game = result.game;
    this.phase = result.game.status === 'finished' ? 'finished' : 'playing';
    this.drawOfferBy = null;
    if (this.phase === 'finished') this.persistFinishedGame('move', player.side);
    this.version++;
    const ack: MistAck<{ state: MistState }> = { ok: true, data: { state: this.state(player) } };
    playerRequests.set(intent.requestId, { fingerprint, ack });
    if (playerRequests.size > 200) playerRequests.delete(playerRequests.keys().next().value!);
    return { ok: true, changed: true, ack };
  }

  resign(tokenValue: unknown, socketId: string): ActionResult<{ state: MistState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'playing' || !this.game)
      return this.fail('GAME_NOT_PLAYING', '当前没有进行中的棋局。', found.player);
    this.game = resignMistGame(this.game, found.player.side);
    this.phase = 'finished';
    this.drawOfferBy = null;
    this.persistFinishedGame('resignation', found.player.side);
    this.version++;
    return this.stateResult(found.player);
  }

  offerDraw(tokenValue: unknown, socketId: string): ActionResult<{ state: MistState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'playing' || !this.game)
      return this.fail('GAME_NOT_PLAYING', '当前没有进行中的棋局。', found.player);
    if (this.players.length < 2) return this.fail('NO_OPPONENT', '当前没有可以回应提和的对手。', found.player);
    if (this.drawOfferBy) return this.fail('DRAW_ALREADY_OFFERED', '已经有一项提和申请正在等待回应。', found.player);
    this.drawOfferBy = found.player.side;
    this.version++;
    return this.stateResult(found.player);
  }

  respondDraw(tokenValue: unknown, acceptValue: unknown, socketId: string): ActionResult<{ state: MistState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'playing' || !this.game)
      return this.fail('GAME_NOT_PLAYING', '当前没有进行中的棋局。', found.player);
    if (!this.drawOfferBy) return this.fail('NO_DRAW_OFFER', '当前没有待回应的提和申请。', found.player);
    if (found.player.side === this.drawOfferBy)
      return this.fail('NOT_DRAW_RESPONDER', '提和申请需要由对手回应。', found.player);
    if (typeof acceptValue !== 'boolean') return this.fail('INVALID_REQUEST', '和棋回应格式不正确。', found.player);
    if (acceptValue) {
      this.game = drawMistGame(this.game);
      this.phase = 'finished';
      this.persistFinishedGame('draw', found.player.side);
    }
    this.drawOfferBy = null;
    this.version++;
    return this.stateResult(found.player);
  }

  leave(tokenValue: unknown, socketId: string): ActionResult {
    const found = this.findPlayer(tokenValue);
    if (!found.ok) return found;
    if (found.player.socketId && found.player.socketId !== socketId)
      return this.fail('NOT_ACTIVE_CONNECTION', '席位已在另一连接上使用。');
    const departedSocketId = found.player.socketId ?? undefined;
    this.removePlayer(found.player, 'exit');
    return { ok: true, changed: true, departedSocketId, ack: { ok: true, data: undefined } };
  }

  watch(socketId: string): MistAck<MistState> {
    if (!this.socketPlayers.has(socketId)) {
      this.lobbyWatchers.delete(socketId);
      this.observers.add(socketId);
    }
    return { ok: true, data: this.state(null, true) };
  }

  unwatch(socketId: string): void {
    this.observers.delete(socketId);
    if (!this.socketPlayers.has(socketId)) this.lobbyWatchers.add(socketId);
  }

  disconnect(socketId: string): boolean {
    this.lobbyWatchers.delete(socketId);
    this.observers.delete(socketId);
    const playerId = this.socketPlayers.get(socketId);
    if (!playerId) return false;
    const player = this.players.find(item => item.id === playerId);
    this.socketPlayers.delete(socketId);
    this.socketAccounts.delete(socketId);
    this.socketAvatars.delete(socketId);
    if (!player || player.socketId !== socketId) return false;
    player.socketId = null;
    player.online = false;
    player.ready = false;
    player.offlineUntil = this.now() + this.disconnectGraceMs;
    this.scheduleExpiry(player);
    this.version++;
    return true;
  }

  views(): Array<{ socketId: string; state: MistState }> {
    return [
      ...this.players.flatMap(player => player.socketId
        ? [{ socketId: player.socketId, state: this.state(player) }]
        : []),
      ...Array.from(this.observers, socketId => ({ socketId, state: this.state(null, true) })),
      ...Array.from(this.lobbyWatchers, socketId => ({ socketId, state: this.state(null) })),
    ];
  }

  dispose(): void {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
  }

  private stateResult(player: MistPlayer): ActionSuccess<{ state: MistState }> {
    return { ok: true, changed: true, ack: { ok: true, data: { state: this.state(player) } } };
  }

  private fail(code: string, error: string, player?: MistPlayer): ActionFailure {
    return {
      ok: false,
      ack: player
        ? { ok: false, code, error, state: this.state(player) }
        : { ok: false, code, error },
    };
  }

  private findPlayer(tokenValue: unknown): { ok: true; player: MistPlayer } | ActionFailure {
    const token = typeof tokenValue === 'string' ? tokenValue : '';
    const player = this.players.find(item => item.token === token);
    if (!player)
      return { ok: false, changed: false, ack: { ok: false, code: 'SESSION_NOT_FOUND', error: '席位凭证已失效，请重新进入。' } };
    return { ok: true, player };
  }

  private findActivePlayer(tokenValue: unknown, socketId: string):
    | { ok: true; player: MistPlayer }
    | ActionFailure {
    const found = this.findPlayer(tokenValue);
    if (!found.ok) return found;
    if (found.player.socketId !== socketId)
      return this.fail('NOT_ACTIVE_CONNECTION', '席位已在另一连接上使用。');
    if (!this.accountMatches(found.player, socketId))
      return this.fail('AUTH_MISMATCH', '当前账号与席位不一致。');
    return found;
  }

  private bindSocket(player: MistPlayer, socketId: string): void {
    player.socketId = socketId;
    this.socketPlayers.set(socketId, player.id);
  }

  private accountMatches(player: MistPlayer, socketId: string): boolean {
    return player.accountId === null || player.accountId === (this.socketAccounts.get(socketId) ?? null);
  }

  private receipt(player: MistPlayer): MistReceipt {
    return {
      gameId: MIST_CHESS_GAME_ID,
      playerId: player.id,
      reconnectToken: player.token,
      state: this.state(player),
    };
  }

  private state(self: MistPlayer | null, spectator = false): MistState {
    const players: MistPlayerView[] = this.players.map(player => ({
      id: player.id,
      nickname: player.nickname,
      avatar: player.avatar,
      identity: player.accountId ? 'account' : 'guest',
      side: player.side,
      ready: player.ready,
      online: player.online,
      offlineUntil: player.offlineUntil,
    }));
    return {
      gameId: MIST_CHESS_GAME_ID,
      phase: this.phase,
      version: this.version,
      round: this.round,
      players,
      game: self
        ? projectMistGame(this.game ?? newMistGame(), self.side)
        : spectator ? spectatorMistGame(this.game ?? newMistGame()) : null,
      drawOfferBy: this.drawOfferBy,
      selfId: self?.id ?? null,
      selfSide: self?.side ?? null,
    };
  }

  private removePlayer(player: MistPlayer, cause: 'exit' | 'timeout'): void {
    this.cancelExpiry(player.id);
    if (player.socketId) {
      this.socketPlayers.delete(player.socketId);
      this.socketAccounts.delete(player.socketId);
      this.socketAvatars.delete(player.socketId);
      this.lobbyWatchers.delete(player.socketId);
      this.observers.delete(player.socketId);
    }
    this.requests.delete(player.id);
    if (this.phase === 'playing' && this.game) {
      this.game = resignMistGame(this.game, player.side);
      this.phase = 'finished';
      this.drawOfferBy = null;
      this.persistFinishedGame(cause, player.side);
    }
    this.players = this.players.filter(item => item.id !== player.id);
    this.version++;
    if (!this.players.length) this.resetRoom();
  }

  private resetToLobby(): void {
    this.phase = 'lobby';
    this.round++;
    this.game = null;
    this.gameId = null;
    this.gameStartedAt = null;
    this.initialGame = null;
    this.startedParticipants = [];
    this.gamePersisted = false;
    this.drawOfferBy = null;
    this.requests.clear();
    for (const player of this.players) {
      player.ready = false;
      if (!player.online) {
        player.offlineUntil = this.now() + this.disconnectGraceMs;
        this.scheduleExpiry(player);
      }
    }
    this.version++;
  }

  private resetRoom(): void {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.phase = 'lobby';
    this.round++;
    this.game = null;
    this.gameId = null;
    this.gameStartedAt = null;
    this.initialGame = null;
    this.startedParticipants = [];
    this.gamePersisted = false;
    this.drawOfferBy = null;
    this.requests.clear();
    this.version++;
  }

  private scheduleExpiry(player: MistPlayer): void {
    this.cancelExpiry(player.id);
    const timer = setTimeout(() => {
      this.expiryTimers.delete(player.id);
      if (player.online || !this.players.includes(player)) return;
      this.removePlayer(player, 'timeout');
      this.onChanged(this);
    }, this.disconnectGraceMs);
    timer.unref?.();
    this.expiryTimers.set(player.id, timer);
  }

  private cancelExpiry(playerId: string): void {
    const timer = this.expiryTimers.get(playerId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(playerId);
  }

  private persistFinishedGame(reason: PersistReason, side?: ChineseSide): void {
    if (this.gamePersisted || !this.game || this.game.status !== 'finished'
      || !this.gameId || !this.gameStartedAt || !this.initialGame) return;
    const winner = this.game.winner;
    const participants: ArchivedMistParticipant[] = this.startedParticipants.map(player => ({
      ...player,
      result: winner === null ? 'draw' : winner === player.side ? 'won' : 'lost',
    }));
    const record: ArchivedMistGameRecord = {
      gameType: 'mist-chess',
      id: this.gameId,
      roomCode: MIST_CHESS_GAME_ID,
      round: this.round,
      startedAt: this.gameStartedAt,
      endedAt: this.now(),
      rulesVersion: this.game.rulesVersion,
      initialGame: structuredClone(this.initialGame),
      participants,
      moves: structuredClone(this.game.history),
      events: [{
        type: 'end',
        step: this.game.history.length,
        reason: reason === 'move' ? this.game.endReason ?? 'resignation' : reason,
        ...(side ? { side } : {}),
        winner,
      }],
      finalGame: structuredClone(this.game),
      endReason: reason === 'move' ? this.game.endReason ?? 'resignation' : reason,
      moveCount: this.game.history.length,
      winner,
    };
    try {
      this.onCompleted(record);
      this.gamePersisted = true;
    } catch (error) {
      console.error('Failed to archive completed mist chess game', error);
    }
  }
}
