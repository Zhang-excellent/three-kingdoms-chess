import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/create-server.ts';
import type { ChineseEngineClient, ChineseEngineRequest } from '../server/pikafish-engine.ts';
import type { ChineseAck, ChineseReceipt, ChineseState } from '../src/chinese-chess.ts';

class FakeEngine implements ChineseEngineClient {
  readonly configured = true;
  readonly requests: ChineseEngineRequest[] = [];
  private readonly replies: Array<string | null> = [];
  reply(move: string | null): void { this.replies.push(move); }
  async bestMove(request: ChineseEngineRequest): Promise<string | null> {
    this.requests.push(structuredClone(request));
    return this.replies.shift() ?? null;
  }
  dispose(): void {}
}

const engine = new FakeEngine();
const server = createOnlineServer({ authDbPath: ':memory:', chineseEngine: engine });
const sockets: Socket[] = [];
let origin = '';

before(async () => {
  await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const socket of sockets) socket.disconnect();
  server.chinese.dispose();
  await new Promise<void>(resolve => server.io.close(() => resolve()));
  server.authService.close();
});

async function client(): Promise<Socket> {
  const socket = connect(origin, {
    path: '/three-chess/socket.io', forceNew: true, reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

const emit = <T>(socket: Socket, event: string, payload: unknown): Promise<ChineseAck<T>> =>
  new Promise(resolve => socket.emit(event, payload, resolve));

function success<T>(ack: ChineseAck<T>): T {
  if (!ack.ok) throw new Error(`${ack.code}: ${ack.error}`);
  return ack.data;
}

test('Socket.IO Chinese chess seats Pikafish and synchronizes its first move', async () => {
  const human = await client();
  const states: ChineseState[] = [];
  human.on('chinese:state', state => states.push(state));
  const seated = success(await emit<ChineseReceipt>(human, 'chinese:join', {
    nickname: '人机黑方',
    side: 'black',
  }));
  engine.reply('h2e2');
  const selected = success(await emit<{ state: ChineseState }>(human, 'chinese:engine-select', {
    reconnectToken: seated.reconnectToken,
    side: 'red',
  }));
  assert.equal(selected.state.engineSide, 'red');
  const started = success(await emit<{ state: ChineseState }>(human, 'chinese:ready', {
    reconnectToken: seated.reconnectToken,
    ready: true,
  })).state;
  assert.equal(started.engineThinking, true);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const latest = states.at(-1);
    if (latest?.game?.history.length === 1) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const latest = states.at(-1);
  assert.equal(latest?.game?.history.length, 1);
  assert.equal(latest?.game?.turn, 'black');
  assert.equal(latest?.engineThinking, false);
  assert.equal(engine.requests[0].moves.length, 0);
});
