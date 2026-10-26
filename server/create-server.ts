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
  app.use('/three-chess', express.static(resolve(root, 'dist'), { index: false, immutable: true, maxAge: '1y' }));
  app.get('/three-chess/{*path}', sendIndex);

  io.on('connection', socket => {
    socket.on('room:create', (payload: { nickname?: unknown }, done: (ack: ClientAck<SessionReceipt>) => void) => {
      const result = rooms.createRoom(payload?.nickname, socket.id);
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
    socket.on('room:choose-faction', (payload: { roomCode?: unknown; reconnectToken?: unknown; faction?: unknown }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = rooms.chooseFaction(payload?.roomCode, payload?.reconnectToken, payload?.faction, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('room:ready', (payload: { roomCode?: unknown; reconnectToken?: unknown; ready?: unknown }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = rooms.setReady(payload?.roomCode, payload?.reconnectToken, payload?.ready, socket.id);
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
    socket.on('game:move', async (payload: { roomCode?: unknown; reconnectToken?: unknown; intent?: MoveIntent }, done: (ack: ClientAck<{ state: RoomView }>) => void) => {
      const result = await rooms.submitMove(payload?.roomCode, payload?.reconnectToken, payload?.intent, socket.id);
      done(result.ack); broadcast(result.room);
    });
    socket.on('disconnect', () => broadcast(rooms.disconnect(socket.id)));
  });

  return { app, httpServer, io, rooms };
}
