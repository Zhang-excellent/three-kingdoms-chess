import { randomBytes, randomUUID } from 'node:crypto';
import {
  CHINESE_CHESS_GAME_ID,
  allLegalChineseMoves,
  chinesePieceAt,
  drawChineseGame,
  isChineseSide,
  isChineseKingInCheck,
  newChineseGame,
  playChineseMove,
  resignChineseGame,
} from '../src/chinese-chess.ts';
import {
  chineseUciHistory,
  initialChineseFen,
  parseUciBestMove,
} from '../src/chinese-chess-uci.ts';
import type {
  ChineseAck,
  ChineseGame,
  ChineseMoveIntent,
  ChinesePhase,
  ChinesePlayerView,
  ChineseReceipt,
  ChineseSide,
  ChineseState,
} from '../src/chinese-chess.ts';
import { PikafishError } from './pikafish-engine.ts';
import type { ChineseEngineClient } from './pikafish-engine.ts';

interface ChinesePlayer {
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
  ack: ChineseAck<{ state: ChineseState }>;
}

interface ActionSuccess<T = undefined> {
  ok: true;
  ack: ChineseAck<T>;
  changed?: boolean;
  replacedSocketId?: string;
  departedSocketId?: string;
}

interface ActionFailure {
  ok: false;
  ack: ChineseAck<never>;
  changed?: boolean;
}

type ActionResult<T = undefined> = ActionSuccess<T> | ActionFailure;

const cleanNickname = (value: unknown): string =>
  typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 16) : '';

export class ChineseChessService {
  private readonly onChanged: (service: ChineseChessService) => void;
  private readonly disconnectGraceMs: number;
  private readonly now: () => number;
  private readonly engine: ChineseEngineClient | null;
  private phase: ChinesePhase = 'lobby';
  private version = 1;
  private round = 1;
  private game: ChineseGame | null = null;
  private initialGame: ChineseGame | null = null;
  private gameToken: string | null = null;
  private drawOfferBy: ChineseSide | null = null;
  private engineSide: ChineseSide | null = null;
  private engineThinking = false;
  private engineError: string | null = null;
  private engineGeneration = 0;
  private players: ChinesePlayer[] = [];
  private readonly socketPlayers = new Map<string, string>();
  private readonly socketAccounts = new Map<string, string | null>();
  private readonly socketAvatars = new Map<string, string | null>();
  private readonly observers = new Set<string>();
  private readonly requests = new Map<string, Map<string, StoredAck>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(onChanged: (service: ChineseChessService) => void,
    disconnectGraceMs = 60_000, now: () => number = Date.now,
    engine: ChineseEngineClient | null = null) {
    this.onChanged = onChanged;
    this.disconnectGraceMs = disconnectGraceMs;
    this.now = now;
    this.engine = engine;
  }

  setSocketAccount(socketId: string, accountId: string | null, avatar: string | null = null): void {
    this.socketAccounts.set(socketId, accountId);
    this.socketAvatars.set(socketId, avatar);
  }

  join(nicknameValue: unknown, sideValue: unknown, socketId: string): ActionResult<ChineseReceipt> {
    if (this.socketPlayers.has(socketId)) return this.fail('ALREADY_SEATED', '你已经在这个房间中。');
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '当前对局已经开始，请等待下一局。');
    if (this.players.length >= 2) return this.fail('ROOM_FULL', '两个席位都已坐满。');
    if (!isChineseSide(sideValue)) return this.fail('INVALID_SIDE', '请选择红方或黑方。');
    if (this.engineSide === sideValue)
      return this.fail('SIDE_TAKEN', '这个席位已经由神秘老人占用。');
    if (this.players.some(player => player.side === sideValue))
      return this.fail('SIDE_TAKEN', `${sideValue === 'red' ? '红方' : '黑方'}席位已经被占用。`);
    const accountId = this.socketAccounts.get(socketId) ?? null;
    if (accountId && this.players.some(player => player.accountId === accountId))
      return this.fail('ACCOUNT_ALREADY_SEATED', '这个账号已经在中国象棋房间中。');
    const nickname = cleanNickname(nicknameValue);
    if (!accountId && !nickname) return this.fail('NICKNAME_REQUIRED', '未登录玩家需要填写昵称。');
    const id = randomUUID();
    const player: ChinesePlayer = {
      id,
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
    this.observers.delete(socketId);
    this.bindSocket(player, socketId);
    this.version++;
    return { ok: true, changed: true, ack: { ok: true, data: this.receipt(player) } };
  }

  inspect(): ChineseAck<ChineseState> {
    return { ok: true, data: this.state(null) };
  }

  resume(tokenValue: unknown, socketId: string): ActionResult<ChineseReceipt> {
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

  chooseSide(tokenValue: unknown, sideValue: unknown, socketId: string): ActionResult<{ state: ChineseState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '开局后不能更换阵营。', found.player);
    if (!isChineseSide(sideValue)) return this.fail('INVALID_SIDE', '请选择红方或黑方。', found.player);
    if (this.engineSide === sideValue)
      return this.fail('SIDE_TAKEN', '这个阵营已经由神秘老人占用。', found.player);
    if (this.players.some(player => player !== found.player && player.side === sideValue))
      return this.fail('SIDE_TAKEN', '这个阵营已经有玩家。', found.player);
    found.player.side = sideValue;
    found.player.ready = false;
    this.version++;
    return this.stateResult(found.player);
  }

  selectEngine(tokenValue: unknown, sideValue: unknown, socketId: string): ActionResult<{ state: ChineseState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '开局后不能切换软件对手。', found.player);
    if (!isChineseSide(sideValue)) return this.fail('INVALID_SIDE', '请选择要切换的席位。', found.player);
    if (sideValue === found.player.side) return this.fail('INVALID_SIDE', '软件对手不能放在自己的席位。', found.player);
    if (!this.engine?.configured)
      return this.fail('ENGINE_UNAVAILABLE', '神秘老人暂不可用。', found.player);
    if (this.players.length >= 2)
      return this.fail('ROOM_FULL', '对手席位已经有真人玩家。', found.player);
    if (this.players.some(player => player.side === sideValue))
      return this.fail('SIDE_TAKEN', '这个席位已经有真人玩家。', found.player);
    if (this.engineSide && this.engineSide !== sideValue)
      return this.fail('ENGINE_SEATED', '神秘老人已经在另一个席位。', found.player);
    this.engineSide = sideValue;
    this.engineThinking = false;
    this.engineError = null;
    found.player.ready = false;
    this.version++;
    return this.stateResult(found.player);
  }

  removeEngine(tokenValue: unknown, socketId: string): ActionResult<{ state: ChineseState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '开局后不能切回等待棋友。', found.player);
    if (!this.engineSide) return this.fail('ENGINE_NOT_SEATED', '当前没有软件对手。', found.player);
    this.engineSide = null;
    this.engineThinking = false;
    this.engineError = null;
    found.player.ready = false;
    this.version++;
    return this.stateResult(found.player);
  }

  retryEngine(tokenValue: unknown, socketId: string): ActionResult<{ state: ChineseState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'playing' || !this.game || !this.engineSide || this.game.turn !== this.engineSide)
      return this.fail('ENGINE_NOT_THINKING', '现在不需要神秘老人计算。', found.player);
    if (this.engineThinking) return this.fail('ENGINE_BUSY', '神秘老人正在思考。', found.player);
    this.engineError = null;
    this.beginEngineTurn();
    return this.stateResult(found.player);
  }

  setReady(tokenValue: unknown, readyValue: unknown, socketId: string): ActionResult<{ state: ChineseState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'lobby') return this.fail('GAME_STARTED', '对局已经开始。', found.player);
    found.player.ready = readyValue === true;
    this.version++;
    if (this.canStartGame()) {
      this.game = newChineseGame();
      this.initialGame = structuredClone(this.game);
      this.gameToken = randomUUID();
      this.phase = 'playing';
      this.drawOfferBy = null;
      this.requests.clear();
      this.version++;
      if (this.isEngineTurn()) this.beginEngineTurn();
    }
    return this.stateResult(found.player);
  }

  rematch(tokenValue: unknown, socketId: string): ActionResult<{ state: ChineseState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'finished') return this.fail('GAME_NOT_FINISHED', '本局尚未结束。', found.player);
    this.resetToLobby();
    return this.stateResult(found.player);
  }

  move(tokenValue: unknown, intentValue: unknown, socketId: string): ActionResult<{ state: ChineseState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    const { player } = found;
    const intent = intentValue as Partial<ChineseMoveIntent> | null;
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
    const result = playChineseMove(this.game, intent.pieceId, intent.to);
    if (!result.ok) return this.fail('ILLEGAL_MOVE', result.error, player);
    this.game = result.game;
    this.phase = result.game.status === 'finished' ? 'finished' : 'playing';
    this.drawOfferBy = null;
    this.engineGeneration++;
    this.engineThinking = false;
    this.engineError = null;
    this.version++;
    if (this.phase === 'playing' && this.isEngineTurn()) this.beginEngineTurn();
    const ack: ChineseAck<{ state: ChineseState }> = { ok: true, data: { state: this.state(player) } };
    playerRequests.set(intent.requestId, { fingerprint, ack });
    if (playerRequests.size > 200) playerRequests.delete(playerRequests.keys().next().value!);
    return { ok: true, changed: true, ack };
  }

  resign(tokenValue: unknown, socketId: string): ActionResult<{ state: ChineseState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'playing' || !this.game)
      return this.fail('GAME_NOT_PLAYING', '当前没有进行中的棋局。', found.player);
    this.game = resignChineseGame(this.game, found.player.side);
    this.phase = 'finished';
    this.drawOfferBy = null;
    this.engineGeneration++;
    this.engineThinking = false;
    this.engineError = null;
    this.version++;
    return this.stateResult(found.player);
  }

  offerDraw(tokenValue: unknown, socketId: string): ActionResult<{ state: ChineseState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'playing' || !this.game)
      return this.fail('GAME_NOT_PLAYING', '当前没有进行中的棋局。', found.player);
    if (this.engineSide) return this.fail('ENGINE_NO_DRAW', '人机对局暂不支持提和。', found.player);
    if (this.players.length < 2) return this.fail('NO_OPPONENT', '当前没有可以回应提和的对手。', found.player);
    if (this.drawOfferBy) return this.fail('DRAW_ALREADY_OFFERED', '已经有一项提和申请正在等待回应。', found.player);
    this.drawOfferBy = found.player.side;
    this.version++;
    return this.stateResult(found.player);
  }

  respondDraw(tokenValue: unknown, acceptValue: unknown, socketId: string): ActionResult<{ state: ChineseState }> {
    const found = this.findActivePlayer(tokenValue, socketId);
    if (!found.ok) return found;
    if (this.phase !== 'playing' || !this.game)
      return this.fail('GAME_NOT_PLAYING', '当前没有进行中的棋局。', found.player);
    if (!this.drawOfferBy) return this.fail('NO_DRAW_OFFER', '当前没有待回应的提和申请。', found.player);
    if (found.player.side === this.drawOfferBy)
      return this.fail('NOT_DRAW_RESPONDER', '提和申请需要由对手回应。', found.player);
    if (typeof acceptValue !== 'boolean') return this.fail('INVALID_REQUEST', '和棋回应格式不正确。', found.player);
    if (acceptValue) {
      this.game = drawChineseGame(this.game);
      this.phase = 'finished';
      this.engineGeneration++;
      this.engineThinking = false;
      this.engineError = null;
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

  watch(socketId: string): ChineseAck<ChineseState> {
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

  views(): Array<{ socketId: string; state: ChineseState }> {
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
    this.engineGeneration++;
    this.engineThinking = false;
    this.engine?.dispose();
  }

  private canStartGame(): boolean {
    if (this.phase !== 'lobby' || !this.players.length || !this.players.every(player => player.online && player.ready))
      return false;
    if (this.engineSide) return this.players.length === 1;
    return this.players.length === 2;
  }

  private isEngineTurn(): boolean {
    return this.phase === 'playing' && !!this.game && !!this.engineSide && this.game.turn === this.engineSide;
  }

  private beginEngineTurn(): void {
    if (!this.isEngineTurn() || !this.engine?.configured || !this.game || !this.engineSide
      || !this.gameToken || !this.initialGame || this.engineThinking) return;
    const generation = ++this.engineGeneration;
    const gameToken = this.gameToken;
    const expectedHistoryLength = this.game.history.length;
    const engineSide = this.engineSide;
    const initialFen = initialChineseFen();
    const moves = chineseUciHistory(this.game);
    this.engineThinking = true;
    this.engineError = null;
    this.version++;
    void this.engine.bestMove({ initialFen, moves }).then(bestMove => {
      if (generation !== this.engineGeneration || !this.game || this.gameToken !== gameToken
        || this.phase !== 'playing' || this.game.turn !== engineSide
        || this.game.history.length !== expectedHistoryLength) return;
      if (!bestMove) {
        if (allLegalChineseMoves(this.game, engineSide).length === 0) {
          const winner = engineSide === 'red' ? 'black' : 'red';
          this.game.status = 'finished';
          this.game.winner = winner;
          this.game.endReason = isChineseKingInCheck(this.game.pieces, engineSide) ? 'checkmate' : 'stalemate';
          this.phase = 'finished';
          this.engineThinking = false;
          this.version++;
          this.onChanged(this);
          return;
        }
        this.failEngineTurn(generation, new PikafishError('PROTOCOL', 'Pikafish returned no move in a live position.'));
        return;
      }
      const parsed = parseUciBestMove(bestMove);
      if (!parsed) {
        this.failEngineTurn(generation, new PikafishError('PROTOCOL', `Invalid Pikafish bestmove: ${bestMove}`));
        return;
      }
      const piece = chinesePieceAt(this.game.pieces, parsed.from);
      if (!piece || piece.side !== engineSide) {
        this.failEngineTurn(generation, new PikafishError('PROTOCOL', `Pikafish selected an invalid piece: ${bestMove}`));
        return;
      }
      const result = playChineseMove(this.game, piece.id, parsed.to);
      if (!result.ok) {
        this.failEngineTurn(generation, new PikafishError('PROTOCOL', `Illegal Pikafish move ${bestMove}: ${result.error}`));
        return;
      }
      this.game = result.game;
      this.phase = result.game.status === 'finished' ? 'finished' : 'playing';
      this.engineThinking = false;
      this.engineError = null;
      this.version++;
      this.onChanged(this);
    }).catch(error => this.failEngineTurn(generation, error));
  }

  private failEngineTurn(generation: number, error: unknown): void {
    if (generation !== this.engineGeneration) return;
    const code = error instanceof PikafishError ? error.code : 'PROTOCOL';
    this.engineThinking = false;
    this.engineError = code === 'BUSY' ? '神秘老人繁忙' : '神秘老人暂不可用';
    this.version++;
    console.error(`[Chinese engine] ${code}: ${error instanceof Error ? error.message : String(error)}`);
    this.onChanged(this);
  }

  private stateResult(player: ChinesePlayer): ActionSuccess<{ state: ChineseState }> {
    return { ok: true, changed: true, ack: { ok: true, data: { state: this.state(player) } } };
  }

  private fail(code: string, error: string, player?: ChinesePlayer): ActionFailure {
    return {
      ok: false,
      ack: player
        ? { ok: false, code, error, state: this.state(player) }
        : { ok: false, code, error },
    };
  }

  private findPlayer(tokenValue: unknown): { ok: true; player: ChinesePlayer } | ActionFailure {
    const token = typeof tokenValue === 'string' ? tokenValue : '';
    const player = this.players.find(item => item.token === token);
    if (!player) return { ok: false, changed: false, ack: { ok: false, code: 'SESSION_NOT_FOUND', error: '席位凭证已失效，请重新进入。' } };
    return { ok: true, player };
  }

  private findActivePlayer(tokenValue: unknown, socketId: string):
    | { ok: true; player: ChinesePlayer }
    | ActionFailure {
    const found = this.findPlayer(tokenValue);
    if (!found.ok) return found;
    if (found.player.socketId !== socketId)
      return this.fail('NOT_ACTIVE_CONNECTION', '席位已在另一连接上使用。');
    if (!this.accountMatches(found.player, socketId))
      return this.fail('AUTH_MISMATCH', '当前账号与席位不一致。');
    return found;
  }

  private bindSocket(player: ChinesePlayer, socketId: string): void {
    player.socketId = socketId;
    this.socketPlayers.set(socketId, player.id);
  }

  private accountMatches(player: ChinesePlayer, socketId: string): boolean {
    return player.accountId === null || player.accountId === (this.socketAccounts.get(socketId) ?? null);
  }

  private receipt(player: ChinesePlayer): ChineseReceipt {
    return {
      gameId: CHINESE_CHESS_GAME_ID,
      playerId: player.id,
      reconnectToken: player.token,
      state: this.state(player),
    };
  }

  private state(self: ChinesePlayer | null): ChineseState {
    const players: ChinesePlayerView[] = this.players.map(player => ({
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
      gameId: CHINESE_CHESS_GAME_ID,
      phase: this.phase,
      version: this.version,
      round: this.round,
      players,
      game: this.game ? structuredClone(this.game) : null,
      drawOfferBy: this.drawOfferBy,
      selfId: self?.id ?? null,
      engineSide: this.engineSide,
      engineThinking: this.engineThinking,
      engineError: this.engineError,
    };
  }

  private removePlayer(player: ChinesePlayer, cause: 'exit' | 'timeout'): void {
    this.cancelExpiry(player.id);
    this.engineGeneration++;
    this.engineThinking = false;
    this.engineError = null;
    if (player.socketId) {
      this.socketPlayers.delete(player.socketId);
      this.socketAccounts.delete(player.socketId);
      this.socketAvatars.delete(player.socketId);
    }
    this.requests.delete(player.id);
    if (this.phase === 'playing' && this.game) {
      this.game = resignChineseGame(this.game, player.side);
      this.phase = 'finished';
      this.drawOfferBy = null;
    }
    this.players = this.players.filter(item => item.id !== player.id);
    this.version++;
    if (!this.players.length) this.resetRoom();
    else if (cause === 'timeout' && this.players.every(item => !item.online)) {
      // Remaining players keep their independent grace timers.
    }
  }

  private resetToLobby(): void {
    this.engineGeneration++;
    this.phase = 'lobby';
    this.round++;
    this.game = null;
    this.initialGame = null;
    this.gameToken = null;
    this.drawOfferBy = null;
    this.engineThinking = false;
    this.engineError = null;
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
    this.engineGeneration++;
    this.phase = 'lobby';
    this.round++;
    this.game = null;
    this.initialGame = null;
    this.gameToken = null;
    this.drawOfferBy = null;
    this.engineSide = null;
    this.engineThinking = false;
    this.engineError = null;
    this.requests.clear();
    this.version++;
  }

  private scheduleExpiry(player: ChinesePlayer): void {
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
}
