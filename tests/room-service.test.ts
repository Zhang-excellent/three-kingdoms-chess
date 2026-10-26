import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomService } from '../server/room-service.ts';
import type { Faction } from '../src/game.ts';
import type { MoveIntent, SessionReceipt } from '../src/online.ts';

function receipt(result: ReturnType<RoomService['createRoom']>): SessionReceipt {
  assert.equal(result.ack.ok, true);
  if (!result.ack.ok) assert.fail('room action failed');
  return result.ack.data;
}

function failure(result: Awaited<ReturnType<RoomService['submitMove']>>, code: string) {
  assert.equal(result.ack.ok, false);
  if (result.ack.ok) assert.fail('expected rejection');
  assert.equal(result.ack.code, code);
}

function intent(requestId: string, version: number, pieceId: string, x: number, y: number): MoveIntent {
  return { requestId, version, pieceId, to: { x, y } };
}

function startedRoom() {
  const service = new RoomService();
  const first = receipt(service.createRoom('阿魏', 'socket-wei'));
  const second = receipt(service.joinRoom(first.roomCode, '阿蜀', 'socket-shu') as ReturnType<RoomService['createRoom']>);
  const third = receipt(service.joinRoom(first.roomCode, '阿吴', 'socket-wu') as ReturnType<RoomService['createRoom']>);
  const players = [first, second, third];
  for (const [index, faction] of (['wei', 'shu', 'wu'] as Faction[]).entries()) {
    const result = service.chooseFaction(first.roomCode, players[index].reconnectToken, faction);
    assert.equal(result.ack.ok, true);
  }
  for (const player of players) {
    const result = service.setReady(first.roomCode, player.reconnectToken, true);
    assert.equal(result.ack.ok, true);
  }
  const room = service.getRoom(first.roomCode)!;
  assert.equal(room.phase, 'playing'); assert.equal(room.game?.pieces.length, 29);
  return { service, code: first.roomCode, players, room };
}

test('three players claim unique factions, ready, and start one authoritative game', () => {
  const { service, code, players, room } = startedRoom();
  assert.deepEqual(room.players.map(player => player.faction), ['wei', 'shu', 'wu']);
  assert.equal(room.players.every(player => player.ready && player.online), true);
  const duplicate = service.chooseFaction(code, players[1].reconnectToken, 'wei');
  assert.equal(duplicate.ack.ok, false);
  assert.equal(room.game?.turn, 'wei'); assert.equal(room.game?.turnSlot, 0);
});

test('a room rejects a fourth player and separate rooms never share state', async () => {
  const { service, code, players, room } = startedRoom();
  const waiting = receipt(service.createRoom('房主', 'waiting-1'));
  receipt(service.joinRoom(waiting.roomCode, '二号', 'waiting-2') as ReturnType<RoomService['createRoom']>);
  receipt(service.joinRoom(waiting.roomCode, '三号', 'waiting-3') as ReturnType<RoomService['createRoom']>);
  const full = service.joinRoom(waiting.roomCode, '第四人', 'waiting-4');
  assert.equal(full.ack.ok, false); if (!full.ack.ok) assert.equal(full.ack.code, 'ROOM_FULL');
  const other = receipt(service.createRoom('另一桌', 'other-socket'));
  assert.notEqual(other.roomCode, code);
  const before = service.getRoom(other.roomCode)!.version;
  const moved = await service.submitMove(code, players[0].reconnectToken, intent('roomone01', room.version, 'wei-pawn-0-6', 0, 5));
  assert.equal(moved.ack.ok, true);
  assert.equal(service.getRoom(other.roomCode)!.version, before);
  assert.equal(service.getRoom(other.roomCode)!.game, null);
});

test('server enforces faction ownership, turn, legal moves, and three-slot order', async () => {
  const { service, code, players, room } = startedRoom();
  failure(await service.submitMove(code, players[1].reconnectToken, intent('wrongturn1', room.version, 'wei-pawn-0-6', 0, 5)), 'NOT_YOUR_TURN');
  failure(await service.submitMove(code, players[0].reconnectToken, intent('wrongpiece', room.version, 'shu-pawn-2-3', 2, 4)), 'NOT_YOUR_PIECE');
  failure(await service.submitMove(code, players[0].reconnectToken, intent('illegal001', room.version, 'wei-pawn-0-6', 1, 6)), 'ILLEGAL_MOVE');
  const sequence = [
    [0, 'wei-pawn-0-6', 0, 5], [1, 'shu-pawn-2-3', 2, 4], [2, 'wu-pawn-6-3', 6, 4],
    [0, 'wei-pawn-4-6', 4, 5], [1, 'shu-pawn-0-3', 0, 4], [2, 'wu-pawn-8-3', 8, 4],
    [0, 'wei-pawn-2-6', 2, 5], [1, 'shu-pawn-4-3', 4, 4], [2, 'wu-feng-5-2', 5, 3],
  ] as const;
  for (const [index, [playerIndex, piece, x, y]] of sequence.entries()) {
    const result = await service.submitMove(code, players[playerIndex].reconnectToken,
      intent(`sequence${index}`, room.version, piece, x, y));
    assert.equal(result.ack.ok, true);
    if (index === 0) failure(await service.submitMove(code, players[1].reconnectToken,
      intent('allypiece1', room.version, 'wu-pawn-6-3', 6, 4)), 'NOT_YOUR_PIECE');
  }
  assert.deepEqual(room.game?.history.map(move => move.turnSlot), [0, 1, 2, 0, 1, 2, 0, 1, 2]);
  assert.equal(room.game?.turn, 'wei'); assert.equal(room.game?.turnSlot, 0);
});

test('serial processing, versions, and request ids prevent double moves', async () => {
  const { service, code, players, room } = startedRoom();
  const version = room.version;
  const firstIntent = intent('duplicate1', version, 'wei-pawn-0-6', 0, 5);
  const [first, concurrent] = await Promise.all([
    service.submitMove(code, players[0].reconnectToken, firstIntent),
    service.submitMove(code, players[0].reconnectToken, intent('concurrent1', version, 'wei-pawn-2-6', 2, 5)),
  ]);
  assert.equal(first.ack.ok, true); failure(concurrent, 'STALE_VERSION');
  assert.equal(room.game?.history.length, 1);
  const duplicate = await service.submitMove(code, players[0].reconnectToken, firstIntent);
  assert.equal(duplicate.ack.ok, true); assert.equal(room.game?.history.length, 1);
  failure(await service.submitMove(code, players[0].reconnectToken,
    intent('duplicate1', version, 'wei-pawn-4-6', 4, 5)), 'REQUEST_ID_REUSED');
  failure(await service.submitMove(code, players[1].reconnectToken,
    intent('stale0001', version, 'shu-pawn-2-3', 2, 4)), 'STALE_VERSION');
});

test('disconnect keeps the seat and a secret token resumes without duplicating it', () => {
  const { service, code, players, room } = startedRoom();
  service.disconnect('socket-shu');
  assert.equal(room.players[1].online, false); assert.equal(room.players.length, 3);
  const bad = service.resumeRoom(code, 'guessable-name-is-not-a-token', 'attacker');
  assert.equal(bad.ack.ok, false);
  const resumed = service.resumeRoom(code, players[1].reconnectToken, 'socket-shu-new');
  assert.equal(resumed.ack.ok, true); assert.equal(room.players[1].online, true);
  assert.equal(room.players[1].socketId, 'socket-shu-new'); assert.equal(room.players.length, 3);
});
