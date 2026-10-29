import express from 'express';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { RoomService, type InternalRoom } from './room-service.ts';
import type { ClientAck, MoveIntent, RoomView, SessionReceipt } from '../src/online.ts';

export function createOnlineServer() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { path: '/three-chess/socket.io', cors: { origin: true, credentials: true } });
  const broadcast = (room?: InternalRoom) => {
    if (!room) return;
    if (rooms.getRoom(room.code) !== room) {
      for (const socketId of rooms.spectatorSockets(room)) {
        io.to(socketId).emit('room:closed', room.code);
        io.sockets.sockets.get(socketId)?.leave(room.code);
      }
      rooms.closeSpectators(room);
      return;
    }
    for (const item of rooms.views(room)) io.to(item.socketId).emit('room:state', item.state);
  };
  const rooms = new RoomService(broadcast);

  app.disable('x-powered-by');
  app.get('/three-chess/api/health', (_request, response) => response.json({ ok: true, service: 'three-kingdoms-chess', storage: 'memory' }));
  const sendIndex = (_request: express.Request, response: express.Response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.sendFile(resolve(root, 'dist/index.html'));
  };
  app.get(['/three-chess', '/three-chess/'], sendIndex);
  app.use('/three-chess/audio', express.static(resolve(root, 'dist/audio'), { index: false, maxAge: '1h' }));
  app.use('/three-chess', express.static(resolve(root, 'dist'), { index: false, immutable: true, maxAge: '1y' }));
  app.get('/three-chess/{*path}', sendIndex);

  io.on('connection', socket => {
    socket.on('room:watch', (payload: { roomCode?: unknown }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = rooms.watchRoom(payload?.roomCode, socket.id);
      if (result.ack.ok) {
        const { state, previousCode } = result.ack.data;
        if (previousCode && previousCode !== state.code) socket.leave(previousCode);
        socket.join(state.code);
        done({ ok: true, data: { state } });
      } else done(result.ack);
    });
    socket.on('room:unwatch', (payload: { roomCode?: string }, done: (ack: ClientAck) => void) => {
      const code = rooms.unwatch(socket.id, payload?.roomCode);
      if (code) socket.leave(code);
      done({ ok: true, data: undefined });
    });
    socket.on('room:create', (payload: { roomCode?: unknown; nickname?: unknown }, done: (ack: ClientAck<SessionReceipt>) => void) => {
      const result = rooms.createRoom(payload?.roomCode, payload?.nickname, socket.id);
      if (result.ack.ok) socket.join(result.ack.data.roomCode);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:join', (payload: { roomCode?: unknown; nickname?: unknown }, done: (ack: ClientAck<SessionReceipt>) => void) => {
      const result = rooms.joinRoom(payload?.roomCode, payload?.nickname, socket.id);
      if (result.ack.ok) socket.join(result.ack.data.roomCode);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:resume', (payload: { roomCode?: unknown; reconnectToken?: unknown }, done: (ack: ClientAck<SessionReceipt>) => void) => {
      const result = rooms.resumeRoom(payload?.roomCode, payload?.reconnectToken, socket.id);
      if (result.ack.ok) socket.join(result.ack.data.roomCode);
      if (result.replacedSocketId) {
        io.to(result.replacedSocketId).emit('session:replaced');
        io.sockets.sockets.get(result.replacedSocketId)?.disconnect(true);
      }
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:choose-faction', (payload: { roomCode?: unknown; reconnectToken?: unknown; faction?: unknown; round?: unknown }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = rooms.chooseFaction(payload?.roomCode, payload?.reconnectToken, payload?.faction, payload?.round, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:ready', (payload: { roomCode?: unknown; reconnectToken?: unknown; ready?: unknown; round?: unknown }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = rooms.setReady(payload?.roomCode, payload?.reconnectToken, payload?.ready, payload?.round, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:rematch', async (payload: { roomCode?: unknown; reconnectToken?: unknown; version?: unknown },
      done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = await rooms.rematchRoom(payload?.roomCode, payload?.reconnectToken, payload?.version, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:release-offline', (payload: { roomCode?: unknown; reconnectToken?: unknown; playerId?: unknown },
      done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = rooms.releaseOffline(payload?.roomCode, payload?.reconnectToken, payload?.playerId, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:leave', async (payload: { roomCode?: unknown; reconnectToken?: unknown }, done: (ack: ClientAck) => void) => {
      const result = await rooms.leaveRoom(payload?.roomCode, payload?.reconnectToken, socket.id);
      if (result.ack.ok && result.room) socket.leave(result.room.code);
      done(result.ack); broadcast(result.room);
    });
    socket.on('game:resign', async (payload: { roomCode?: unknown; reconnectToken?: unknown },
      done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = await rooms.resignRoom(payload?.roomCode, payload?.reconnectToken, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('game:offer-draw', async (payload: { roomCode?: unknown; reconnectToken?: unknown },
      done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = await rooms.offerDraw(payload?.roomCode, payload?.reconnectToken, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('game:respond-draw', async (payload: { roomCode?: unknown; reconnectToken?: unknown; offerId?: unknown; vote?: unknown },
      done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = await rooms.respondDraw(payload?.roomCode, payload?.reconnectToken, payload?.offerId, payload?.vote, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('game:move', async (payload: { roomCode?: unknown; reconnectToken?: unknown; intent?: MoveIntent }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = await rooms.submitMove(payload?.roomCode, payload?.reconnectToken, payload?.intent, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('disconnect', () => broadcast(rooms.disconnect(socket.id)));
  });

  return { app, httpServer, io, rooms };
}
