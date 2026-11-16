import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORDER } from '../src/game.ts';
import { simulateGame, summarizeSimulation } from '../src/three-kingdoms-sim.ts';
import type { SimulationPolicy } from '../src/three-kingdoms-sim.ts';

const policy: SimulationPolicy = {
  name: 'test',
  coalition: 0.65,
  randomness: 80,
  caoExchangeBias: 0.9,
  maxPlies: 180,
};

test('three-kingdoms simulation is deterministic and always returns a completed scored game', () => {
  const first = simulateGame(policy, 20261116);
  const second = simulateGame(policy, 20261116);
  assert.deepEqual(second, first);
  assert.equal(first.moves <= policy.maxPlies, true);
  assert.equal(['winner', 'draw', 'move-limit'].includes(first.endReason), true);
  assert.equal(ORDER.every(faction => [0, 1, 2, 4].includes(first.scores[faction])), true);
  if (first.winner) assert.equal(first.scores[first.winner], 4);
  else assert.equal(first.scores.wei + first.scores.shu + first.scores.wu >= 4, true);
});

test('three-kingdoms simulation summary covers every completed game exactly once', () => {
  const results = [311, 312, 313, 314].map(seed => simulateGame(policy, seed));
  const summary = summarizeSimulation(results);
  assert.equal(summary.games, results.length);
  assert.equal(summary.wins.wei + summary.wins.shu + summary.wins.wu + summary.draws, results.length);
  assert.equal(summary.firstEliminated.wei + summary.firstEliminated.shu + summary.firstEliminated.wu <= results.length, true);
  assert.equal(summary.averageMoves > 0, true);
});
