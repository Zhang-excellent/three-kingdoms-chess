import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMoveRequestId } from '../src/online.ts';

test('move request IDs work without randomUUID, as on a public HTTP page', () => {
  const insecureContextCrypto = {
    getRandomValues(target: Uint32Array) {
      target.set([1, 2, 3, 4]);
      return target;
    },
  } as Pick<Crypto, 'getRandomValues'>;
  const id = createMoveRequestId(insecureContextCrypto);
  assert.equal(id, 'move-1-2-3-4');
  assert.match(id, /^[A-Za-z0-9_-]{8,80}$/);
});

test('move request IDs use fresh random bytes and match server validation', () => {
  const ids = Array.from({ length: 256 }, () => createMoveRequestId());
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.every(id => /^[A-Za-z0-9_-]{8,80}$/.test(id)), true);
});
