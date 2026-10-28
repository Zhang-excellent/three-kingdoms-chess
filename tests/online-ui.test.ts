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
    await wrapper.get('input[aria-label="创建房间号"]').setValue('001234');
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
      success(await send(otherClients[index], 'room:choose-faction', { roomCode: code, reconnectToken: others[index].reconnectToken, faction, round: 1 }));
      success(await send(otherClients[index], 'room:ready', { roomCode: code, reconnectToken: others[index].reconnectToken, ready: true, round: 1 }));
    }
    await wrapper.findAll('button').find(button => button.text() === '我已准备')!.trigger('click');
    await waitUntil(() => wrapper.find('.board-panel').exists(), 'Three players did not start the game');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    await wrapper.get('g.piece[aria-label="魏方兵，第1路第7线"]').trigger('click');
    assert.equal(wrapper.findAll('g.legal-point').length, 1);
    await wrapper.get('g.legal-point[aria-label="走到第1路第6线"]').trigger('click');
    await waitUntil(() => server.rooms.getRoom(code)?.game?.history.length === 1, 'UI move failed');
    assert.equal(server.rooms.getRoom(code)?.game?.turn, 'shu');
    await waitUntil(() => wrapper.findAll('.move-list li').length === 1, 'Move did not render on the client');
  } finally {
    if (oldRandomUUID) Object.defineProperty(globalThis.crypto, 'randomUUID', oldRandomUUID);
    else delete (globalThis.crypto as unknown as { randomUUID?: unknown }).randomUUID;
    wrapper.unmount();
    otherClients.forEach(socket => socket.disconnect());
  }
});

test('spectator uses visible entry, sees lobby and live game, remains read-only, and restores after refresh', async () => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', `${origin}/three-chess/`);
  const players: Socket[] = [];
  let wrapper: ReturnType<typeof mount> | null = null;
  try {
    for (let index = 0; index < 3; index++) {
      const socket = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
      players.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }
    const a = success(await send<SessionReceipt>(players[0], 'room:create', { roomCode: '400002', nickname: '观战测试魏' }));
    const b = success(await send<SessionReceipt>(players[1], 'room:join', { roomCode: a.roomCode, nickname: '观战测试蜀' }));
    const c = success(await send<SessionReceipt>(players[2], 'room:join', { roomCode: a.roomCode, nickname: '观战测试吴' }));
    const receipts = [a, b, c];
    wrapper = mount(App, { attachTo: document.body });
    await wrapper.findAll('button').find(button => button.text() === '观战')!.trigger('click');
    await waitUntil(() => wrapper!.find('.watch-entry').exists(), 'Watch entry did not open');
    await wrapper.get('input[aria-label="观战房间号"]').setValue(a.roomCode);
    await waitUntil(() => wrapper!.findAll('button').some(button => button.text() === '进入观战' && button.attributes('disabled') === undefined), 'Watch socket did not connect');
    await wrapper.findAll('button').find(button => button.text() === '进入观战')!.trigger('click');
    await waitUntil(() => wrapper!.find('.watch-entry h2').text().includes(a.roomCode), 'Watcher did not enter full waiting room');
    assert.match(wrapper.get('.watch-entry').text(), /正在观战/);
    assert.equal(server.rooms.getRoom(a.roomCode)?.players.length, 3);
    for (const [index, faction] of ['wei', 'shu', 'wu'].entries())
      success(await send(players[index], 'room:choose-faction', { roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, faction, round: 1 }));
    for (let index = 0; index < 3; index++)
      success(await send(players[index], 'room:ready', { roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, ready: true, round: 1 }));
    await waitUntil(() => wrapper!.find('.board-panel').exists(), 'Watcher did not follow game start');
    assert.match(wrapper.get('.board-heading').text(), /正在观战/);
    assert.equal(wrapper.findAll('.board-tools button').some(button => button.text() === '认输'), false);
    await wrapper.get('g.piece[aria-label="魏方兵，第1路第7线"]').trigger('click');
    assert.match(wrapper.get('.feedback').text(), /正在观战/);
    assert.equal(wrapper.findAll('g.legal-point').length, 0);
    const version = server.rooms.getRoom(a.roomCode)!.version;
    success(await send(players[0], 'game:move', { roomCode: a.roomCode, reconnectToken: a.reconnectToken,
      intent: { requestId: 'watchui001', version, pieceId: 'wei-pawn-0-6', to: { x: 0, y: 5 } } }));
    await waitUntil(() => wrapper!.findAll('.move-list li').length === 1, 'Watcher did not receive the move');
    assert.equal(wrapper.get('.last-trail line').attributes('x1'), '50');
    await wrapper.findAll('button').find(button => button.text() === '翻转棋盘')!.trigger('click');
    assert.equal(wrapper.get('.last-trail line').attributes('x1'), '490');
    assert.match(wrapper.get('.last-move-card').text(), /\(1, 7\).*\(1, 6\)/);
    wrapper.unmount(); wrapper = null;
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.board-panel').exists(), 'Watch refresh did not restore room');
    assert.match(wrapper.get('.board-heading').text(), /正在观战/);
    assert.equal(wrapper.findAll('.move-list li').length, 1);
    assert.equal(server.rooms.getRoom(a.roomCode)?.players.length, 3);
    await wrapper.findAll('button').find(button => button.text() === '退出观战')!.trigger('click');
    assert.equal(wrapper.find('.board-panel').exists(), false);
    assert.equal(server.rooms.getRoom(a.roomCode)?.players.length, 3);
    await wrapper.findAll('button').find(button => button.text() === '观战')!.trigger('click');
    await wrapper.get('input[aria-label="观战房间号"]').setValue('FFFFFF');
    await wrapper.findAll('button').find(button => button.text() === '进入观战')!.trigger('click');
    await waitUntil(() => wrapper!.find('.connection-note.error').exists(), 'Missing room did not show an error');
    assert.match(wrapper.get('.connection-note.error').text(), /没有找到这个房间/);
    await wrapper.findAll('button').find(button => button.text() === '返回联机大厅')!.trigger('click');
    assert.equal(wrapper.find('.watch-entry').exists(), false);
  } finally {
    wrapper?.unmount(); players.forEach(socket => socket.disconnect());
  }
});

test('Wei, Shu and Wu restore their own fixed view and a turn change never rotates it', async () => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', `${origin}/three-chess/`);
  const players: Socket[] = [];
  let wrapper: ReturnType<typeof mount> | null = null;
  try {
    for (let index = 0; index < 3; index++) {
      const socket = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
      players.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }
    const a = success(await send<SessionReceipt>(players[0], 'room:create', { roomCode: '400003', nickname: '视角魏' }));
    const b = success(await send<SessionReceipt>(players[1], 'room:join', { roomCode: a.roomCode, nickname: '视角蜀' }));
    const c = success(await send<SessionReceipt>(players[2], 'room:join', { roomCode: a.roomCode, nickname: '视角吴' }));
    const receipts = [a, b, c];
    for (const [index, faction] of ['wei', 'shu', 'wu'].entries())
      success(await send(players[index], 'room:choose-faction', { roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, faction, round: 1 }));
    for (let index = 0; index < 3; index++)
      success(await send(players[index], 'room:ready', { roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, ready: true, round: 1 }));
    for (const [index, king, expectedX] of [
      [1, '蜀方刘备，第3路第1线', '380px'],
      [2, '吴方孙权，第7路第1线', '160px'],
      [0, '魏方曹操，第5路第10线', '270px'],
    ] as const) {
      localStorage.setItem('three-kingdoms-chess:online-session-v1', JSON.stringify({
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken,
        playerId: receipts[index].playerId, nickname: `视角${index}`,
      }));
      history.replaceState(null, '', `${origin}/three-chess/?mode=online&room=${a.roomCode}`);
      wrapper = mount(App, { attachTo: document.body });
      await waitUntil(() => wrapper!.find('.board-panel').exists(), 'Player view did not resume');
      const kingElement = wrapper.get(`g.piece[aria-label="${king}"]`);
      assert.match(kingElement.attributes('style')!, new RegExp(`translate\\(${expectedX}, 545px\\)`));
      assert.equal(wrapper.get('.board-svg').attributes('aria-label')?.includes('已翻转'), index !== 0);
      if (index === 1) {
        const version = server.rooms.getRoom(a.roomCode)!.version;
        success(await send(players[0], 'game:move', { roomCode: a.roomCode, reconnectToken: a.reconnectToken,
          intent: { requestId: 'viewturn001', version, pieceId: 'wei-pawn-0-6', to: { x: 0, y: 5 } } }));
        await waitUntil(() => wrapper!.findAll('.move-list li').length === 1, 'Shu view did not sync turn');
        assert.equal(wrapper.get('.board-svg').attributes('aria-label')?.includes('已翻转'), true);
        assert.equal(wrapper.get('.last-trail line').attributes('x1'), '490');
        await wrapper.findAll('button').find(button => button.text() === '观战')!.trigger('click');
        assert.equal(wrapper.findAll('dialog').some(dialog => dialog.element.open && dialog.text().includes('确认退出房间')), true);
        assert.equal(server.rooms.getRoom(a.roomCode)!.game?.results.shu, 'playing');
        await wrapper.findAll('button').find(button => button.text() === '继续对局')!.trigger('click');
        assert.equal(wrapper.find('.board-panel').exists(), true);
      }
      wrapper.unmount(); wrapper = null;
    }
  } finally { wrapper?.unmount(); players.forEach(socket => socket.disconnect()); }
});
