import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appRouteUrl, parseAppRoute, roomInviteUrl } from '../src/navigation.ts';

test('app routes preserve the deployment path and legacy room links', () => {
  const origin = 'https://example.test/three-chess/';
  assert.deepEqual(parseAppRoute(origin), { page: 'home', roomCode: null });
  assert.deepEqual(parseAppRoute(`${origin}?mode=local`), { page: 'local', roomCode: null });
  assert.deepEqual(parseAppRoute(`${origin}?mode=lobby`), { page: 'lobby', roomCode: null });
  assert.deepEqual(parseAppRoute(`${origin}?mode=online`), { page: 'friends', roomCode: null });
  assert.deepEqual(parseAppRoute(`${origin}?mode=online&room=001234`), { page: 'room', roomCode: '001234' });
  assert.deepEqual(parseAppRoute(`${origin}?room=654321`), { page: 'room', roomCode: '654321' });
  assert.deepEqual(parseAppRoute(`${origin}?mode=spectate&room=654321`), { page: 'spectate', roomCode: '654321' });

  assert.equal(appRouteUrl(origin, 'room', '001234'), `${origin}?mode=online&room=001234`);
  assert.equal(appRouteUrl(`${origin}?mode=online&room=001234`, 'home'), origin);
  assert.equal(appRouteUrl(`${origin}?mode=online&room=001234`, 'lobby'), `${origin}?mode=lobby`);
  assert.equal(appRouteUrl(origin, 'local'), `${origin}?mode=local`);
  assert.equal(roomInviteUrl(`${origin}?mode=lobby&token=secret#private`, '001234'),
    `${origin}?mode=online&room=001234`);
  assert.equal(roomInviteUrl('http://127.0.0.1:4173/three-chess/?mode=online', '001234'),
    'http://127.0.0.1:4173/three-chess/?mode=online&room=001234');
  assert.equal(roomInviteUrl(origin, '12345'), null);
});
