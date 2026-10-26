import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { io, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/create-server.ts';
import type { ClientAck, SessionReceipt } from '../src/online.ts';

const server = createOnlineServer();
await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
GlobalRegistrator.register({ url: origin });
const { mount } = await import('@vue/test-utils');
const compiled = './.compiled-app.mts';
const { default: App } = await import(compiled);
after(async () => {
  GlobalRegistrator.unregister();
  await new Promise<void>(resolve => server.io.close(() => resolve()));
});

const waitUntil = async (condition: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};
const send = <T>(socket: Socket, event: string, payload: unknown): Promise<ClientAck<T>> =>
  new Promise(resolve => socket.emit(event, payload, resolve));
function success<T>(ack: ClientAck<T>): T {
  if (!ack.ok) assert.fail(`${ack.code}: ${ack.error}`);
  return ack.data;
}

test('browser component sends a legal move without crypto.randomUUID', async () => {
  localStorage.clear();
  const wrapper = mount(App, { attachTo: document.body });
  const otherClients: Socket[] = [];
  const oldRandomUUID = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  try {
    await wrapper.findAll('button').find(button => button.text() === '联机对弈')!.trigger('click');
    await waitUntil(() => wrapper.findAll('button').some(button => button.text() === '创建房间' && button.attributes('disabled') === undefined), 'Online connection did not open');
    await wrapper.get('input[autocomplete="nickname"]').setValue('界面魏');
    await wrapper.findAll('button').find(button => button.text() === '创建房间')!.trigger('click');
    await waitUntil(() => wrapper.find('.room-lobby').exists(), 'Room creation did not reach lobby');
    const saved = JSON.parse(localStorage.getItem('three-kingdoms-chess:online-session-v1')!);
    const code: string = saved.roomCode;
    assert.match(wrapper.get('.room-heading h2').text(), new RegExp(code));
    const others: SessionReceipt[] = [];
    for (const nickname of ['界面蜀', '界面吴']) {
      const socket = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
      otherClients.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      others.push(success(await send<SessionReceipt>(socket, 'room:join', { roomCode: code, nickname })));
    }
    await wrapper.findAll('button').find(button => button.text() === '魏 · 曹操')!.trigger('click');
    for (const [index, faction] of ['shu', 'wu'].entries()) {
      success(await send(otherClients[index], 'room:choose-faction', { roomCode: code, reconnectToken: others[index].reconnectToken, faction }));
      success(await send(otherClients[index], 'room:ready', { roomCode: code, reconnectToken: others[index].reconnectToken, ready: true }));
    }
    await wrapper.findAll('button').find(button => button.text() === '我已准备')!.trigger('click');
    await waitUntil(() => wrapper.find('.board-panel').exists(), 'Three players did not start the game');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    await wrapper.get('g.piece[aria-label="魏方兵，第1路第7线"]').trigger('click');
    assert.equal(wrapper.findAll('g.legal-point').length, 1);
    await wrapper.get('g.legal-point[aria-label="走到第1路第6线"]').trigger('click');
    await waitUntil(() => server.rooms.getRoom(code)?.game?.history.length === 1, `UI move failed: ${wrapper.find('.feedback').text()}`);
    assert.equal(server.rooms.getRoom(code)?.game?.turn, 'shu');
    await waitUntil(() => wrapper.findAll('.move-list li').length === 1, 'Move did not render on the client');
  } finally {
    if (oldRandomUUID) Object.defineProperty(globalThis.crypto, 'randomUUID', oldRandomUUID);
    else delete (globalThis.crypto as unknown as { randomUUID?: unknown }).randomUUID;
    wrapper.unmount();
    otherClients.forEach(socket => socket.disconnect());
  }
});
