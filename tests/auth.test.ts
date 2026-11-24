import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { io, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/create-server.ts';
import { AuthService } from '../server/auth-service.ts';
import type { ClientAck, SessionReceipt } from '../src/online.ts';
import { passwordError, usernameError } from '../src/auth.ts';

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function tempPath(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'three-chess-auth-'));
  temporaryDirectories.push(directory);
  return resolve(directory, 'auth.sqlite');
}

async function startServer(options: Parameters<typeof createOnlineServer>[0] = {}) {
  const server = createOnlineServer(options);
  await new Promise<void>(resolveListen => server.httpServer.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  return { server, origin };
}

async function closeServer(server: ReturnType<typeof createOnlineServer>) {
  await new Promise<void>(resolveClose => server.io.close(() => resolveClose()));
  server.authService.close();
}

interface ApiResult {
  status: number;
  cookie: string | null;
  setCookie: string | null;
  body: Record<string, unknown>;
  headers: Headers;
}

async function api(origin: string, path: string, method: 'GET' | 'POST', body?: Record<string, unknown>,
  cookie?: string | null, extraHeaders: Record<string, string> = {}): Promise<ApiResult> {
  const response = await fetch(`${origin}/three-chess/api/auth/${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  return {
    status: response.status,
    cookie: setCookie?.split(';')[0] ?? null,
    setCookie,
    body: await response.json() as Record<string, unknown>,
    headers: response.headers,
  };
}

async function register(origin: string, username: string, password = '1234', remember = true) {
  const result = await api(origin, 'register', 'POST', { username, password, remember });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.cookie);
  return result;
}

async function socketClient(origin: string, cookie?: string): Promise<Socket> {
  const socket = io(origin, {
    path: '/three-chess/socket.io',
    forceNew: true,
    reconnection: false,
    extraHeaders: cookie ? { Cookie: cookie } : undefined,
  });
  await new Promise<void>((resolveConnect, rejectConnect) => {
    socket.once('connect', resolveConnect);
    socket.once('connect_error', rejectConnect);
  });
  return socket;
}

const send = <T>(socket: Socket, event: string, payload: unknown): Promise<ClientAck<T>> =>
  new Promise(resolveSend => socket.emit(event, payload, resolveSend));

test('shared frontend and backend validation accepts the exact username and password boundaries', () => {
  assert.equal(passwordError('1234'), null);
  assert.match(passwordError('123') ?? '', /4～64/);
  assert.equal(passwordError('a'.repeat(64)), null);
  assert.match(passwordError('a'.repeat(65)) ?? '', /4～64/);
  assert.equal(usernameError('中文Ab_12'), null);
  assert.equal(usernameError('  A甲  '), null);
  assert.match(usernameError('a') ?? '', /2～16/);
  assert.match(usernameError('a'.repeat(17)) ?? '', /2～16/);
  assert.match(usernameError('bad name') ?? '', /中文、英文字母、数字和下划线/);
});

test('registration validates exact password and username rules, normalizes case, and never stores secrets in plaintext', async () => {
  const authDbPath = tempPath();
  const { server, origin } = await startServer({ authDbPath });
  try {
    const shortPassword = await api(origin, 'register', 'POST', { username: '测试玩家', password: '123' });
    assert.equal(shortPassword.status, 400);
    assert.equal(shortPassword.body.code, 'INVALID_PASSWORD');
    const fourCharacterPassword = await register(origin, '  测试玩家_甲  ', '1234');
    assert.match(fourCharacterPassword.setCookie ?? '', /HttpOnly/);
    assert.match(fourCharacterPassword.setCookie ?? '', /SameSite=Lax/);
    assert.equal((fourCharacterPassword.body.user as { username: string }).username, '测试玩家_甲');
    assert.equal('recoveryCode' in fourCharacterPassword.body, false);
    const duplicate = await api(origin, 'register', 'POST', { username: '测试玩家_甲', password: '5678' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, '这个昵称已经有人使用，请换一个');
    const duplicateCase = await api(origin, 'register', 'POST', { username: 'TEST_User', password: '1234' });
    assert.equal(duplicateCase.status, 200);
    const duplicateCaseAgain = await api(origin, 'register', 'POST', { username: 'test_user', password: '1234' });
    assert.equal(duplicateCaseAgain.status, 409);

    const database = new DatabaseSync(authDbPath, { readOnly: true });
    const row = database.prepare('SELECT password_hash, recovery_hash FROM auth_users WHERE username = ?').get('测试玩家_甲');
    const stored = row as unknown as { password_hash: string; recovery_hash: string };
    database.close();
    assert.match(stored.password_hash, /^scrypt\$/);
    assert.equal(stored.password_hash.includes('1234'), false);
    assert.equal(stored.recovery_hash, 'disabled');
  } finally {
    await closeServer(server);
  }
});

test('concurrent registration of the same canonical username succeeds exactly once', async () => {
  const { server, origin } = await startServer();
  try {
    const attempts = await Promise.all([
      api(origin, 'register', 'POST', { username: 'Concurrent_用户', password: '1234' }),
      api(origin, 'register', 'POST', { username: ' concurrent_用户 ', password: '5678' }),
    ]);
    assert.deepEqual(attempts.map(item => item.status).sort(), [200, 409]);
  } finally {
    await closeServer(server);
  }
});

test('login, short sessions, 7-day sessions, logout revocation, and password changes issue fresh sessions', async () => {
  const authDbPath = tempPath();
  const { server, origin } = await startServer({ authDbPath, cookieSecure: true });
  try {
    await register(origin, '会话玩家', '1234');
    const shortLogin = await api(origin, 'login', 'POST', { username: '会话玩家', password: '1234', remember: false });
    assert.equal(shortLogin.status, 200);
    assert.match(shortLogin.setCookie ?? '', /Secure/);
    assert.doesNotMatch(shortLogin.setCookie ?? '', /Max-Age=/);
    const remembered = await api(origin, 'login', 'POST', { username: '会话玩家', password: '1234', remember: true });
    assert.match(remembered.setCookie ?? '', /Max-Age=604800/);
    const secondSession = await api(origin, 'login', 'POST', { username: '会话玩家', password: '1234', remember: false });

    const changed = await api(origin, 'password', 'POST', {
      currentPassword: '1234', newPassword: '新密码四', remember: true,
    }, remembered.cookie);
    assert.equal(changed.status, 200);
    assert.match(changed.setCookie ?? '', /Max-Age=604800/);
    assert.equal((await api(origin, 'me', 'GET', undefined, secondSession.cookie)).body.user, null);
    assert.equal((await api(origin, 'me', 'GET', undefined, remembered.cookie)).body.user, null);
    assert.equal((await api(origin, 'me', 'GET', undefined, changed.cookie)).body.user !== null, true);
    assert.equal((await api(origin, 'login', 'POST', {
      username: '会话玩家', password: '1234', remember: false,
    })).status, 401);
    assert.equal((await api(origin, 'login', 'POST', {
      username: '会话玩家', password: '新密码四', remember: false,
    })).status, 200);

    assert.equal((await api(origin, 'logout', 'POST', {}, changed.cookie)).status, 200);
    assert.equal((await api(origin, 'me', 'GET', undefined, changed.cookie)).body.user, null);
  } finally {
    await closeServer(server);
  }
});

test('sessions expire after seven days and survive a Node service restart', async () => {
  const authDbPath = tempPath();
  let currentTime = Date.UTC(2026, 10, 8, 8, 0, 0);
  const now = () => currentTime;
  const first = await startServer({ authDbPath, now });
  const registered = await register(first.origin, '持久玩家', '1234', true);
  currentTime += 6 * 24 * 60 * 60 * 1000;
  assert.equal((await api(first.origin, 'me', 'GET', undefined, registered.cookie)).body.user !== null, true);
  await closeServer(first.server);

  const second = await startServer({ authDbPath, now });
  try {
    assert.equal((await api(second.origin, 'me', 'GET', undefined, registered.cookie)).body.user !== null, true);
    currentTime += 24 * 60 * 60 * 1000 + 1;
    assert.equal((await api(second.origin, 'me', 'GET', undefined, registered.cookie)).body.user, null);
    const shortLogin = await api(second.origin, 'login', 'POST', {
      username: '持久玩家', password: '1234', remember: false,
    });
    currentTime += 12 * 60 * 60 * 1000 + 1;
    assert.equal((await api(second.origin, 'me', 'GET', undefined, shortLogin.cookie)).body.user, null);
  } finally {
    await closeServer(second.server);
  }
});

test('CORS whitelist and Android cross-site session cookies preserve web cookies', async () => {
  const { server, origin } = await startServer({ cookieSecure: true });
  try {
    const androidPreflight = await fetch(`${origin}/three-chess/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(androidPreflight.status, 204);
    assert.equal(androidPreflight.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal(androidPreflight.headers.get('access-control-allow-credentials'), 'true');
    assert.match(androidPreflight.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.match(androidPreflight.headers.get('access-control-allow-headers') ?? '', /Content-Type/i);

    const localPreflight = await fetch(`${origin}/three-chess/api/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:3100', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(localPreflight.status, 204);
    assert.equal(localPreflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3100');

    const androidRegistered = await api(origin, 'register', 'POST', {
      username: '安卓跨站会话', password: '1234', remember: true,
    }, null, { Origin: 'https://localhost' });
    assert.equal(androidRegistered.status, 200);
    assert.equal(androidRegistered.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.match(androidRegistered.setCookie ?? '', /HttpOnly/);
    assert.match(androidRegistered.setCookie ?? '', /SameSite=None/);
    assert.match(androidRegistered.setCookie ?? '', /Secure/);
    assert.match(androidRegistered.setCookie ?? '', /Path=\/three-chess/);
    assert.match(androidRegistered.setCookie ?? '', /Max-Age=604800/);

    const androidLogin = await api(origin, 'login', 'POST', {
      username: '安卓跨站会话', password: '1234', remember: false,
    }, null, { Origin: 'https://localhost' });
    assert.equal(androidLogin.status, 200);
    assert.match(androidLogin.setCookie ?? '', /SameSite=None/);
    assert.match(androidLogin.setCookie ?? '', /Secure/);
    assert.doesNotMatch(androidLogin.setCookie ?? '', /Max-Age=/);

    const androidLogout = await api(origin, 'logout', 'POST', {}, androidRegistered.cookie,
      { Origin: 'https://localhost' });
    assert.match(androidLogout.setCookie ?? '', /SameSite=None/);
    assert.match(androidLogout.setCookie ?? '', /Secure/);
    assert.match(androidLogout.setCookie ?? '', /Max-Age=0/);

    const clearedInvalid = await api(origin, 'me', 'GET', undefined, 'three_chess_session=invalid',
      { Origin: 'https://localhost' });
    assert.match(clearedInvalid.setCookie ?? '', /SameSite=None/);
    assert.match(clearedInvalid.setCookie ?? '', /Secure/);
    assert.match(clearedInvalid.setCookie ?? '', /Max-Age=0/);

    const webRegistered = await api(origin, 'register', 'POST', {
      username: '网页同站会话', password: '1234', remember: true,
    }, null, { Origin: 'https://47.95.251.153' });
    assert.equal(webRegistered.status, 200);
    assert.equal(webRegistered.headers.get('access-control-allow-origin'), 'https://47.95.251.153');
    assert.match(webRegistered.setCookie ?? '', /SameSite=Lax/);
    assert.match(webRegistered.setCookie ?? '', /Secure/);
    assert.doesNotMatch(webRegistered.setCookie ?? '', /SameSite=None/);

    const denied = await fetch(`${origin}/three-chess/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.invalid',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally {
    await closeServer(server);
  }
});

test('recovery user flow is removed while the legacy recovery column remains intact', async () => {
  const authDbPath = tempPath();
  const legacy = new DatabaseSync(authDbPath);
  legacy.exec(`
    CREATE TABLE auth_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      recovery_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    INSERT INTO auth_users VALUES ('legacy-user', '兼容玩家', '兼容玩家', 'scrypt$legacy', 'legacy-preserved', 1, 1);
    PRAGMA user_version = 1;
  `);
  legacy.close();
  const authService = new AuthService(authDbPath);
  const { server, origin } = await startServer({ authService });
  try {
    assert.equal((await api(origin, 'recovery/reset', 'POST', {})).status, 404);
    assert.equal((await api(origin, 'recovery/regenerate', 'POST', {})).status, 404);
    const verification = new DatabaseSync(authDbPath, { readOnly: true });
    const version = verification.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    const rawRow = verification.prepare('SELECT recovery_hash FROM auth_users WHERE id = ?').get('legacy-user');
    const row = rawRow as unknown as { recovery_hash: string };
    const gameTable = verification.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_records'").get();
    const avatarColumn = verification.prepare("SELECT name FROM pragma_table_info('auth_users') WHERE name = 'avatar_data'").get();
    verification.close();
    assert.equal(version.user_version, 5);
    assert.equal(row.recovery_hash, 'legacy-preserved');
    assert.ok(gameTable);
    assert.ok(avatarColumn);
  } finally {
    await closeServer(server);
  }
});

test('authenticated accounts can upload, serve, and remove a bounded square avatar', async () => {
  const { server, origin } = await startServer();
  try {
    const registered = await register(origin, '头像玩家');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const uploaded = await api(origin, 'avatar', 'POST', { avatarData: png }, registered.cookie);
    assert.equal(uploaded.status, 200);
    const user = uploaded.body.user as { avatarUrl: string | null };
    assert.match(user.avatarUrl ?? '', /^\/three-chess\/api\/avatar\//);

    const image = await fetch(`${origin}${user.avatarUrl}`, {
      headers: { Origin: 'https://localhost' },
    });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.match(image.headers.get('cache-control') ?? '', /public, max-age=31536000, immutable/);
    const imageBytes = Buffer.from(await image.arrayBuffer());
    assert.ok(imageBytes.length > 20);
    assert.deepEqual([...imageBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    const restored = await api(origin, 'me', 'GET', undefined, registered.cookie,
      { Origin: 'https://localhost' });
    assert.equal(restored.status, 200);
    assert.equal((restored.body.user as { avatarUrl: string | null }).avatarUrl, user.avatarUrl);

    const relogin = await api(origin, 'login', 'POST', {
      username: '头像玩家', password: '1234', remember: true,
    }, null, { Origin: 'https://localhost' });
    assert.equal(relogin.status, 200);
    assert.equal((relogin.body.user as { avatarUrl: string | null }).avatarUrl, user.avatarUrl);

    const invalid = await api(origin, 'avatar', 'POST', { avatarData: 'not-an-image' }, registered.cookie);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'INVALID_AVATAR');

    const removed = await api(origin, 'avatar', 'POST', { avatarData: null }, registered.cookie);
    assert.equal(removed.status, 200);
    assert.equal((removed.body.user as { avatarUrl: string | null }).avatarUrl, null);
  } finally {
    await closeServer(server);
  }
});

test('authenticated Socket.IO rooms use the server account nickname and reject another account resuming the seat', async () => {
  const { server, origin } = await startServer();
  const sockets: Socket[] = [];
  try {
    const first = await register(origin, '账号魏', '1234');
    const second = await register(origin, '账号蜀', '1234');
    const owner = await socketClient(origin, first.cookie!);
    sockets.push(owner);
    const receiptAck = await send<SessionReceipt>(owner, 'room:create', {
      roomCode: '880001', nickname: '伪造昵称', userId: 'forged-user-id',
    });
    if (!receiptAck.ok) assert.fail(receiptAck.error);
    assert.equal(receiptAck.data.state.players[0].nickname, '账号魏');
    assert.equal(receiptAck.data.state.players[0].identity, 'account');

    const intruder = await socketClient(origin, second.cookie!);
    sockets.push(intruder);
    const resume = await send<SessionReceipt>(intruder, 'room:resume', {
      roomCode: receiptAck.data.roomCode, reconnectToken: receiptAck.data.reconnectToken,
    });
    assert.equal(resume.ok, false);
    if (!resume.ok) assert.equal(resume.code, 'AUTH_MISMATCH');

    const guest = await socketClient(origin);
    sockets.push(guest);
    const guestReceipt = await send<SessionReceipt>(guest, 'room:create', {
      roomCode: '880002', nickname: '账号魏',
    });
    if (!guestReceipt.ok) assert.fail(guestReceipt.error);
    assert.equal(guestReceipt.data.state.players[0].identity, 'guest');
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await closeServer(server);
  }
});

test('login attempts enforce short fixed-window rate limits without permanently locking accounts', async () => {
  let currentTime = Date.now();
  const authService = new AuthService(':memory:', { now: () => currentTime });
  const { server, origin } = await startServer({ authService, now: () => currentTime });
  try {
    await register(origin, '限流玩家', '1234');
    let lastStatus = 0;
    for (let attempt = 0; attempt < 11; attempt++) {
      lastStatus = (await api(origin, 'login', 'POST', {
        username: '限流玩家', password: 'wrong', remember: false,
      })).status;
    }
    assert.equal(lastStatus, 429);
    currentTime += 15 * 60 * 1000 + 1;
    assert.equal((await api(origin, 'login', 'POST', {
      username: '限流玩家', password: '1234', remember: false,
    })).status, 200);
  } finally {
    await closeServer(server);
  }
});

test('registration rate limits are configurable for shared networks and use server-side time windows', async () => {
  let currentTime = Date.now();
  const now = () => currentTime;
  const authService = new AuthService(':memory:', {
    now,
    rateLimits: { registerAttempts: 3, registerWindowMs: 1_000 },
  });
  const { server, origin } = await startServer({ authService, now });
  try {
    for (let index = 0; index < 3; index++)
      await register(origin, `共享设备账号${index}`, '1234');
    const limited = await api(origin, 'register', 'POST', { username: '共享设备账号4', password: '1234', remember: false });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.body.retryAfterSeconds ?? 1) >= 1);
    currentTime += 1_001;
    assert.equal((await api(origin, 'register', 'POST', {
      username: '共享设备账号4', password: '1234', remember: false,
    })).status, 200);
  } finally {
    await closeServer(server);
  }
});
