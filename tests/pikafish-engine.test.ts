import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  PikafishEngineClient,
  PikafishError,
  pikafishConfigFromEnv,
} from '../server/pikafish-engine.ts';
import type { PikafishConfig } from '../server/pikafish-engine.ts';

const fixture = fileURLToPath(new URL('./fixtures/fake-pikafish.mjs', import.meta.url));
const baseConfig = (overrides: Partial<PikafishConfig> = {}): PikafishConfig => ({
  executablePath: process.execPath,
  evalFile: '',
  args: [fixture],
  threads: 1,
  hashMb: 16,
  moveTimeMs: 100,
  searchTimeoutMs: 1_000,
  startupTimeoutMs: 3_000,
  maxQueue: 0,
  ...overrides,
});

test('Pikafish environment configuration enforces single-thread and bounded defaults', () => {
  const config = pikafishConfigFromEnv({
    PIKAFISH_PATH: '/opt/pikafish/pikafish',
    PIKAFISH_EVAL_FILE: '/opt/pikafish/pikafish.nnue',
    PIKAFISH_THREADS: '8',
    PIKAFISH_HASH_MB: '8',
    PIKAFISH_MOVE_TIME_MS: '20',
    PIKAFISH_SEARCH_TIMEOUT_MS: '20',
    PIKAFISH_MAX_QUEUE: '99',
  });
  assert.equal(config.executablePath, '/opt/pikafish/pikafish');
  assert.equal(config.evalFile, '/opt/pikafish/pikafish.nnue');
  assert.equal(config.threads, 1);
  assert.equal(config.hashMb, 64);
  assert.equal(config.moveTimeMs, 800);
  assert.equal(config.searchTimeoutMs, 6_000);
  assert.equal(config.maxQueue, 2);
});

test('Pikafish adapter performs UCI handshake and returns bestmove', async () => {
  const engine = new PikafishEngineClient(baseConfig({ env: { FAKE_PIKAFISH_MOVE: 'b2b3' } }));
  try {
    assert.equal(engine.configured, true);
    assert.deepEqual(await engine.uciOptions(), ['evalfile', 'hash', 'threads']);
    assert.equal(await engine.bestMove({
      initialFen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
      moves: [],
    }), 'b2b3');
  } finally {
    engine.dispose();
  }
});

test('Pikafish adapter times out, recycles the process and rejects a second concurrent job', async () => {
  const engine = new PikafishEngineClient(baseConfig({
    env: { FAKE_PIKAFISH_HANG: '1' },
    moveTimeMs: 100,
    searchTimeoutMs: 250,
  }));
  try {
    const first = engine.bestMove({ initialFen: 'fen', moves: [] });
    await assert.rejects(
      engine.bestMove({ initialFen: 'fen', moves: [] }),
      (error: unknown) => error instanceof PikafishError && error.code === 'BUSY',
    );
    await assert.rejects(first, (error: unknown) => error instanceof PikafishError && error.code === 'TIMEOUT');
  } finally {
    engine.dispose();
  }
});

test('Pikafish adapter reports unavailable when executable or configured weights are absent', async () => {
  const engine = new PikafishEngineClient(baseConfig({
    executablePath: resolve(process.cwd(), 'missing-pikafish'),
    evalFile: '',
  }));
  try {
    assert.equal(engine.configured, false);
    await assert.rejects(
      engine.bestMove({ initialFen: 'fen', moves: [] }),
      (error: unknown) => error instanceof PikafishError && error.code === 'UNAVAILABLE',
    );
  } finally {
    engine.dispose();
  }
});
