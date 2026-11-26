import {
  PikafishEngineClient,
  pikafishConfigFromEnv,
} from '../server/pikafish-engine.ts';
import { ChineseChessService } from '../server/chinese-chess-service.ts';
import { allLegalChineseMoves } from '../src/chinese-chess.ts';

const config = pikafishConfigFromEnv();
if (!config.executablePath) {
  console.error('PIKAFISH_PATH is not configured.');
  process.exit(1);
}

const engine = new PikafishEngineClient(config);
const service = new ChineseChessService(() => undefined, 60_000, Date.now, engine);

async function waitForState(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ack = service.inspect();
    if (!ack.ok) throw new Error(ack.error);
    if (predicate(ack.data)) return ack.data;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function playHumanTurns(token, socketId, side, turns) {
  const played = [];
  for (let turn = 0; turn < turns; turn++) {
    const state = await waitForState(current => current.phase === 'playing' && current.game?.turn === side,
      `${side} human turn`);
    if (!state.game) throw new Error('Missing live game.');
    const move = allLegalChineseMoves(state.game, side)[0];
    if (!move) throw new Error(`No legal move for ${side}.`);
    const result = service.move(token, {
      requestId: `live-${side}-${turn}-${Date.now()}`,
      version: state.version,
      pieceId: move.piece.id,
      to: move.to,
    }, socketId);
    if (!result.ok) throw new Error(result.ack.ok ? 'Human move failed.' : result.ack.error);
    played.push(`${side}:${move.piece.kind}:${move.piece.x},${move.piece.y}->${move.to.x},${move.to.y}`);
    if (state.game.status === 'playing') {
      const engineSide = side === 'red' ? 'black' : 'red';
      await waitForState(current => current.phase !== 'playing' || current.game?.turn === side
        || current.engineError, `${engineSide} engine reply`);
      const after = service.inspect();
      if (after.ok && after.data.engineError) throw new Error(after.data.engineError);
    }
  }
  return played;
}

try {
  if (!engine.configured) throw new Error('Pikafish executable or weights are unavailable.');

  const blackHuman = service.join('真人黑验收', 'black', 'live-black');
  if (!blackHuman.ok || !blackHuman.ack.ok) throw new Error('Could not seat black human.');
  const selectRed = service.selectEngine(blackHuman.ack.data.reconnectToken, 'red', 'live-black');
  if (!selectRed.ok) throw new Error(selectRed.ack.ok ? 'Engine seat failed.' : selectRed.ack.error);
  const startBlack = service.setReady(blackHuman.ack.data.reconnectToken, true, 'live-black');
  if (!startBlack.ok) throw new Error(startBlack.ack.ok ? 'Game start failed.' : startBlack.ack.error);
  const firstRedMove = await waitForState(state => state.phase !== 'playing' || state.game?.turn === 'black',
    'Pikafish first red move');
  const blackMoves = await playHumanTurns(blackHuman.ack.data.reconnectToken, 'live-black', 'black', 3);
  service.leave(blackHuman.ack.data.reconnectToken, 'live-black');

  const redHuman = service.join('真人红验收', 'red', 'live-red');
  if (!redHuman.ok || !redHuman.ack.ok) throw new Error('Could not seat red human.');
  const selectBlack = service.selectEngine(redHuman.ack.data.reconnectToken, 'black', 'live-red');
  if (!selectBlack.ok) throw new Error(selectBlack.ack.ok ? 'Engine seat failed.' : selectBlack.ack.error);
  const startRed = service.setReady(redHuman.ack.data.reconnectToken, true, 'live-red');
  if (!startRed.ok) throw new Error(startRed.ack.ok ? 'Game start failed.' : startRed.ack.error);
  const redMoves = await playHumanTurns(redHuman.ack.data.reconnectToken, 'live-red', 'red', 3);
  const final = service.inspect();
  if (!final.ok) throw new Error(final.error);

  console.log(JSON.stringify({
    executable: config.executablePath,
    evalFile: config.evalFile || null,
    engineRedFirstMove: firstRedMove.game?.lastMove ? {
      side: firstRedMove.game.lastMove.side,
      kind: firstRedMove.game.lastMove.kind,
      from: firstRedMove.game.lastMove.from,
      to: firstRedMove.game.lastMove.to,
    } : null,
    humanBlackMoves: blackMoves,
    humanRedMoves: redMoves,
    finalMoveCount: final.data.game?.history.length ?? 0,
    finalTurn: final.data.game?.turn ?? null,
    engineError: final.data.engineError,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  service.dispose();
}
