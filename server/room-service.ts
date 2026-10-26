import { randomBytes, randomUUID } from 'node:crypto';
import { ORDER, newGame, playMove, resignFaction } from '../src/game.ts';
import type { Faction, Game, Point } from '../src/game.ts';
import type { ClientAck, MoveIntent, RoomPhase, RoomPlayerView, RoomView, SessionReceipt } from '../src/online.ts';

interface Player {
  id: string;
  token: string;
  nickname: string;
  faction: Faction | null;
  ready: boolean;
  online: boolean;
  offlineUntil: number | null;
  socketId: string | null;
}

interface StoredAck {
  fingerprint: string;
  ack: ClientAck<{ state: RoomView }>;
}

interface Room {
  code: string;
  phase: RoomPhase;
  version: number;
  players: Player[];
  game: Game | null;
  requests: Map<string, Map<string, StoredAck>>;
}

interface RoomActionResult<T = undefined> {
  ack: ClientAck<T>;
  room?: Room;
  replacedSocketId?: string;
  departedSocketId?: string;
}

const cleanNickname = (value: unknown): string => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 16) : '';
const cleanCode = (value: unknown): string => typeof value === 'string' ? value.trim().toUpperCase() : '';
const isFaction = (value: unknown): value is Faction => ORDER.includes(value as Faction);
const isPoint = (value: unknown): value is Point => !!value && typeof value === 'object'
  && Number.isInteger((value as Point).x) && Number.isInteger((value as Point).y);

export class RoomService {
  private readonly rooms = new Map<string, Room>();
  private readonly tokenRoom = new Map<string, string>();
  private readonly socketRoom = new Map<string, { code: string; playerId: string }>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly onRoomChanged: (room: Room) => void;
  private readonly lobbyGraceMs: number;

  constructor(onRoomChanged: (room: Room) => void = () => {}, lobbyGraceMs = 60_000) {
    this.onRoomChanged = onRoomChanged;
    this.lobbyGraceMs = lobbyGraceMs;
  }

  createRoom(nicknameValue: unknown, socketId: string): RoomActionResult<SessionReceipt> {
    const existing = this.playerForSocket(socketId);
    if (existing) return { room: existing.room, ack: { ok: true, data: this.receipt(existing.room, existing.player) } };
    const nickname = cleanNickname(nicknameValue);
    if (!nickname) return { ack: { ok: false, code: 'INVALID_NICKNAME', error: '请输入 1～16 个字符的昵称。' } };
    let code = '';
    do code = randomBytes(3).toString('hex').toUpperCase(); while (this.rooms.has(code));
    const player = this.newPlayer(nickname, socketId);
    const room: Room = { code, phase: 'lobby', version: 1, players: [player], game: null, requests: new Map() };
    this.rooms.set(code, room); this.tokenRoom.set(player.token, code);
    this.socketRoom.set(socketId, { code, playerId: player.id });
    return { room, ack: { ok: true, data: this.receipt(room, player) } };
  }

  joinRoom(codeValue: unknown, nicknameValue: unknown, socketId: string): RoomActionResult<SessionReceipt> {
    const code = cleanCode(codeValue), nickname = cleanNickname(nicknameValue), room = this.rooms.get(code);
    const existing = this.playerForSocket(socketId);
    if (existing) return existing.room.code === code
      ? { room: existing.room, ack: { ok: true, data: this.receipt(existing.room, existing.player) } }
      : { ack: { ok: false, code: 'ALREADY_IN_ROOM', error: `请先退出房间 ${existing.room.code}。` } };
    if (!room) return { ack: { ok: false, code: 'ROOM_NOT_FOUND', error: '没有找到这个房间，请检查房间号。' } };
    if (!nickname) return { ack: { ok: false, code: 'INVALID_NICKNAME', error: '请输入 1～16 个字符的昵称。' } };
    if (room.phase !== 'lobby') return { ack: { ok: false, code: 'GAME_STARTED', error: '该房间已经开局，不能再加入。' } };
    if (room.players.length >= 3) return { ack: { ok: false, code: 'ROOM_FULL', error: '房间已满，最多三名玩家。' } };
    const player = this.newPlayer(nickname, socketId);
    room.players.push(player); room.version++; this.tokenRoom.set(player.token, room.code);
    this.socketRoom.set(socketId, { code, playerId: player.id });
    return { room, ack: { ok: true, data: this.receipt(room, player) } };
  }

  resumeRoom(codeValue: unknown, tokenValue: unknown, socketId: string): RoomActionResult<SessionReceipt> {
    const code = cleanCode(codeValue), token = typeof tokenValue === 'string' ? tokenValue : '';
    const existing = this.playerForSocket(socketId);
    if (existing && existing.player.token !== token)
      return { ack: { ok: false, code: 'ALREADY_IN_ROOM', error: `请先退出房间 ${existing.room.code}。` } };
    const room = this.rooms.get(code);
    if (!room || this.tokenRoom.get(token) !== code) return { ack: { ok: false, code: 'SESSION_NOT_FOUND', error: '重连凭证已失效，房间可能因服务器重启而丢失。' } };
    const player = room.players.find(item => item.token === token);
    if (!player) return { ack: { ok: false, code: 'SESSION_NOT_FOUND', error: '无法恢复这个席位。' } };
    const replacedSocketId = player.socketId && player.socketId !== socketId ? player.socketId : undefined;
    const changed = !player.online || player.socketId !== socketId;
    if (replacedSocketId) this.socketRoom.delete(replacedSocketId);
    this.cancelExpiry(player.id);
    player.online = true; player.socketId = socketId; player.offlineUntil = null;
    this.socketRoom.set(socketId, { code, playerId: player.id });
    if (changed) room.version++;
    return { room, replacedSocketId, ack: { ok: true, data: this.receipt(room, player) } };
  }

  chooseFaction(codeValue: unknown, tokenValue: unknown, factionValue: unknown, socketId?: string): RoomActionResult<{ state: RoomView }> {
    const found = this.findPlayer(codeValue, tokenValue, socketId);
    if (!found.ok) return { ack: found.ack };
    const { room, player } = found;
    if (room.phase !== 'lobby') return { ack: { ok: false, code: 'GAME_STARTED', error: '对局已经开始，不能更换阵营。', state: this.view(room, player) } };
    if (!isFaction(factionValue)) return { ack: { ok: false, code: 'INVALID_FACTION', error: '请选择魏、蜀或吴。' } };
    if (room.players.some(item => item !== player && item.faction === factionValue))
      return { ack: { ok: false, code: 'FACTION_TAKEN', error: '该阵营已被其他玩家选择。', state: this.view(room, player) } };
    player.faction = factionValue; player.ready = false; room.version++;
    return { room, ack: { ok: true, data: { state: this.view(room, player) } } };
  }

  setReady(codeValue: unknown, tokenValue: unknown, readyValue: unknown, socketId?: string): RoomActionResult<{ state: RoomView }> {
    const found = this.findPlayer(codeValue, tokenValue, socketId);
    if (!found.ok) return { ack: found.ack };
    const { room, player } = found;
    if (room.phase !== 'lobby') return { ack: { ok: false, code: 'GAME_STARTED', error: '对局已经开始。', state: this.view(room, player) } };
    if (!player.faction) return { ack: { ok: false, code: 'FACTION_REQUIRED', error: '请先选择阵营。', state: this.view(room, player) } };
    if (typeof readyValue !== 'boolean') return { ack: { ok: false, code: 'INVALID_READY', error: '准备状态无效。' } };
    player.ready = readyValue; room.version++;
    if (room.players.length === 3 && room.players.every(item => item.online && item.faction && item.ready)
      && new Set(room.players.map(item => item.faction)).size === 3) {
      room.game = newGame(); room.phase = 'playing'; room.version++;
    }
    return { room, ack: { ok: true, data: { state: this.view(room, player) } } };
  }

  submitMove(codeValue: unknown, tokenValue: unknown, intent: unknown, socketId?: string): Promise<RoomActionResult<{ state: RoomView }>> {
    const code = cleanCode(codeValue);
    return this.serial(code, () => this.processMove(code, tokenValue, intent, socketId));
  }

  resignRoom(codeValue: unknown, tokenValue: unknown, socketId: string): Promise<RoomActionResult<{ state: RoomView }>> {
    const code = cleanCode(codeValue);
    return this.serial(code, () => {
      const found = this.findPlayer(code, tokenValue, socketId);
      if (!found.ok) return { ack: found.ack };
      const { room, player } = found;
      if (room.phase !== 'playing' || !room.game || !player.faction || room.game.eliminated.includes(player.faction))
        return { ack: { ok: false, code: 'CANNOT_RESIGN', error: '该阵营已出局或对局已结束。', state: this.view(room, player) } };
      const result = resignFaction(room.game, player.faction);
      if (!result.ok) return { ack: { ok: false, code: 'CANNOT_RESIGN', error: result.error, state: this.view(room, player) } };
      room.game = result.game;
      room.phase = room.game.status === 'finished' ? 'finished' : 'playing';
      room.version++;
      return { room, ack: { ok: true, data: { state: this.view(room, player) } } };
    });
  }

  leaveRoom(codeValue: unknown, tokenValue: unknown, socketId: string): Promise<RoomActionResult> {
    const code = cleanCode(codeValue);
    return this.serial(code, () => {
      const found = this.findPlayer(code, tokenValue);
      if (!found.ok) return { ack: found.ack };
      const { room, player } = found;
      if (player.socketId && player.socketId !== socketId)
        return { ack: { ok: false, code: 'NOT_ACTIVE_CONNECTION', error: '席位已在另一连接上使用，请重新同步。' } };
      if (room.phase === 'playing' && room.game && player.faction && !room.game.eliminated.includes(player.faction)) {
        const result = resignFaction(room.game, player.faction);
        if (result.ok) {
          room.game = result.game;
          room.phase = room.game.status === 'finished' ? 'finished' : 'playing';
        }
      }
      const departedSocketId = player.socketId ?? undefined;
      this.removePlayer(room, player);
      return { room, departedSocketId, ack: { ok: true, data: undefined } };
    });
  }

  releaseOffline(codeValue: unknown, tokenValue: unknown, targetPlayerId: unknown,
    socketId: string): RoomActionResult<{ state: RoomView }> {
    const found = this.findPlayer(codeValue, tokenValue, socketId);
    if (!found.ok) return { ack: found.ack };
    const { room, player } = found;
    if (room.phase !== 'lobby') return { ack: { ok: false, code: 'GAME_STARTED', error: '开局后不能移除其他玩家。', state: this.view(room, player) } };
    const target = room.players.find(item => item.id === targetPlayerId);
    if (!target || target === player || target.online)
      return { ack: { ok: false, code: 'NOT_OFFLINE', error: '只能释放等待区内其他玩家的离线席位。', state: this.view(room, player) } };
    this.removePlayer(room, target);
    return { room, ack: { ok: true, data: { state: this.view(room, player) } } };
  }

  disconnect(socketId: string): Room | undefined {
    const found = this.playerForSocket(socketId);
    this.socketRoom.delete(socketId);
    if (!found || found.player.socketId !== socketId) return undefined;
    const { room, player } = found;
    player.online = false; player.socketId = null; player.ready = false;
    player.offlineUntil = room.phase === 'lobby' ? Date.now() + this.lobbyGraceMs : null;
    room.version++;
    if (room.phase === 'lobby') this.scheduleExpiry(room, player);
    return room;
  }

  views(room: Room): Array<{ socketId: string; state: RoomView }> {
    return room.players.flatMap(player => player.socketId ? [{ socketId: player.socketId, state: this.view(room, player) }] : []);
  }

  getRoom(code: string): Room | undefined { return this.rooms.get(cleanCode(code)); }

  private processMove(code: string, tokenValue: unknown, intentValue: unknown, socketId?: string): RoomActionResult<{ state: RoomView }> {
    const found = this.findPlayer(code, tokenValue, socketId);
    if (!found.ok) return { ack: found.ack };
    const { room, player } = found;
    const intent = intentValue as Partial<MoveIntent> | null;
    if (!intent || typeof intent.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(intent.requestId)
      || !Number.isInteger(intent.version) || typeof intent.pieceId !== 'string' || !isPoint(intent.to))
      return { ack: { ok: false, code: 'INVALID_REQUEST', error: '走棋请求格式不正确。', state: this.view(room, player) } };
    const fingerprint = JSON.stringify([intent.version, intent.pieceId, intent.to.x, intent.to.y]);
    const playerRequests = room.requests.get(player.id) ?? new Map<string, StoredAck>();
    room.requests.set(player.id, playerRequests);
    const stored = playerRequests.get(intent.requestId);
    if (stored) {
      if (stored.fingerprint !== fingerprint) return { ack: { ok: false, code: 'REQUEST_ID_REUSED', error: '请求编号已用于另一手棋，请重新同步。', state: this.view(room, player) } };
      return { ack: stored.ack.ok ? { ok: true, data: { state: this.view(room, player) } } : stored.ack };
    }
    const reject = (codeName: string, error: string): RoomActionResult<{ state: RoomView }> => ({
      ack: { ok: false, code: codeName, error, state: this.view(room, player) }, room,
    });
    if (room.phase !== 'playing' || !room.game) return reject('GAME_NOT_PLAYING', '棋局尚未开始或已经结束。');
    if (intent.version !== room.version) return reject('STALE_VERSION', '局面已更新，本端正在重新同步，请再试一次。');
    if (!player.faction || player.faction !== room.game.turn) return reject('NOT_YOUR_TURN', '当前不是你的阵营行棋。');
    const piece = room.game.pieces.find(item => item.id === intent.pieceId);
    if (!piece || piece.faction !== player.faction) return reject('NOT_YOUR_PIECE', '只能操作你所选择阵营的棋子。');
    const result = playMove(room.game, intent.pieceId, intent.to);
    if (!result.ok) return reject('ILLEGAL_MOVE', result.error);
    room.game = result.game; room.phase = room.game.status === 'finished' ? 'finished' : 'playing'; room.version++;
    const ack: ClientAck<{ state: RoomView }> = { ok: true, data: { state: this.view(room, player) } };
    playerRequests.set(intent.requestId, { fingerprint, ack });
    if (playerRequests.size > 200) playerRequests.delete(playerRequests.keys().next().value!);
    return { room, ack };
  }

  private findPlayer(codeValue: unknown, tokenValue: unknown, socketId?: string):
    | { ok: true; room: Room; player: Player }
    | { ok: false; ack: ClientAck<never> } {
    const code = cleanCode(codeValue), token = typeof tokenValue === 'string' ? tokenValue : '', room = this.rooms.get(code);
    const player = room?.players.find(item => item.token === token);
    if (!room || !player) return { ok: false, ack: { ok: false, code: 'SESSION_NOT_FOUND', error: '席位凭证无效，请重新加入房间。' } };
    if (socketId !== undefined && player.socketId !== socketId)
      return { ok: false, ack: { ok: false, code: 'NOT_ACTIVE_CONNECTION', error: '席位已在另一连接上使用，请重新同步。' } };
    return { ok: true, room, player };
  }

  private playerForSocket(socketId: string): { room: Room; player: Player } | null {
    const binding = this.socketRoom.get(socketId);
    const room = binding && this.rooms.get(binding.code);
    const player = room?.players.find(item => item.id === binding?.playerId);
    return room && player ? { room, player } : null;
  }

  private cancelExpiry(playerId: string): void {
    const timer = this.expiryTimers.get(playerId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(playerId);
  }

  private scheduleExpiry(room: Room, player: Player): void {
    this.cancelExpiry(player.id);
    const timer = setTimeout(() => {
      this.expiryTimers.delete(player.id);
      if (this.rooms.get(room.code) !== room || room.phase !== 'lobby' || player.online || !room.players.includes(player)) return;
      this.removePlayer(room, player);
      this.onRoomChanged(room);
    }, this.lobbyGraceMs);
    timer.unref?.();
    this.expiryTimers.set(player.id, timer);
  }

  private removePlayer(room: Room, player: Player): void {
    this.cancelExpiry(player.id);
    this.tokenRoom.delete(player.token);
    room.requests.delete(player.id);
    if (player.socketId) this.socketRoom.delete(player.socketId);
    room.players = room.players.filter(item => item !== player);
    room.version++;
    if (!room.players.length) this.rooms.delete(room.code);
  }

  private newPlayer(nickname: string, socketId: string): Player {
    return { id: randomUUID(), token: randomBytes(32).toString('base64url'), nickname, faction: null, ready: false, online: true, offlineUntil: null, socketId };
  }

  private receipt(room: Room, player: Player): SessionReceipt {
    return { roomCode: room.code, playerId: player.id, reconnectToken: player.token, state: this.view(room, player) };
  }

  private view(room: Room, self: Player): RoomView {
    const players: RoomPlayerView[] = room.players.map(({ id, nickname, faction, ready, online, offlineUntil }) =>
      ({ id, nickname, faction, ready, online, offlineUntil }));
    return { code: room.code, phase: room.phase, version: room.version, players, game: room.game ? structuredClone(room.game) : null, selfId: self.id };
  }

  private serial<T>(code: string, action: () => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(code) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const queued = next.finally(() => { if (this.queues.get(code) === queued) this.queues.delete(code); });
    this.queues.set(code, queued);
    return next;
  }
}

export type InternalRoom = NonNullable<ReturnType<RoomService['getRoom']>>;
