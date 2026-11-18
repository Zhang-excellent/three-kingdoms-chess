import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_BASE_PATH,
  ANDROID_WEBVIEW_ORIGIN,
  SOCKET_IO_PATH,
  WEB_BACKEND_ORIGIN,
  apiRequestCredentials,
  apiUrl,
  backendAssetUrl,
  socketIoConfig,
} from '../src/network-config.ts';

test('web auth and Socket.IO keep same-origin relative endpoints', () => {
  assert.equal(WEB_BACKEND_ORIGIN, 'https://47.95.251.153');
  assert.equal(ANDROID_WEBVIEW_ORIGIN, 'https://localhost');
  assert.equal(API_BASE_PATH, '/three-chess/api');
  assert.equal(apiUrl('/auth/login', false), '/three-chess/api/auth/login');
  assert.equal(apiUrl('games/recent', false), '/three-chess/api/games/recent');
  assert.equal(apiRequestCredentials(false), 'same-origin');
  assert.equal(backendAssetUrl('/three-chess/api/avatar/user-1?v=7', false), '/three-chess/api/avatar/user-1?v=7');
  assert.equal(backendAssetUrl('images/guest-avatar.svg', false), 'images/guest-avatar.svg');
  assert.deepEqual(socketIoConfig(false), {
    origin: null,
    options: { path: SOCKET_IO_PATH, withCredentials: true },
  });
});

test('native auth and Socket.IO use the production HTTPS backend with credentials', () => {
  const relativeAvatar = '/three-chess/api/avatar/user-1?v=7';
  assert.equal(new URL(relativeAvatar, ANDROID_WEBVIEW_ORIGIN).href,
    'https://localhost/three-chess/api/avatar/user-1?v=7');
  assert.equal(apiUrl('/auth/login', true), 'https://47.95.251.153/three-chess/api/auth/login');
  assert.equal(apiUrl('games/recent', true), 'https://47.95.251.153/three-chess/api/games/recent');
  assert.equal(apiRequestCredentials(true), 'include');
  assert.equal(backendAssetUrl(relativeAvatar, true), 'https://47.95.251.153/three-chess/api/avatar/user-1?v=7');
  assert.equal(backendAssetUrl('images/guest-avatar.svg', true), 'images/guest-avatar.svg');
  assert.equal(backendAssetUrl('https://example.com/avatar.png', true), 'https://example.com/avatar.png');
  assert.equal(backendAssetUrl(null, true), null);
  assert.deepEqual(socketIoConfig(true), {
    origin: 'https://47.95.251.153',
    options: { path: '/three-chess/socket.io', withCredentials: true },
  });
});
