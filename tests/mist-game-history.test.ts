import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AuthService } from '../server/auth-service.ts';
import { MistChessService } from '../server/mist-chess-service.ts';
import { createOnlineServer } from '../server/create-server.ts';
import { newMistGame, resignMistGame } from '../src/mist-chess.ts';
import { replayArchivedMistGame } from '../src/mist-game-history.ts';
import type { ArchivedMistGameRecord, RecentMistGameSummary } from '../src/mist-game-history.ts';

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function tempDb(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'mist-history-'));
  temporaryDirectories.push(directory);
  return resolve(directory, 'auth.sqlite');
}

async function register(auth: AuthService, username: string) {
  const result = await auth.register(username, '1234', true, '127.0.0.1');
  assert.equal(result.ok, true);
  if (!result.ok || !result.sessionToken) assert.fail('account registration failed');
  return { user: result.user, cookie: `three_chess_session=${result.sessionToken}` };
}

test('mist archives are shared by logged players, replayable, isolated by account and retained across restart', async () => {
  const databasePath = tempDb();
  let currentTime = Date.UTC(2026, 10, 24, 10, 0, 0);
  const auth = new AuthService(databasePath, { now: () => currentTime });
  const redAccount = await register(auth, '迷雾记录红');
  const blackAccount = await register(auth, '迷雾记录黑');
  const unrelated = await register(auth, '迷雾无关账号');
  const records: ArchivedMistGameRecord[] = [];
  const service = new MistChessService(() => undefined, 60_000, () => currentTime, record => {
    records.push(record);
    auth.saveCompletedMistGame(record);
  });
  try {
    service.setSocketAccount('red-socket', redAccount.user.id);
    service.setSocketAccount('black-socket', blackAccount.user.id);
    const red = service.join('迷雾记录红', 'red', 'red-socket');
    const black = service.join('迷雾记录黑', 'black', 'black-socket');
    if (!red.ok || !red.ack.ok || !black.ok || !black.ack.ok) assert.fail('join failed');
    service.setReady(red.ack.data.reconnectToken, true, 'red-socket');
    service.setReady(black.ack.data.reconnectToken, true, 'black-socket');
    assert.equal(records.length, 0);
    assert.equal(auth.recentMistGames(redAccount.user.id).length, 0);

    const stateBeforeMove = service.views().find(item => item.socketId === 'red-socket')?.state;
    const move = service.move(red.ack.data.reconnectToken, {
      requestId: 'mist-history-move-1',
      version: stateBeforeMove!.version,
      pieceId: 'red-pawn-4-6',
      to: { x: 4, y: 5 },
    }, 'red-socket');
    assert.equal(move.ok, true);
    currentTime += 1_000;
    assert.equal(service.resign(black.ack.data.reconnectToken, 'black-socket').ok, true);
    assert.equal(records.length, 1);
    const saved = records[0];
    assert.equal(saved.moveCount, 1);
    assert.equal(saved.endReason, 'resignation');
    assert.equal(saved.winner, 'red');
    assert.equal(saved.participants.filter(player => player.userId).length, 2);
    assert.deepEqual(saved.participants.map(player => player.result).sort(), ['lost', 'won']);

    const replay = replayArchivedMistGame(saved);
    if (!replay.ok) assert.fail(replay.error);
    assert.equal(replay.replay.moves.length, 1);
    assert.equal(replay.replay.frames.at(-1)?.status, 'finished');
    assert.equal(replay.replay.frames.at(-1)?.winner, 'red');
    assert.deepEqual(replay.replay.frames.at(-1)?.pieces, saved.finalGame.pieces);

    auth.saveCompletedMistGame(saved);
    assert.equal(auth.recentMistGames(redAccount.user.id).length, 1);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM game_records WHERE game_type = 'mist-chess'").get() as { count: number }).count, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM game_participants WHERE game_id = ?').get(saved.id) as { count: number }).count, 2);
    database.close();
    assert.equal(auth.recentMistGames(blackAccount.user.id)[0].id, saved.id);
    assert.equal(auth.recentMistGames(unrelated.user.id).length, 0);
    const loadedRecord = auth.mistGameForUser(redAccount.user.id, saved.id);
    assert.equal(loadedRecord?.id, saved.id);
    if (!loadedRecord) assert.fail('stored mist record did not load');
    const loadedReplay = replayArchivedMistGame(loadedRecord);
    if (!loadedReplay.ok) assert.fail(loadedReplay.error);
    assert.equal(auth.mistGameForUser(unrelated.user.id, saved.id), null);

    for (let index = 0; index < 5; index++) {
      const endedAt = currentTime + (index + 1) * 1_000;
      auth.saveCompletedMistGame({
        ...structuredClone(saved),
        id: `mist-synthetic-${index}`,
        round: index + 2,
        startedAt: endedAt - 1_000,
        endedAt,
      });
    }
    const recent = auth.recentMistGames(redAccount.user.id);
    assert.equal(recent.length, 5);
    assert.equal(recent.some(game => game.id === saved.id), false);
    assert.deepEqual(recent.map(game => game.endedAt), [...recent.map(game => game.endedAt)].sort((a, b) => b - a));
    const retainedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((retainedDatabase.prepare(
      "SELECT COUNT(*) AS count FROM game_records WHERE game_type = 'mist-chess'",
    ).get() as { count: number }).count, 5);
    assert.equal((retainedDatabase.prepare(
      'SELECT COUNT(*) AS count FROM game_records WHERE id = ?',
    ).get(saved.id) as { count: number }).count, 0);
    retainedDatabase.close();

    const server = createOnlineServer({ authService: auth, cookieSecure: false });
    await new Promise<void>(resolveListen => server.httpServer.listen(0, '127.0.0.1', resolveListen));
    const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
    try {
      const recentResponse = await fetch(`${origin}/three-chess/api/games/mist/recent`, {
        headers: { Cookie: redAccount.cookie },
      });
      assert.equal(recentResponse.status, 200);
      const body = await recentResponse.json() as { games: RecentMistGameSummary[] };
      assert.equal(body.games.length, 5);
      const owner = await fetch(`${origin}/three-chess/api/games/mist/${saved.id}`, {
        headers: { Cookie: redAccount.cookie },
      });
      assert.equal(owner.status, 404);
      const newestOwner = await fetch(`${origin}/three-chess/api/games/mist/mist-synthetic-4`, {
        headers: { Cookie: redAccount.cookie },
      });
      assert.equal(newestOwner.status, 200);
      const outsider = await fetch(`${origin}/three-chess/api/games/mist/${saved.id}`, {
        headers: { Cookie: unrelated.cookie },
      });
      assert.equal(outsider.status, 404);
      assert.equal((await fetch(`${origin}/three-chess/api/games/mist/recent`)).status, 401);
    } finally {
      await new Promise<void>(resolveClose => server.io.close(() => resolveClose()));
    }
  } finally {
    service.dispose();
    auth.close();
  }

  const reopened = new AuthService(databasePath);
  try {
    assert.equal(reopened.recentMistGames(redAccount.user.id).length, 5);
    assert.equal(reopened.mistGameForUser(blackAccount.user.id, 'mist-synthetic-4')?.id, 'mist-synthetic-4');
  } finally {
    reopened.close();
  }
});

test('mist archives from a restarted service reuse round one without exposing another account game', async () => {
  const databasePath = tempDb();
  const auth = new AuthService(databasePath);
  const oldRed = await register(auth, '重启前红');
  const oldBlack = await register(auth, '重启前黑');
  const newRed = await register(auth, '重启后红');
  const newBlack = await register(auth, '重启后黑');
  const initial = newMistGame();
  const finalGame = resignMistGame(initial, 'red');
  const record = (id: string, endedAt: number, red: typeof oldRed.user, black: typeof oldBlack.user) => ({
    gameType: 'mist-chess' as const,
    id,
    roomCode: 'mist-chess',
    round: 1,
    startedAt: endedAt - 1_000,
    endedAt,
    rulesVersion: initial.rulesVersion,
    initialGame: structuredClone(initial),
    participants: [
      { playerId: `${id}-red`, userId: red.id, nickname: red.username, side: 'red' as const, result: 'lost' as const },
      { playerId: `${id}-black`, userId: black.id, nickname: black.username, side: 'black' as const, result: 'won' as const },
    ],
    moves: [],
    events: [{ type: 'end' as const, step: 0, reason: 'resignation' as const, side: 'red' as const, winner: 'black' as const }],
    finalGame: structuredClone(finalGame),
    endReason: 'resignation' as const,
    moveCount: 0,
    winner: 'black' as const,
  });
  try {
    auth.saveCompletedMistGame(record('before-restart', 1_000, oldRed.user, oldBlack.user));
    auth.saveCompletedMistGame(record('after-restart', 2_000, newRed.user, newBlack.user));
    assert.deepEqual(auth.recentMistGames(newRed.user.id).map(game => game.id), ['after-restart']);
    assert.equal(auth.mistGameForUser(newRed.user.id, 'before-restart'), null);
    assert.deepEqual(auth.recentMistGames(oldRed.user.id).map(game => game.id), ['before-restart']);
    assert.equal(auth.mistGameForUser(oldRed.user.id, 'after-restart'), null);
  } finally {
    auth.close();
  }

  const reopened = new AuthService(databasePath);
  try {
    assert.deepEqual(reopened.recentMistGames(newRed.user.id).map(game => game.id), ['after-restart']);
    assert.equal(reopened.mistGameForUser(newRed.user.id, 'before-restart'), null);
    assert.equal(reopened.mistGameForUser(oldRed.user.id, 'before-restart')?.id, 'before-restart');
  } finally {
    reopened.close();
  }
});
