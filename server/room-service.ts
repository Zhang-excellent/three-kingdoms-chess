import { randomBytes, randomUUID } from 'node:crypto';
import { ORDER, newGame, playMove } from '../src/game.ts';
import type { Faction, Game, Point } from '../src/game.ts';
import type { ClientAck, MoveIntent, RoomPhase, RoomPlayerView, RoomView, SessionReceipt } from '../src/online.ts';

interface Player {
  id: string;
  token: string;
  nickname: string;
  faction: Faction | null;
  ready: boolean;
  online: boolean;
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
}

const cleanNickname = (value: unknown): string => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 16) : '';
const cleanCode = (value: unknown): string => typeof value === 'string' ? value.trim().toUpperCase() : '';
const isFaction = (value: unknown): value is Faction => ORDER.includes(value as Faction);
const isPoint = (value: unknown): value is Point => !!value && typeof value === 'object'
  && Number.isInteger((value as Point).x) && Number.isInteger((value as Point).y);

export class RoomService {
  private readonly rooms = new Map<string, Room>();
  private readonly tokenRoom = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();

  createRoom(nicknameValue: unknown, socketId: string): RoomActionResult<SessionReceipt> {
    const nickname = cleanNickname(nicknameValue);
    if (!nickname) return { ack: { ok: false, code: 'INVALID_NICKNAME', error: '请输入 1～16 个字符的昵称。' } };
    let code = '';
    do code = randomBytes(3).toString('hex').toUpperCase(); while (this.rooms.has(code));
    const player = this.newPlayer(nickname, socketId);
    const room: Room = { code, phase: 'lobby', version: 1, players: [player], game: null, requests: new Map() };
    this.rooms.set(code, room); this.tokenRoom.set(player.token, code);
    return { room, ack: { ok: true, data: this.receipt(room, player) } };
  }

  joinRoom(codeValue: unknown, nicknameValue: unknown, socketId: string): RoomActionResult<SessionReceipt> {
    const code = cleanCode(codeValue), nickname = cleanNickname(nicknameValue), room = this.rooms.get(code);
    if (!room) return { ack: { ok: false, code: 'ROOM_NOT_FOUND', error: '没有找到这个房间，请检查房间号。' } };
    if (!nickname) return { ack: { ok: false, code: 'INVALID_NICKNAME', error: '请输入 1～16 个字符的昵称。' } };
    if (room.phase !== 'lobby') return { ack: { ok: false, code: 'GAME_STARTED', error: '该房间已经开局，不能再加入。' } };
    if (room.players.length >= 3) return { ack: { ok: false, code: 'ROOM_FULL', error: '房间已满，最多三名玩家。' } };
    const player = this.newPlayer(nickname, socketId);
    room.players.push(player); room.version++; this.tokenRoom.set(player.token, room.code);
    return { room, ack: { ok: true, data: this.receipt(room, player) } };
  }

  resumeRoom(codeValue: unknown, tokenValue: unknown, socketId: string): RoomActionResult<SessionReceipt> {
    const code = cleanCode(codeValue), token = typeof tokenValue === 'string' ? tokenValue : '';
    const room = this.rooms.get(code);
    if (!room || this.tokenRoom.get(token) !== code) return { ack: { ok: false, code: 'SESSION_NOT_FOUND', error: '重连凭证已失效，房间可能因服务器重启而丢失。' } };
    const player = room.players.find(item => item.token === token);
    if (!player) return { ack: { ok: false, code: 'SESSION_NOT_FOUND', error: '无法恢复这个席位。' } };
    const replacedSocketId = player.socketId && player.socketId !== socketId ? player.socketId : undefined;
    const changed = !player.online || player.socketId !== socketId;
    player.online = true; player.socketId = socketId;
    if (changed) room.version++;
    return { room, replacedSocketId, ack: { ok: true, data: this.receipt(room, player) } };
  }

  chooseFaction(codeValue: unknown, tokenValue: unknown, factionValue: unknown): RoomActionResult<{ state: RoomView }> {
    const found = this.findPlayer(codeValue, tokenValue);
    if (!found.ok) return { ack: found.ack };
    const { room, player } = found;
    if (room.phase !== 'lobby') return { ack: { ok: false, code: 'GAME_STARTED', error: '对局已经开始，不能更换阵营。', state: this.view(room, player) } };
    if (!isFaction(factionValue)) return { ack: { ok: false, code: 'INVALID_FACTION', error: '请选择魏、蜀或吴。' } };
    if (room.players.some(item => item !== player && item.faction === factionValue))
      return { ack: { ok: false, code: 'FACTION_TAKEN', error: '该阵营已被其他玩家选择。', state: this.view(room, player) } };
    player.faction = factionValue; player.ready = false; room.version++;
    return { room, ack: { ok: true, data: { state: this.view(room, player) } } };
  }

  setReady(codeValue: unknown, tokenValue: unknown, readyValue: unknown): RoomActionResult<{ state: RoomView }> {
    const found = this.findPlayer(codeValue, tokenValue);
    if (!found.ok) return { ack: found.ack };
    const { room, player } = found;
    if (room.phase !== 'lobby') return { ack: { ok: false, code: 'GAME_STARTED', error: '对局已经开始。', state: this.view(room, player) } };
    if (!player.faction) return { ack: { ok: false, code: 'FACTION_REQUIRED', error: '请先选择阵营。', state: this.view(room, player) } };
    if (typeof readyValue !== 'boolean') return { ack: { ok: false, code: 'INVALID_READY', error: '准备状态无效。' } };
    player.ready = readyValue; room.version++;
    if (room.players.length === 3 && room.players.every(item => item.faction && item.ready)
      && new Set(room.players.map(item => item.faction)).size === 3) {
      room.game = newGame(); room.phase = 'playing'; room.version++;
    }
    return { room, ack: { ok: true, data: { state: this.view(room, player) } } };
  }

  submitMove(codeValue: unknown, tokenValue: unknown, intent: unknown): Promise<RoomActionResult<{ state: RoomView }>> {
    const code = cleanCode(codeValue);
    return this.serial(code, () => this.processMove(code, tokenValue, intent));
  }

  disconnect(socketId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      const player = room.players.find(item => item.socketId === socketId);
      if (!player) continue;
      player.online = false; player.socketId = null; room.version++;
      return room;
    }
    return undefined;
  }

  views(room: Room): Array<{ socketId: string; state: RoomView }> {
    return room.players.flatMap(player => player.socketId ? [{ socketId: player.socketId, state: this.view(room, player) }] : []);
  }

  getRoom(code: string): Room | undefined { return this.rooms.get(cleanCode(code)); }

  private processMove(code: string, tokenValue: unknown, intentValue: unknown): RoomActionResult<{ state: RoomView }> {
    const found = this.findPlayer(code, tokenValue);
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

  private findPlayer(codeValue: unknown, tokenValue: unknown):
    | { ok: true; room: Room; player: Player }
    | { ok: false; ack: ClientAck<never> } {
    const code = cleanCode(codeValue), token = typeof tokenValue === 'string' ? tokenValue : '', room = this.rooms.get(code);
    const player = room?.players.find(item => item.token === token);
    if (!room || !player) return { ok: false, ack: { ok: false, code: 'SESSION_NOT_FOUND', error: '席位凭证无效，请重新加入房间。' } };
    return { ok: true, room, player };
  }

  private newPlayer(nickname: string, socketId: string): Player {
    return { id: randomUUID(), token: randomBytes(32).toString('base64url'), nickname, faction: null, ready: false, online: true, socketId };
  }

  private receipt(room: Room, player: Player): SessionReceipt {
    return { roomCode: room.code, playerId: player.id, reconnectToken: player.token, state: this.view(room, player) };
  }

  private view(room: Room, self: Player): RoomView {
    const players: RoomPlayerView[] = room.players.map(({ id, nickname, faction, ready, online }) => ({ id, nickname, faction, ready, online }));
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
