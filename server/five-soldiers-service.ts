import { randomBytes, randomUUID } from 'node:crypto';
import {
  FIVE_SOLDIERS_GAME_ID,
  isFiveSide,
  newFiveGame,
  playFiveMove,
  resignFiveGame,
} from '../src/five-soldiers.ts';
import type {
  FiveAck,
  FiveGame,
  FiveMoveIntent,
  FivePhase,
  FivePlayerView,
  FiveReceipt,
  FiveSide,
  FiveState,
} from '../src/five-soldiers.ts';

interface FivePlayer {
  id: string;
  token: string;
  nickname: string;
  accountId: string | null;
  side: FiveSide;
  ready: boolean;
  online: boolean;
  offlineUntil: number | null;
  socketId: string | null;
}

interface StoredAck {
  fingerprint: string;
  ack: FiveAck<{ state: FiveState }>;
}

interface ActionSuccess<T = undefined> {
  ok: true;
  ack: FiveAck<T>;
  changed?: boolean;
  replacedSocketId?: string;
  departedSocketId?: string;
}

interface ActionFailure {
  ok: false;
  ack: FiveAck<never>;
  changed?: boolean;
}

type ActionResult<T = undefined> = ActionSuccess<T> | ActionFailure;

const cleanNickname = (value: unknown): string =>
  typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 16) : '';

export class FiveSoldiersService {
  private readonly onChanged: (service: FiveSoldiersService) => void;
  private readonly lobbyGraceMs: number;
  private readonly gameGraceMs: number;
  private readonly now: () => number;
  private phase: FivePhase = 'lobby';
  private version = 1;
  private round = 1;
  private game: FiveGame | null = null;
  private players: FivePlayer[] = [];
  private readonly socketPlayers = new Map<string, string>();
  private readonly socketAccounts = new Map<string, string | null>();
  private readonly observers = new Set<string>();
  private readonly requests = new Map<string, Map<string, StoredAck>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(onChanged: (service: FiveSoldiersService) => void,
    lobbyGraceMs = 60_000, gameGraceMs = 180_000, now: () => number = Date.now) {
    this.onChanged = onChanged;
    this.lobbyGraceMs = lobbyGraceMs;
    this.gameGraceMs = gameGraceMs;
    this.now = now;
  }

  setSocketAccount(socketId: string, accountId: string | null): void {
    this.socketAccounts.set(socketId, accountId);
  }

  join(nicknameValue: unknown, sideValue: unknown, socketId: string): ActionResult<FiveReceipt> {
    if (this.socketPlayers.has(socketId))
      return this.fail('ALREADY_SEATED', '你已经在这个房间中。');
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '当前对局已经开始，请等待下一局。');
    if (this.players.length >= 2) return this.fail('ROOM_FULL', '两个席位都已坐满。');
    if (!isFiveSide(sideValue)) return this.fail('INVALID_SIDE', '请选择红方或黑方。');
    if (this.players.some(player => player.side === sideValue))
      return this.fail('SIDE_TAKEN', `${sideValue === 'red' ? '红方' : '黑方'}席位已经被占用。`);

    const accountId = this.socketAccounts.get(socketId) ?? null;
    if (accountId && this.players.some(player => player.accountId === accountId))
      return this.fail('ACCOUNT_ALREADY_SEATED', '这个账号已经在五兵联盟房间中。');
    const nickname = cleanNickname(nicknameValue);
    if (!accountId && !nickname) return this.fail('NICKNAME_REQUIRED', '未登录玩家需要填写昵称。');

    const id = randomUUID();
    const player: FivePlayer = {
      id,
      token: randomBytes(32).toString('base64url'),
      nickname: nickname || '账号玩家',
      accountId,
      side: sideValue,
      ready: false,
      online: true,
      offlineUntil: null,
      socketId,
    };
    this.players.push(player);
    this.observers.delete(socketId);
    this.bindSocket(player, socketId);
    this.version++;
    return { ok: true, changed: true, ack: { ok: true, data: this.receipt(player) } };
  }

  inspect(): FiveAck<FiveState> {
    return { ok: true, data: this.state(null) };
  }

  resume(tokenValue: unknown, socketId: string): ActionResult<FiveReceipt> {
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
    this.observers.delete(socketId);
    this.bindSocket(found.player, socketId);
    this.version++;
    return { ok: true, changed: true, replacedSocketId, ack: { ok: true, data: this.receipt(found.player) } };
  }

  chooseSide(tokenValue: unknown, sideValue: unknown, socketId: string): ActionResult<{ state: FiveState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '开局后不能更换阵营。', found.player);
    if (!isFiveSide(sideValue)) return this.fail('INVALID_SIDE', '请选择红方或黑方。', found.player);
    if (this.players.some(player => player !== found.player && player.side === sideValue))
      return this.fail('SIDE_TAKEN', '这个阵营已经有玩家。', found.player);
    found.player.side = sideValue;
    found.player.ready = false;
    this.version++;
    return this.stateResult(found.player);
  }

  setReady(tokenValue: unknown, readyValue: unknown, socketId: string): ActionResult<{ state: FiveState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '对局已经开始。', found.player);
    found.player.ready = readyValue === true;
    this.version++;
    if (this.players.length === 2 && this.players.every(player => player.online && player.ready)) {
      this.game = newFiveGame();
      this.phase = 'playing';
      this.requests.clear();
      this.version++;
    }
    return this.stateResult(found.player);
  }

  rematch(tokenValue: unknown, socketId: string): ActionResult<{ state: FiveState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'finished') return this.fail('GAME_NOT_FINISHED', '本局尚未结束。', found.player);
    this.resetToLobby();
    return this.stateResult(found.player);
  }

  move(tokenValue: unknown, intentValue: unknown, socketId: string): ActionResult<{ state: FiveState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    const { player } = found;
    const intent = intentValue as Partial<FiveMoveIntent> | null;
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
    const result = playFiveMove(this.game, intent.pieceId, intent.to);
    if (!result.ok) return this.fail('ILLEGAL_MOVE', result.error, player);
    this.game = result.game;
    this.phase = result.game.status === 'finished' ? 'finished' : 'playing';
    this.version++;
    const ack: FiveAck<{ state: FiveState }> = { ok: true, data: { state: this.state(player) } };
    playerRequests.set(intent.requestId, { fingerprint, ack });
    if (playerRequests.size > 200) playerRequests.delete(playerRequests.keys().next().value!);
    return { ok: true, changed: true, ack };
  }

  resign(tokenValue: unknown, socketId: string): ActionResult<{ state: FiveState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'playing' || !this.game)
      return this.fail('GAME_NOT_PLAYING', '当前没有进行中的棋局。', found.player);
    this.game = resignFiveGame(this.game, found.player.side);
    this.phase = 'finished';
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

  watch(socketId: string): FiveAck<FiveState> {
    if (!this.socketPlayers.has(socketId)) this.observers.add(socketId);
    return this.inspect();
  }

  unwatch(socketId: string): void {
    this.observers.delete(socketId);
  }

  disconnect(socketId: string): boolean {
    this.observers.delete(socketId);
    const playerId = this.socketPlayers.get(socketId);
    if (!playerId) return false;
    const player = this.players.find(item => item.id === playerId);
    this.socketPlayers.delete(socketId);
    this.socketAccounts.delete(socketId);
    if (!player || player.socketId !== socketId) return false;
    this.removePlayer(player, 'exit');
    return true;
  }

  views(): Array<{ socketId: string; state: FiveState }> {
    return [
      ...this.players.flatMap(player => player.socketId
      ? [{ socketId: player.socketId, state: this.state(player) }]
      : []),
      ...Array.from(this.observers, socketId => ({ socketId, state: this.state(null) })),
    ];
  }

  dispose(): void {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
  }

  private stateResult(player: FivePlayer): ActionSuccess<{ state: FiveState }> {
    return { ok: true, changed: true, ack: { ok: true, data: { state: this.state(player) } } };
  }

  private fail(code: string, error: string, player?: FivePlayer): ActionFailure {
    return {
      ok: false,
      ack: player
        ? { ok: false, code, error, state: this.state(player) }
        : { ok: false, code, error },
    };
  }

  private findPlayer(tokenValue: unknown): { ok: true; player: FivePlayer } | ActionFailure {
    const token = typeof tokenValue === 'string' ? tokenValue : '';
    const player = this.players.find(item => item.token === token);
    if (!player) return { ok: false, changed: false, ack: { ok: false, code: 'SESSION_NOT_FOUND', error: '席位凭证已失效，请重新进入。' } };
    return { ok: true, player };
  }

  private findActivePlayer(tokenValue: unknown, socketId: string):
    | { ok: true; player: FivePlayer }
    | ActionFailure {
    const found = this.findPlayer(tokenValue);
    if (!found.ok) return found;
    if (found.player.socketId !== socketId)
      return this.fail('NOT_ACTIVE_CONNECTION', '席位已在另一连接上使用。');
    if (!this.accountMatches(found.player, socketId))
      return this.fail('AUTH_MISMATCH', '当前账号与席位不一致。');
    return found;
  }

  private bindSocket(player: FivePlayer, socketId: string): void {
    player.socketId = socketId;
    this.socketPlayers.set(socketId, player.id);
  }

  private accountMatches(player: FivePlayer, socketId: string): boolean {
    return player.accountId === null || player.accountId === (this.socketAccounts.get(socketId) ?? null);
  }

  private receipt(player: FivePlayer): FiveReceipt {
    return {
      gameId: FIVE_SOLDIERS_GAME_ID,
      playerId: player.id,
      reconnectToken: player.token,
      state: this.state(player),
    };
  }

  private state(self: FivePlayer | null): FiveState {
    const players: FivePlayerView[] = this.players.map(player => ({
      id: player.id,
      nickname: player.nickname,
      identity: player.accountId ? 'account' : 'guest',
      side: player.side,
      ready: player.ready,
      online: player.online,
      offlineUntil: player.offlineUntil,
    }));
    return {
      gameId: FIVE_SOLDIERS_GAME_ID,
      phase: this.phase,
      version: this.version,
      round: this.round,
      players,
      game: this.game ? structuredClone(this.game) : null,
      selfId: self?.id ?? null,
    };
  }

  private removePlayer(player: FivePlayer, cause: 'exit' | 'timeout'): void {
    this.cancelExpiry(player.id);
    if (player.socketId) {
      this.socketPlayers.delete(player.socketId);
      this.socketAccounts.delete(player.socketId);
    }
    this.requests.delete(player.id);
    if (this.phase === 'playing' && this.game) {
      this.game = resignFiveGame(this.game, player.side);
      this.phase = 'finished';
    }
    this.players = this.players.filter(item => item.id !== player.id);
    this.version++;
    if (!this.players.length) this.resetRoom();
    else if (cause === 'timeout' && this.players.every(item => !item.online)) {
      // The remaining expiry keeps its own timer and will clear the room if it also expires.
    }
  }

  private resetToLobby(): void {
    this.phase = 'lobby';
    this.round++;
    this.game = null;
    this.requests.clear();
    for (const player of this.players) {
      player.ready = false;
      if (!player.online) {
        player.offlineUntil = this.now() + this.lobbyGraceMs;
        this.scheduleExpiry(player);
      }
    }
    this.version++;
  }

  private resetRoom(): void {
    this.phase = 'lobby';
    this.round++;
    this.game = null;
    this.requests.clear();
    this.version++;
  }

  private scheduleExpiry(player: FivePlayer): void {
    this.cancelExpiry(player.id);
    const delay = this.phase === 'lobby' ? this.lobbyGraceMs : this.gameGraceMs;
    const timer = setTimeout(() => {
      this.expiryTimers.delete(player.id);
      if (player.online || !this.players.includes(player)) return;
      this.removePlayer(player, 'timeout');
      this.onChanged(this);
    }, delay);
    timer.unref?.();
    this.expiryTimers.set(player.id, timer);
  }

  private cancelExpiry(playerId: string): void {
    const timer = this.expiryTimers.get(playerId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(playerId);
  }
}
