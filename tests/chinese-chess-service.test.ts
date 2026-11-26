import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChineseChessService } from '../server/chinese-chess-service.ts';
import { PikafishError } from '../server/pikafish-engine.ts';
import type { ChineseEngineClient, ChineseEngineRequest } from '../server/pikafish-engine.ts';

class FakeEngine implements ChineseEngineClient {
  readonly configured = true;
  readonly requests: ChineseEngineRequest[] = [];
  private responses: Array<string | null | Error> = [];

  reply(...responses: Array<string | null | Error>): void {
    this.responses.push(...responses);
  }

  async bestMove(request: ChineseEngineRequest): Promise<string | null> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response === undefined ? null : response;
  }

  dispose(): void {}
}

class DeferredEngine implements ChineseEngineClient {
  readonly configured = true;
  private resolvers: Array<(move: string | null) => void> = [];
  bestMove(): Promise<string | null> {
    return new Promise(resolve => this.resolvers.push(resolve));
  }
  resolve(move: string | null): void {
    this.resolvers.shift()?.(move);
  }
  dispose(): void {}
}

const waitUntil = async (condition: () => boolean, message: string, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
};

test('Chinese chess room requires a guest nickname and unique sides', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    const missing = service.join('', 'red', 'red');
    assert.equal(missing.ok, false);
    if (missing.ack.ok) return;
    assert.equal(missing.ack.code, 'NICKNAME_REQUIRED');
    assert.equal(service.join('红方', 'red', 'red').ok, true);
    const conflict = service.join('另一红方', 'red', 'other');
    assert.equal(conflict.ok, false);
    if (conflict.ack.ok) return;
    assert.equal(conflict.ack.code, 'SIDE_TAKEN');
  } finally { service.dispose(); }
});

test('both ready starts classic Chinese chess and enforces the current turn', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    const red = service.join('中国红', 'red', 'red');
    const black = service.join('中国黑', 'black', 'black');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    service.setReady(red.ack.data.reconnectToken, true, 'red');
    const started = service.setReady(black.ack.data.reconnectToken, true, 'black');
    assert.equal(started.ok, true);
    if (!started.ack.ok) return;
    assert.equal(started.ack.data.state.game?.pieces.length, 32);
    const wrong = service.move(black.ack.data.reconnectToken, {
      requestId: 'chinese-wrong-1', version: started.ack.data.state.version,
      pieceId: 'black-pawn-0-3', to: { x: 0, y: 4 },
    }, 'black');
    assert.equal(wrong.ok, false);
    if (wrong.ack.ok) return;
    assert.equal(wrong.ack.code, 'NOT_YOUR_TURN');
    const moved = service.move(red.ack.data.reconnectToken, {
      requestId: 'chinese-red-1', version: started.ack.data.state.version,
      pieceId: 'red-pawn-0-6', to: { x: 0, y: 5 },
    }, 'red');
    assert.equal(moved.ok, true);
    if (!moved.ack.ok) return;
    assert.equal(moved.ack.data.state.game?.turn, 'black');
    assert.equal(moved.ack.data.state.game?.history.length, 1);
  } finally { service.dispose(); }
});

test('seat claims are atomic, a single ready player waits, and rematch keeps both sides', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    const red = service.join('座位红', 'red', 'red-a');
    const competing = service.join('抢座红', 'red', 'red-b');
    assert.equal(red.ok, true);
    assert.equal(competing.ok, false);
    if (competing.ack.ok) return;
    assert.equal(competing.ack.code, 'SIDE_TAKEN');
    const afterCompetingClaim = service.inspect();
    if (!afterCompetingClaim.ok) assert.fail('inspect failed');
    assert.equal(afterCompetingClaim.data.players.length, 1);
    if (!red.ack.ok) return;

    const readyAlone = service.setReady(red.ack.data.reconnectToken, true, 'red-a');
    assert.equal(readyAlone.ok, true);
    if (!readyAlone.ack.ok) return;
    assert.equal(readyAlone.ack.data.state.phase, 'lobby');
    assert.equal(readyAlone.ack.data.state.game, null);

    const black = service.join('座位黑', 'black', 'black');
    if (!black.ok || !black.ack.ok) assert.fail('black join failed');
    const oneReadyAck = service.inspect();
    if (!oneReadyAck.ok) assert.fail('inspect failed');
    const oneReady = oneReadyAck.data;
    assert.equal(oneReady.phase, 'lobby');
    assert.equal(oneReady.game, null);
    assert.deepEqual(oneReady.players.map(player => [player.side, player.ready]), [['red', true], ['black', false]]);

    const started = service.setReady(black.ack.data.reconnectToken, true, 'black');
    assert.equal(started.ok, true);
    if (!started.ack.ok) return;
    assert.equal(started.ack.data.state.phase, 'playing');
    assert.equal(started.ack.data.state.game?.pieces.length, 32);

    const resigned = service.resign(red.ack.data.reconnectToken, 'red-a');
    assert.equal(resigned.ok, true);
    if (!resigned.ack.ok) return;
    assert.equal(resigned.ack.data.state.phase, 'finished');
    assert.equal(resigned.ack.data.state.game?.winner, 'black');

    const rematch = service.rematch(black.ack.data.reconnectToken, 'black');
    assert.equal(rematch.ok, true);
    if (!rematch.ack.ok) return;
    assert.equal(rematch.ack.data.state.phase, 'lobby');
    assert.equal(rematch.ack.data.state.round, 2);
    assert.equal(rematch.ack.data.state.game, null);
    assert.deepEqual(rematch.ack.data.state.players.map(player => [player.nickname, player.side, player.ready]), [
      ['座位红', 'red', false],
      ['座位黑', 'black', false],
    ]);
  } finally { service.dispose(); }
});

test('Chinese chess disconnect keeps the game for reconnection and expires into a forfeit', async () => {
  const service = new ChineseChessService(() => undefined, 30);
  try {
    service.watch('observer');
    const red = service.join('重连红', 'red', 'red');
    const black = service.join('重连黑', 'black', 'black');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    service.disconnect('red');
    const waiting = service.views().find(item => item.socketId === 'observer')?.state;
    assert.equal(waiting?.phase, 'lobby');
    assert.deepEqual(waiting?.players.map(player => [player.side, player.online]), [['red', false], ['black', true]]);
    const lobbyResume = service.resume(red.ack.data.reconnectToken, 'red-waiting-new');
    assert.equal(lobbyResume.ok, true);

    service.setReady(red.ack.data.reconnectToken, true, 'red-waiting-new');
    service.setReady(black.ack.data.reconnectToken, true, 'black');

    service.disconnect('red-waiting-new');
    const disconnected = service.views().find(item => item.socketId === 'observer')?.state;
    assert.equal(disconnected?.phase, 'playing');
    assert.deepEqual(disconnected?.players.map(player => [player.side, player.online]), [['red', false], ['black', true]]);

    const resumed = service.resume(red.ack.data.reconnectToken, 'red-new');
    assert.equal(resumed.ok, true);
    if (!resumed.ack.ok) return;
    assert.equal(resumed.ack.data.state.phase, 'playing');
    assert.equal(resumed.ack.data.state.game?.pieces.length, 32);

    service.disconnect('red-new');
    await new Promise(resolve => setTimeout(resolve, 60));
    const expired = service.inspect();
    if (!expired.ok) assert.fail('inspect failed');
    assert.deepEqual(expired.data.players.map(player => player.side), ['black']);
    assert.equal(expired.data.phase, 'finished');
    assert.equal(expired.data.game?.winner, 'black');
  } finally { service.dispose(); }
});

test('Chinese chess players can agree to a draw and rematch from the same table', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    const red = service.join('和棋红', 'red', 'red');
    const black = service.join('和棋黑', 'black', 'black');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    service.setReady(red.ack.data.reconnectToken, true, 'red');
    service.setReady(black.ack.data.reconnectToken, true, 'black');
    const offered = service.offerDraw(red.ack.data.reconnectToken, 'red');
    assert.equal(offered.ok, true);
    if (!offered.ack.ok) return;
    assert.equal(offered.ack.data.state.drawOfferBy, 'red');
    const accepted = service.respondDraw(black.ack.data.reconnectToken, true, 'black');
    assert.equal(accepted.ok, true);
    if (!accepted.ack.ok) return;
    assert.equal(accepted.ack.data.state.phase, 'finished');
    assert.equal(accepted.ack.data.state.game?.winner, null);
    assert.equal(accepted.ack.data.state.game?.endReason, 'draw');
  } finally { service.dispose(); }
});

test('authenticated Chinese chess identity uses the account nickname', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    service.setSocketAccount('account-a', 'user-a', '/three-chess/api/avatar/user-a?v=1');
    service.setSocketAccount('account-b', 'user-b');
    const joined = service.join('账号象棋', 'red', 'account-a');
    assert.equal(joined.ok, true);
    if (!joined.ack.ok) return;
    assert.equal(joined.ack.data.state.players[0].identity, 'account');
    assert.equal(joined.ack.data.state.players[0].avatar, '/three-chess/api/avatar/user-a?v=1');
    assert.equal(service.resume(joined.ack.data.reconnectToken, 'account-b').ok, false);
  } finally { service.dispose(); }
});

test('Chinese chess engine seat claims atomically and can switch back before play', () => {
  const engine = new FakeEngine();
  const service = new ChineseChessService(() => undefined, 60_000, Date.now, engine);
  try {
    const human = service.join('真人红', 'red', 'human-red');
    if (!human.ok || !human.ack.ok) assert.fail('human join failed');
    const selected = service.selectEngine(human.ack.data.reconnectToken, 'black', 'human-red');
    assert.equal(selected.ok, true);
    if (!selected.ack.ok) return;
    assert.equal(selected.ack.data.state.engineSide, 'black');
    assert.equal(selected.ack.data.state.engineThinking, false);

    const competing = service.join('真人黑', 'black', 'other-human');
    assert.equal(competing.ok, false);
    if (competing.ack.ok) return;
    assert.equal(competing.ack.code, 'SIDE_TAKEN');
    assert.match(competing.ack.error, /神秘老人/);

    const removed = service.removeEngine(human.ack.data.reconnectToken, 'human-red');
    assert.equal(removed.ok, true);
    if (!removed.ack.ok) return;
    assert.equal(removed.ack.data.state.engineSide, null);
    assert.equal(service.join('真人黑', 'black', 'other-human').ok, true);
  } finally { service.dispose(); }
});

test('a human seat, including a disconnect grace seat, wins the race against Pikafish', () => {
  const engine = new FakeEngine();
  const service = new ChineseChessService(() => undefined, 60_000, Date.now, engine);
  try {
    const red = service.join('抢座红', 'red', 'red');
    const black = service.join('抢座黑', 'black', 'black');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    const occupied = service.selectEngine(red.ack.data.reconnectToken, 'black', 'red');
    assert.equal(occupied.ok, false);
    if (occupied.ack.ok) return;
    assert.equal(occupied.ack.code, 'ROOM_FULL');

    service.disconnect('black');
    const graceSeat = service.selectEngine(red.ack.data.reconnectToken, 'black', 'red');
    assert.equal(graceSeat.ok, false);
    if (graceSeat.ack.ok) return;
    assert.equal(graceSeat.ack.code, 'ROOM_FULL');
    assert.equal(graceSeat.ack.state?.engineSide, null);
  } finally { service.dispose(); }
});

test('Pikafish red moves first after start and human black can reply', async () => {
  const engine = new FakeEngine();
  engine.reply('h2e2', 'b9b8');
  const service = new ChineseChessService(() => undefined, 60_000, Date.now, engine);
  try {
    const human = service.join('真人黑', 'black', 'human-black');
    if (!human.ok || !human.ack.ok) assert.fail('human join failed');
    const selected = service.selectEngine(human.ack.data.reconnectToken, 'red', 'human-black');
    assert.equal(selected.ok, true);
    const started = service.setReady(human.ack.data.reconnectToken, true, 'human-black');
    assert.equal(started.ok, true);
    if (!started.ack.ok) return;
    assert.equal(started.ack.data.state.engineThinking, true);
    await waitUntil(() => {
      const state = service.inspect();
      return state.ok && state.data.game?.history.length === 1;
    }, 'engine did not make the first move');
    const afterEngine = service.inspect();
    if (!afterEngine.ok) assert.fail('inspect failed');
    assert.equal(afterEngine.data.game?.turn, 'black');
    assert.equal(afterEngine.data.game?.lastMove?.side, 'red');
    assert.equal(engine.requests[0].moves.length, 0);
    const humanMove = service.move(human.ack.data.reconnectToken, {
      requestId: 'engine-human-black-1',
      version: (service.views()[0]?.state.version ?? 0),
      pieceId: 'black-cannon-1-2',
      to: { x: 1, y: 1 },
    }, 'human-black');
    assert.equal(humanMove.ok, true);
  } finally { service.dispose(); }
});

test('Pikafish as black receives real history and returns a validated move', async () => {
  const engine = new FakeEngine();
  engine.reply('b7b8');
  const service = new ChineseChessService(() => undefined, 60_000, Date.now, engine);
  try {
    const human = service.join('真人红', 'red', 'human-red');
    if (!human.ok || !human.ack.ok) assert.fail('human join failed');
    service.selectEngine(human.ack.data.reconnectToken, 'black', 'human-red');
    const started = service.setReady(human.ack.data.reconnectToken, true, 'human-red');
    if (!started.ack.ok) assert.fail('game did not start');
    const moved = service.move(human.ack.data.reconnectToken, {
      requestId: 'engine-human-red-1',
      version: started.ack.data.state.version,
      pieceId: 'red-pawn-0-6',
      to: { x: 0, y: 5 },
    }, 'human-red');
    assert.equal(moved.ok, true);
    await waitUntil(() => {
      const state = service.inspect();
      return state.ok && state.data.game?.history.length === 2 && state.data.game.turn === 'red';
    }, 'engine did not reply as black');
    assert.equal(engine.requests[0].moves[0], 'a3a4');
    const state = service.inspect();
    if (!state.ok) return;
    assert.equal(state.data.game?.lastMove?.side, 'black');
  } finally { service.dispose(); }
});

test('Pikafish failures keep the board, support retry, and stale results are discarded', async () => {
  const engine = new FakeEngine();
  engine.reply(new PikafishError('TIMEOUT', 'test timeout'), 'a0b2', 'h2e2');
  const service = new ChineseChessService(() => undefined, 60_000, Date.now, engine);
  try {
    const human = service.join('真人黑', 'black', 'human-black');
    if (!human.ok || !human.ack.ok) assert.fail('human join failed');
    service.selectEngine(human.ack.data.reconnectToken, 'red', 'human-black');
    service.setReady(human.ack.data.reconnectToken, true, 'human-black');
    await waitUntil(() => {
      const state = service.inspect();
      return state.ok && state.data.engineError === '神秘老人暂不可用' && !state.data.engineThinking;
    }, 'engine failure did not surface');
    const failed = service.inspect();
    if (!failed.ok) return;
    assert.equal(failed.data.game?.history.length, 0);
    const retry = service.retryEngine(human.ack.data.reconnectToken, 'human-black');
    assert.equal(retry.ok, true);
    await waitUntil(() => {
      const state = service.inspect();
      return state.ok && state.data.engineError === '神秘老人暂不可用' && !state.data.engineThinking;
    }, 'illegal engine move did not surface');
    const illegal = service.inspect();
    if (!illegal.ok) return;
    assert.equal(illegal.data.game?.history.length, 0);
    assert.equal(service.retryEngine(human.ack.data.reconnectToken, 'human-black').ok, true);
    await waitUntil(() => {
      const state = service.inspect();
      return state.ok && state.data.game?.history.length === 1;
    }, 'engine retry did not move');
  } finally { service.dispose(); }
});

test('Pikafish queue saturation is shown as a busy message', async () => {
  const engine = new FakeEngine();
  engine.reply(new PikafishError('BUSY', 'engine queue full'));
  const service = new ChineseChessService(() => undefined, 60_000, Date.now, engine);
  try {
    const human = service.join('繁忙黑', 'black', 'human-black');
    if (!human.ok || !human.ack.ok) assert.fail('human join failed');
    service.selectEngine(human.ack.data.reconnectToken, 'red', 'human-black');
    service.setReady(human.ack.data.reconnectToken, true, 'human-black');
    await waitUntil(() => {
      const state = service.inspect();
      return state.ok && state.data.engineError === '神秘老人繁忙' && !state.data.engineThinking;
    }, 'busy engine state did not surface');
    const state = service.inspect();
    if (!state.ok) return;
    assert.equal(state.data.game?.history.length, 0);
  } finally { service.dispose(); }
});

test('engine requests fail when Pikafish is not configured', () => {
  const service = new ChineseChessService(() => undefined);
  try {
    const human = service.join('无引擎红', 'red', 'human-red');
    if (!human.ok || !human.ack.ok) assert.fail('human join failed');
    const selected = service.selectEngine(human.ack.data.reconnectToken, 'black', 'human-red');
    assert.equal(selected.ok, false);
    if (selected.ack.ok) return;
    assert.equal(selected.ack.code, 'ENGINE_UNAVAILABLE');
    assert.equal(selected.ack.error, '神秘老人暂不可用。');
  } finally { service.dispose(); }
});

test('late Pikafish results are discarded after resignation and a new game token', async () => {
  const engine = new DeferredEngine();
  const service = new ChineseChessService(() => undefined, 60_000, Date.now, engine);
  try {
    const human = service.join('延迟黑', 'black', 'human-black');
    if (!human.ok || !human.ack.ok) assert.fail('human join failed');
    service.selectEngine(human.ack.data.reconnectToken, 'red', 'human-black');
    service.setReady(human.ack.data.reconnectToken, true, 'human-black');
    assert.equal(service.resign(human.ack.data.reconnectToken, 'human-black').ok, true);
    assert.equal(service.rematch(human.ack.data.reconnectToken, 'human-black').ok, true);
    service.setReady(human.ack.data.reconnectToken, true, 'human-black');
    engine.resolve('h2e2');
    await new Promise(resolve => setTimeout(resolve, 0));
    const rematched = service.inspect();
    if (!rematched.ok) assert.fail('inspect failed');
    assert.equal(rematched.data.phase, 'playing');
    assert.equal(rematched.data.game?.history.length, 0);
    assert.equal(rematched.data.engineThinking, true);
    engine.resolve('h2e2');
    await waitUntil(() => {
      const state = service.inspect();
      return state.ok && state.data.game?.history.length === 1;
    }, 'new game engine result was not applied');
    const finished = service.inspect();
    if (!finished.ok) assert.fail('inspect failed');
    assert.equal(finished.data.phase, 'playing');
    assert.equal(finished.data.game?.turn, 'black');
    assert.equal(finished.data.engineThinking, false);
  } finally { service.dispose(); }
});
