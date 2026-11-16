import express from 'express';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { RoomService, type InternalRoom } from './room-service.ts';
import { FiveSoldiersService } from './five-soldiers-service.ts';
import { AuthService, type AuthFailure, type AuthResult } from './auth-service.ts';
import { REMEMBER_SESSION_SECONDS } from '../src/auth.ts';
import type { AuthUser } from '../src/auth.ts';
import type { ClientAck, MoveIntent, PublicLobbySnapshot, PublicRoomSummary, RoomView, SessionReceipt } from '../src/online.ts';
import type { FiveAck, FiveMoveIntent, FiveReceipt, FiveState } from '../src/five-soldiers.ts';

const PUBLIC_LOBBY = 'three-kingdoms-chess:public-lobby';
const AUTH_COOKIE = 'three_chess_session';

export interface OnlineServerOptions {
  authService?: AuthService;
  authDbPath?: string;
  cookieSecure?: boolean;
  now?: () => number;
}

function authCookie(token: string, remember: boolean, secure: boolean): string {
  const parts = [`${AUTH_COOKIE}=${token}`, 'Path=/three-chess', 'HttpOnly', 'SameSite=Lax'];
  if (remember) parts.push(`Max-Age=${REMEMBER_SESSION_SECONDS}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearAuthCookie(secure: boolean): string {
  return `${authCookie('', false, secure)}; Max-Age=0`;
}

function cookieToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header.join('; ') : header;
  if (!value) return null;
  for (const item of value.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== AUTH_COOKIE) continue;
    const token = item.slice(separator + 1).trim();
    return token || null;
  }
  return null;
}

export function createOnlineServer(options: OnlineServerOptions = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { path: '/three-chess/socket.io', cors: { origin: true, credentials: true } });
  const dataRoot = process.env.THREE_CHESS_DATA_DIR
    ? resolve(process.env.THREE_CHESS_DATA_DIR)
    : resolve(root, '.data');
  const now = options.now ?? Date.now;
  const envNumber = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const authService = options.authService ?? new AuthService(
    options.authDbPath ?? (process.env.NODE_ENV === 'test' ? ':memory:' : resolve(dataRoot, 'auth.sqlite')),
    {
      now,
      rateLimits: {
        registerAttempts: envNumber('THREE_CHESS_REGISTER_LIMIT', 20),
        registerWindowMs: envNumber('THREE_CHESS_REGISTER_WINDOW_MINUTES', 60) * 60 * 1000,
        loginAttempts: envNumber('THREE_CHESS_LOGIN_LIMIT', 10),
        loginWindowMs: envNumber('THREE_CHESS_LOGIN_WINDOW_MINUTES', 15) * 60 * 1000,
      },
    },
  );
  const cookieSecure = options.cookieSecure ?? (process.env.NODE_ENV === 'production' && process.env.THREE_CHESS_COOKIE_SECURE !== '0');
  let lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  const lobbySnapshot = (): PublicLobbySnapshot => ({ rooms: rooms.publicRooms(10) });
  const flushLobby = () => {
    lobbyTimer = null;
    io.to(PUBLIC_LOBBY).emit('lobby:rooms', lobbySnapshot());
  };
  const scheduleLobby = () => {
    if (lobbyTimer) return;
    lobbyTimer = setTimeout(flushLobby, 50);
    lobbyTimer.unref?.();
  };
  const broadcast = (room?: InternalRoom) => {
    if (room) {
      if (rooms.getRoom(room.code) !== room) {
        for (const socketId of rooms.spectatorSockets(room)) {
          io.to(socketId).emit('room:closed', room.code);
          io.sockets.sockets.get(socketId)?.leave(room.code);
        }
        rooms.closeSpectators(room);
      } else {
        for (const item of rooms.views(room)) io.to(item.socketId).emit('room:state', item.state);
      }
    }
    scheduleLobby();
  };
  const rooms = new RoomService(broadcast, 60_000, 180_000,
    record => authService.saveCompletedGame(record), now);
  const five = new FiveSoldiersService(service => {
    for (const item of service.views()) io.to(item.socketId).emit('five:state', item.state);
  }, 60_000, 180_000, now);
  const internalError = <T>(done: (ack: ClientAck<T>) => void) =>
    done({ ok: false, code: 'INTERNAL_ERROR', error: '服务器暂时无法处理请求，请稍后重试。' });
  const fiveInternalError = <T>(done: (ack: FiveAck<T>) => void) =>
    done({ ok: false, code: 'INTERNAL_ERROR', error: '服务器暂时无法处理请求，请稍后重试。' });

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use('/three-chess/api/auth', express.json({ limit: '16kb', type: 'application/json' }));
  app.use('/three-chess/api/auth', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  const requestUser = (request: express.Request): AuthUser | null =>
    authService.authenticate(cookieToken(request.headers.cookie));
  const sendAuthFailure = (response: express.Response, result: AuthFailure) => {
    if (result.retryAfterSeconds) response.setHeader('Retry-After', String(result.retryAfterSeconds));
    response.status(result.status).json({ ok: false, code: result.code, error: result.error });
  };
  const sendAuthSuccess = (response: express.Response, result: AuthResult) => {
    if (!result.ok) return sendAuthFailure(response, result);
    if (result.sessionToken) response.setHeader('Set-Cookie',
      authCookie(result.sessionToken, result.remember === true, cookieSecure));
    response.json({ ok: true, user: result.user });
  };
  app.get('/three-chess/api/auth/me', (request, response) => {
    const user = requestUser(request);
    if (!user && cookieToken(request.headers.cookie)) response.setHeader('Set-Cookie', clearAuthCookie(cookieSecure));
    response.json({ ok: true, user });
  });
  app.post('/three-chess/api/auth/register', async (request, response, next) => {
    try {
      const result = await authService.register(request.body?.username, request.body?.password,
        request.body?.remember === true, request.ip ?? 'unknown');
      sendAuthSuccess(response, result);
    } catch (error) { next(error); }
  });
  app.post('/three-chess/api/auth/login', async (request, response, next) => {
    try {
      const result = await authService.login(request.body?.username, request.body?.password, request.body?.remember === true, request.ip ?? 'unknown');
      sendAuthSuccess(response, result);
    } catch (error) { next(error); }
  });
  app.post('/three-chess/api/auth/logout', (request, response) => {
    authService.logout(cookieToken(request.headers.cookie));
    response.setHeader('Set-Cookie', clearAuthCookie(cookieSecure));
    response.json({ ok: true });
  });
  app.post('/three-chess/api/auth/password', async (request, response, next) => {
    const user = requestUser(request);
    if (!user) return response.status(401).json({ ok: false, code: 'UNAUTHENTICATED', error: '请先登录。' });
    try {
      const result = await authService.changePassword(user, request.body?.currentPassword, request.body?.newPassword,
        request.body?.remember === true);
      sendAuthSuccess(response, result);
    } catch (error) { next(error); }
  });
  app.use('/three-chess/api/auth', (_request, response) => response.status(404).json({ ok: false, code: 'NOT_FOUND', error: '接口不存在。' }));
  app.use('/three-chess/api/auth', (error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error('Authentication request failed', error);
    response.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: '账号服务暂时不可用，请稍后重试。' });
  });
  app.use('/three-chess/api/games', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/three-chess/api/games/recent', (request, response) => {
    const user = requestUser(request);
    if (!user) return response.status(401).json({ ok: false, code: 'UNAUTHENTICATED', error: '请先登录。' });
    response.json({ ok: true, games: authService.recentGames(user.id, 5) });
  });
  app.get('/three-chess/api/games/:gameId', (request, response) => {
    const user = requestUser(request);
    if (!user) return response.status(401).json({ ok: false, code: 'UNAUTHENTICATED', error: '请先登录。' });
    const game = authService.gameForUser(user.id, request.params.gameId);
    if (!game) return response.status(404).json({ ok: false, code: 'GAME_NOT_FOUND', error: '没有找到这盘历史对局。' });
    response.json({ ok: true, game });
  });
  app.use('/three-chess/api/games', (error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error('Game history request failed', error);
    response.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: '历史对局暂时无法读取。' });
  });
  app.get('/three-chess/api/health', (_request, response) => response.json({
    ok: true, service: 'three-kingdoms-chess', storage: 'memory', accounts: 'sqlite',
  }));
  const sendIndex = (_request: express.Request, response: express.Response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.sendFile(resolve(root, 'dist/index.html'));
  };
  app.get(['/three-chess', '/three-chess/'], sendIndex);
  app.use('/three-chess/audio', express.static(resolve(root, 'dist/audio'), { index: false, maxAge: '1h' }));
  app.use('/three-chess/audio', (_request, response) => response.status(404).type('text/plain').send('Audio not found'));
  app.use('/three-chess', express.static(resolve(root, 'dist'), { index: false, immutable: true, maxAge: '1y' }));
  app.get('/three-chess/{*path}', sendIndex);

  io.on('connection', socket => {
    const currentUser = (): AuthUser | null => {
      const user = authService.authenticate(cookieToken(socket.handshake.headers.cookie));
      rooms.setSocketAccount(socket.id, user?.id ?? null);
      five.setSocketAccount(socket.id, user?.id ?? null);
      return user;
    };
    currentUser();
    socket.on('lobby:subscribe', (_payload: unknown, done: (ack: ClientAck<PublicLobbySnapshot>) => void) => {
      if (typeof done !== 'function') return;
      currentUser();
      socket.join(PUBLIC_LOBBY);
      done({ ok: true, data: lobbySnapshot() });
    });
    socket.on('lobby:unsubscribe', (_payload: unknown, done: (ack: ClientAck) => void) => {
      if (typeof done !== 'function') return;
      socket.leave(PUBLIC_LOBBY);
      done({ ok: true, data: undefined });
    });
    socket.on('five:inspect', (_payload: unknown, done: (ack: FiveAck<FiveState>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        done(five.inspect());
      } catch { fiveInternalError(done); }
    });
    socket.on('five:join', (payload: { nickname?: unknown; side?: unknown }, done: (ack: FiveAck<FiveReceipt>) => void) => {
      if (typeof done !== 'function') return;
      try {
        const user = currentUser();
        const result = five.join(user?.username ?? payload?.nickname, payload?.side, socket.id);
        done(result.ack);
        if (result.changed) for (const item of five.views()) io.to(item.socketId).emit('five:state', item.state);
      } catch { fiveInternalError(done); }
    });
    socket.on('five:resume', (payload: { reconnectToken?: unknown }, done: (ack: FiveAck<FiveReceipt>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = five.resume(payload?.reconnectToken, socket.id);
        if (result.ok && result.replacedSocketId) {
          io.to(result.replacedSocketId).emit('five:session-replaced');
          io.sockets.sockets.get(result.replacedSocketId)?.disconnect(true);
        }
        done(result.ack);
        if (result.changed) for (const item of five.views()) io.to(item.socketId).emit('five:state', item.state);
      } catch { fiveInternalError(done); }
    });
    socket.on('five:choose-side', (payload: { reconnectToken?: unknown; side?: unknown }, done: (ack: FiveAck<{ state: FiveState }>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = five.chooseSide(payload?.reconnectToken, payload?.side, socket.id);
        done(result.ack);
        if (result.changed) for (const item of five.views()) io.to(item.socketId).emit('five:state', item.state);
      } catch { fiveInternalError(done); }
    });
    socket.on('five:ready', (payload: { reconnectToken?: unknown; ready?: unknown }, done: (ack: FiveAck<{ state: FiveState }>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = five.setReady(payload?.reconnectToken, payload?.ready, socket.id);
        done(result.ack);
        if (result.changed) for (const item of five.views()) io.to(item.socketId).emit('five:state', item.state);
      } catch { fiveInternalError(done); }
    });
    socket.on('five:rematch', (payload: { reconnectToken?: unknown }, done: (ack: FiveAck<{ state: FiveState }>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = five.rematch(payload?.reconnectToken, socket.id);
        done(result.ack);
        if (result.changed) for (const item of five.views()) io.to(item.socketId).emit('five:state', item.state);
      } catch { fiveInternalError(done); }
    });
    socket.on('five:move', (payload: { reconnectToken?: unknown; intent?: unknown },
      done: (ack: FiveAck<{ state: FiveState }>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = five.move(payload?.reconnectToken, payload?.intent as FiveMoveIntent | undefined, socket.id);
        done(result.ack);
        if (result.changed) for (const item of five.views()) io.to(item.socketId).emit('five:state', item.state);
      } catch { fiveInternalError(done); }
    });
    socket.on('five:resign', (payload: { reconnectToken?: unknown }, done: (ack: FiveAck<{ state: FiveState }>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = five.resign(payload?.reconnectToken, socket.id);
        done(result.ack);
        if (result.changed) for (const item of five.views()) io.to(item.socketId).emit('five:state', item.state);
      } catch { fiveInternalError(done); }
    });
    socket.on('five:leave', (payload: { reconnectToken?: unknown }, done: (ack: FiveAck) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = five.leave(payload?.reconnectToken, socket.id);
        done(result.ack);
        if (result.changed) for (const item of five.views()) io.to(item.socketId).emit('five:state', item.state);
      } catch { fiveInternalError(done); }
    });
    socket.on('room:watch', (payload: { roomCode?: unknown }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      if (typeof done !== 'function') return;
      currentUser();
      const result = rooms.watchRoom(payload?.roomCode, socket.id);
      if (result.ack.ok) {
        const { state, previousCode } = result.ack.data;
        if (previousCode && previousCode !== state.code) socket.leave(previousCode);
        socket.join(state.code);
        done({ ok: true, data: { state } });
      } else done(result.ack);
    });
    socket.on('room:unwatch', (payload: { roomCode?: string }, done: (ack: ClientAck) => void) => {
      if (typeof done !== 'function') return;
      currentUser();
      const code = rooms.unwatch(socket.id, payload?.roomCode);
      if (code) socket.leave(code);
      done({ ok: true, data: undefined });
    });
    socket.on('room:create', (payload: { roomCode?: unknown; nickname?: unknown; listed?: unknown }, done: (ack: ClientAck<SessionReceipt>) => void) => {
      if (typeof done !== 'function') return;
      const user = currentUser();
      const result = rooms.createRoom(payload?.roomCode, user?.username ?? payload?.nickname, socket.id, payload?.listed);
      if (result.ack.ok) socket.join(result.ack.data.roomCode);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:join', (payload: { roomCode?: unknown; nickname?: unknown }, done: (ack: ClientAck<SessionReceipt>) => void) => {
      if (typeof done !== 'function') return;
      const user = currentUser();
      const result = rooms.joinRoom(payload?.roomCode, user?.username ?? payload?.nickname, socket.id);
      if (result.ack.ok) socket.join(result.ack.data.roomCode);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:inspect', (payload: { roomCode?: unknown }, done: (ack: ClientAck<PublicRoomSummary>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        done(rooms.inspectRoom(payload?.roomCode).ack);
      } catch { internalError(done); }
    });
    socket.on('room:claim-seat', async (payload: { roomCode?: unknown; nickname?: unknown; faction?: unknown; listed?: unknown },
      done: (ack: ClientAck<SessionReceipt>) => void) => {
      if (typeof done !== 'function') return;
      try {
        const user = currentUser();
        const result = await rooms.claimSeat(payload?.roomCode, user?.username ?? payload?.nickname,
          payload?.faction, payload?.listed, socket.id);
        if (result.ack.ok) socket.join(result.ack.data.roomCode);
        done(result.ack); broadcast(result.room);
      } catch { internalError(done); }
    });
    socket.on('room:resume', (payload: { roomCode?: unknown; reconnectToken?: unknown }, done: (ack: ClientAck<SessionReceipt>) => void) => {
      if (typeof done !== 'function') return;
      currentUser();
      const result = rooms.resumeRoom(payload?.roomCode, payload?.reconnectToken, socket.id);
      if (result.ack.ok) socket.join(result.ack.data.roomCode);
      if (result.replacedSocketId) {
        io.to(result.replacedSocketId).emit('session:replaced');
        io.sockets.sockets.get(result.replacedSocketId)?.disconnect(true);
      }
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:choose-faction', (payload: { roomCode?: unknown; reconnectToken?: unknown; faction?: unknown; round?: unknown }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      if (typeof done !== 'function') return;
      currentUser();
      const result = rooms.chooseFaction(payload?.roomCode, payload?.reconnectToken, payload?.faction, payload?.round, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:ready', (payload: { roomCode?: unknown; reconnectToken?: unknown; ready?: unknown; round?: unknown }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      if (typeof done !== 'function') return;
      currentUser();
      const result = rooms.setReady(payload?.roomCode, payload?.reconnectToken, payload?.ready, payload?.round, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:rematch', async (payload: { roomCode?: unknown; reconnectToken?: unknown; version?: unknown },
      done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = await rooms.rematchRoom(payload?.roomCode, payload?.reconnectToken, payload?.version, socket.id);
        done(result.ack); broadcast(result.room);
      } catch { internalError(done); }
    });
    socket.on('room:release-offline', (payload: { roomCode?: unknown; reconnectToken?: unknown; playerId?: unknown },
      done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      if (typeof done !== 'function') return;
      currentUser();
      const result = rooms.releaseOffline(payload?.roomCode, payload?.reconnectToken, payload?.playerId, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:leave', async (payload: { roomCode?: unknown; reconnectToken?: unknown }, done: (ack: ClientAck) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = await rooms.leaveRoom(payload?.roomCode, payload?.reconnectToken, socket.id);
        if (result.ack.ok && result.room) socket.leave(result.room.code);
        done(result.ack); broadcast(result.room);
      } catch { internalError(done); }
    });
    socket.on('game:resign', async (payload: { roomCode?: unknown; reconnectToken?: unknown },
      done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = await rooms.resignRoom(payload?.roomCode, payload?.reconnectToken, socket.id);
        done(result.ack); broadcast(result.room);
      } catch { internalError(done); }
    });
    socket.on('game:offer-draw', async (payload: { roomCode?: unknown; reconnectToken?: unknown },
      done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = await rooms.offerDraw(payload?.roomCode, payload?.reconnectToken, socket.id);
        done(result.ack); broadcast(result.room);
      } catch { internalError(done); }
    });
    socket.on('game:respond-draw', async (payload: { roomCode?: unknown; reconnectToken?: unknown; offerId?: unknown; vote?: unknown },
      done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = await rooms.respondDraw(payload?.roomCode, payload?.reconnectToken, payload?.offerId, payload?.vote, socket.id);
        done(result.ack); broadcast(result.room);
      } catch { internalError(done); }
    });
    socket.on('game:move', async (payload: { roomCode?: unknown; reconnectToken?: unknown; intent?: MoveIntent }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      if (typeof done !== 'function') return;
      try {
        currentUser();
        const result = await rooms.submitMove(payload?.roomCode, payload?.reconnectToken, payload?.intent, socket.id);
        done(result.ack); broadcast(result.room);
      } catch { internalError(done); }
    });
    socket.on('disconnect', () => {
      broadcast(rooms.disconnect(socket.id));
      if (five.disconnect(socket.id)) for (const item of five.views()) io.to(item.socketId).emit('five:state', item.state);
    });
  });

  return { app, httpServer, io, rooms, five, authService };
}
