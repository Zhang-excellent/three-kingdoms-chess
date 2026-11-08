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
}

async function api(origin: string, path: string, method: 'GET' | 'POST', body?: Record<string, unknown>,
  cookie?: string | null): Promise<ApiResult> {
  const response = await fetch(`${origin}/three-chess/api/auth/${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  return {
    status: response.status,
    cookie: setCookie?.split(';')[0] ?? null,
    setCookie,
    body: await response.json() as Record<string, unknown>,
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
    assert.match(String(fourCharacterPassword.body.recoveryCode), /^TK-/);
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
    assert.equal(stored.recovery_hash.includes(String(fourCharacterPassword.body.recoveryCode)), false);
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

test('recovery codes require username plus code, reset once, rotate immediately, and revoke old sessions', async () => {
  const { server, origin } = await startServer();
  try {
    const registered = await register(origin, '恢复玩家', '1234');
    const oldCookie = registered.cookie!;
    const oldCode = String(registered.body.recoveryCode);
    const missingCode = await api(origin, 'recovery/reset', 'POST', {
      username: '恢复玩家', newPassword: '5678', remember: false,
    });
    assert.equal(missingCode.status, 400);
    const regenerated = await api(origin, 'recovery/regenerate', 'POST', {
      password: '1234',
    }, oldCookie);
    assert.equal(regenerated.status, 200);
    const regeneratedCode = String(regenerated.body.recoveryCode);
    assert.notEqual(regeneratedCode, oldCode);
    assert.equal((await api(origin, 'recovery/reset', 'POST', {
      username: '恢复玩家', recoveryCode: oldCode, newPassword: '5678', remember: false,
    })).status, 401);
    const reset = await api(origin, 'recovery/reset', 'POST', {
      username: ' 恢复玩家 ', recoveryCode: regeneratedCode, newPassword: '5678', remember: false,
    });
    assert.equal(reset.status, 200);
    const newCode = String(reset.body.recoveryCode);
    assert.notEqual(newCode, regeneratedCode);
    assert.equal((await api(origin, 'me', 'GET', undefined, oldCookie)).body.user, null);
    const reused = await api(origin, 'recovery/reset', 'POST', {
      username: '恢复玩家', recoveryCode: oldCode, newPassword: '9999', remember: false,
    });
    assert.equal(reused.status, 401);
    const nextReset = await api(origin, 'recovery/reset', 'POST', {
      username: '恢复玩家', recoveryCode: newCode, newPassword: '9999', remember: false,
    });
    assert.equal(nextReset.status, 200);
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

test('login and registration endpoints enforce short fixed-window rate limits without locking accounts', async () => {
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
