import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { io, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/create-server.ts';
import { PENDING_LEAVES_KEY } from '../src/online.ts';
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

const waitUntil = async (condition: () => boolean, message: string, timeoutMs = 2500) => {
  const attempts = Math.ceil(timeoutMs / 50);
  for (let attempt = 0; attempt < attempts; attempt++) {
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
  const oldClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    await wrapper.findAll('button').find(button => button.text() === '好友组局')!.trigger('click');
    await waitUntil(() => wrapper.findAll('button').some(button => button.text() === '创建房间' && button.attributes('disabled') === undefined), 'Online connection did not open');
    await wrapper.get('input[autocomplete="nickname"]').setValue('界面魏');
    await wrapper.get('input[aria-label="创建房间号"]').setValue('001234');
    await wrapper.findAll('button').find(button => button.text() === '创建房间')!.trigger('click');
    await waitUntil(() => wrapper.find('.room-lobby').exists(), 'Room creation did not reach lobby');
    const saved = JSON.parse(localStorage.getItem('three-kingdoms-chess:online-session-v1')!);
    const code: string = saved.roomCode;
    assert.match(wrapper.get('.room-heading h2').text(), new RegExp(code));
    let copiedInvite = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { copiedInvite = value; } },
    });
    await wrapper.findAll('button').find(button => button.text() === '复制邀请链接')!.trigger('click');
    await waitUntil(() => wrapper.find('.invite-copy-dialog').text().includes('邀请链接已复制'), 'Copy success was not shown');
    const inviteText = (wrapper.get('.invite-copy-dialog textarea').element as HTMLTextAreaElement).value;
    const expectedInvite = `${origin}/?mode=online&room=${code}`;
    assert.equal(copiedInvite, expectedInvite);
    assert.equal(inviteText, expectedInvite);
    assert.deepEqual([...new URL(inviteText).searchParams.keys()].sort(), ['mode', 'room']);
    assert.equal(inviteText.includes('reconnectToken'), false);
    assert.equal(inviteText.includes('token'), false);
    await wrapper.get('.invite-copy-dialog .dialog-close').trigger('click');

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied'); } },
    });
    await wrapper.findAll('button').find(button => button.text() === '复制邀请链接')!.trigger('click');
    await waitUntil(() => wrapper.find('.invite-copy-dialog').text().includes('请手动复制邀请链接'), 'Copy fallback was not shown');
    assert.doesNotMatch(wrapper.get('.invite-copy-dialog').text(), /邀请链接已复制/);
    assert.equal((wrapper.get('.invite-copy-dialog textarea').element as HTMLTextAreaElement).value, expectedInvite);
    await wrapper.get('.invite-copy-dialog .dialog-close').trigger('click');
    const others: SessionReceipt[] = [];
    const guestNames = ['长昵称测试一二三四五六', '界面吴'];
    for (const nickname of guestNames) {
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
    assert.deepEqual(wrapper.findAll('.player-card h2').map(item => item.text()), ['界面魏', ...guestNames]);
    assert.equal(wrapper.findAll('.player-card h2')[1].attributes('title'), guestNames[0]);
    assert.match(wrapper.get('.board-heading').text(), /轮到 界面魏 行棋/);
    assert.match(wrapper.get('.board-heading').text(), /房间 001234/);
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    await wrapper.get('g.piece[aria-label="魏方兵，第1路第7线"]').trigger('click');
    assert.equal(wrapper.findAll('g.legal-point').length, 1);
    await wrapper.get('g.legal-point[aria-label="走到第1路第6线"]').trigger('click');
    await waitUntil(() => server.rooms.getRoom(code)?.game?.history.length === 1, 'UI move failed');
    assert.equal(server.rooms.getRoom(code)?.game?.turn, 'shu');
    await waitUntil(() => wrapper.findAll('.move-list li').length === 1, 'Move did not render on the client');
    otherClients[0].disconnect();
    await waitUntil(() => wrapper.find('.player-card.offline').exists(), 'Offline player was not marked on the card');
    assert.match(wrapper.get('.player-card.offline').text(), /离线/);
  } finally {
    if (oldRandomUUID) Object.defineProperty(globalThis.crypto, 'randomUUID', oldRandomUUID);
    else delete (globalThis.crypto as unknown as { randomUUID?: unknown }).randomUUID;
    if (oldClipboard) Object.defineProperty(navigator, 'clipboard', oldClipboard);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    wrapper.unmount();
    otherClients.forEach(socket => socket.disconnect());
  }
});

test('navigation away from an active room confirms exit and releases the server seat', async () => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', `${origin}/three-chess/?mode=lobby`);
  const players: Socket[] = [];
  let wrapper: ReturnType<typeof mount> | null = null;
  try {
    for (let index = 0; index < 2; index++) {
      const socket = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
      players.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }
    const a = success(await send<SessionReceipt>(players[0], 'room:create', {
      roomCode: '400006', nickname: '大厅魏', listed: true,
    }));
    const b = success(await send<SessionReceipt>(players[1], 'room:join', { roomCode: a.roomCode, nickname: '大厅蜀' }));
    success(await send(players[0], 'room:choose-faction', {
      roomCode: a.roomCode, reconnectToken: a.reconnectToken, faction: 'wei', round: 1,
    }));
    success(await send(players[1], 'room:choose-faction', {
      roomCode: a.roomCode, reconnectToken: b.reconnectToken, faction: 'shu', round: 1,
    }));
    success(await send(players[0], 'room:ready', { roomCode: a.roomCode, reconnectToken: a.reconnectToken, ready: true, round: 1 }));
    success(await send(players[1], 'room:ready', { roomCode: a.roomCode, reconnectToken: b.reconnectToken, ready: true, round: 1 }));

    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.findAll('.chess-club-table').some(card => card.text().includes('400006')), 'Public room did not appear');
    assert.equal(wrapper.findAll('.chess-club-table').length, 10);
    assert.match(wrapper.findAll('.chess-club-table')[0].text(), /公开房间/);
    await wrapper.get('.chess-club-table.empty .club-table-center .primary-button').trigger('click');
    assert.equal((wrapper.get('.lobby-seat-dialog').element as HTMLDialogElement).open, true);
    assert.match(wrapper.get('.lobby-seat-dialog').text(), /昵称：.*房间号：/);
    assert.equal(wrapper.get('.lobby-seat-dialog input[autocomplete="nickname"]').attributes('placeholder'), undefined);
    assert.doesNotMatch(wrapper.get('.lobby-seat-dialog').text(), /你的昵称/);
    assert.deepEqual(wrapper.findAll('.lobby-seat-dialog .seat-faction-state').map(item => item.text()), ['已选择', '空位', '空位']);
    assert.deepEqual(wrapper.findAll('.lobby-seat-dialog .lobby-seat-factions button').map(item => item.attributes('aria-pressed')), ['true', 'false', 'false']);
    await wrapper.get('.lobby-seat-dialog input[placeholder="输入 6 位数字房间号"]').setValue('123');
    await wrapper.findAll('.lobby-seat-dialog button').find(button => button.text() === '创建并入座')!.trigger('click');
    assert.match(wrapper.get('.seat-dialog-error').text(), /6 位数字/);
    assert.equal(wrapper.get('.lobby-seat-dialog input[placeholder="输入 6 位数字房间号"]').attributes('aria-invalid'), 'true');
    await wrapper.get('.lobby-seat-dialog .dialog-close').trigger('click');
    const roomCard = () => wrapper!.findAll('.chess-club-table').find(card => card.text().includes('400006'))!;
    assert.match(roomCard().text(), /2\/3 席/);
    await roomCard().find('.club-seat.wu').trigger('click');
    assert.deepEqual(wrapper.findAll('.lobby-seat-dialog .seat-faction-state').map(item => item.text()), ['已占用', '已占用', '已选择']);
    await wrapper.get('.lobby-seat-dialog input[autocomplete="nickname"]').setValue('大厅吴');
    await wrapper.get('.lobby-seat-dialog').findAll('button').find(button => button.text() === '加入并入座')!.trigger('click');
    await waitUntil(() => wrapper!.find('.room-lobby').exists(), 'Lobby join did not open the waiting room');
    await waitUntil(() => server.rooms.getRoom(a.roomCode)?.players.find(player => player.nickname === '大厅吴')?.faction === 'wu',
      'Lobby player faction was not recorded');
    await wrapper.findAll('button').find(button => button.text() === '我已准备')!.trigger('click');
    await waitUntil(() => wrapper!.find('.board-panel').exists(), 'Three lobby players did not start the game');

    const room = server.rooms.getRoom(a.roomCode)!;
    const appPlayer = room.players.find(player => player.nickname === '大厅吴')!;
    let latestRoomPlayers = room.players.length;
    players[0].on('room:state', state => { latestRoomPlayers = state.players.length; });
    await wrapper.findAll('.header-actions button').find(button => button.text() === '设置')!.trigger('click');
    await wrapper.get('.settings-dialog .dialog-close').trigger('click');
    await wrapper.findAll('.header-actions button').find(button => button.text() === '玩法说明')!.trigger('click');
    await wrapper.get('.rules-dialog .dialog-close').trigger('click');
    assert.equal(server.rooms.getRoom(a.roomCode)?.players.length, 3);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(server.rooms.getRoom(a.roomCode)?.players.length, 3);
    assert.ok(localStorage.getItem('three-kingdoms-chess:online-session-v1'));
    await wrapper.findAll('button').find(button => button.text() === '首页')!.trigger('click');
    assert.equal((wrapper.get('.reset-dialog[open]').element as HTMLDialogElement).open, true);
    assert.match(wrapper.get('.reset-dialog[open]').text(), /确认退出房间/);
    await wrapper.findAll('.reset-dialog[open] button').find(button => button.text() === '确认退出')!.trigger('click');
    await waitUntil(() => wrapper!.find('.home-page').exists(), 'Confirmed exit did not open the home page');
    await waitUntil(() => server.rooms.getRoom(a.roomCode)?.players.length === 2, 'Active exit did not release the room seat');
    await waitUntil(() => latestRoomPlayers === 2, 'Other player did not receive the released-seat update');
    assert.equal(server.rooms.getRoom(a.roomCode)?.players.some(player => player.id === appPlayer.id), false);
    assert.equal(server.rooms.getRoom(a.roomCode)?.game?.results.wu, 'lost');
    assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);
    await wrapper!.findAll('.header-actions button').find(button => button.text() === '对战大厅')!.trigger('click');
    await waitUntil(() => wrapper!.find('.lobby-page').exists(), 'Lobby did not open after leaving the room');
    assert.equal(wrapper!.find('.lobby-current-room').exists(), false);
    await wrapper!.findAll('.header-actions button').find(button => button.text() === '好友组局')!.trigger('click');
    await waitUntil(() => wrapper!.findAll('button').some(button =>
      button.text() === '创建房间' && button.attributes('disabled') === undefined), 'Could not join a new room after active exit');
    await wrapper!.get('.lobby-entry-card input[autocomplete="nickname"]').setValue('退房后新房');
    await wrapper!.get('input[aria-label="创建房间号"]').setValue('401008');
    await wrapper!.findAll('button').find(button => button.text() === '创建房间')!.trigger('click');
    await waitUntil(() => wrapper!.find('.room-lobby').exists(), 'New room did not open after active exit');
    assert.equal(server.rooms.getRoom('401008')?.players.length, 1);
  } finally { wrapper?.unmount(); players.forEach(socket => socket.disconnect()); }
});

test('browser back from an active game confirms exit and does not restore the old seat', async () => {
  localStorage.clear(); sessionStorage.clear();
  const players: Socket[] = [];
  let wrapper: ReturnType<typeof mount> | null = null;
  try {
    for (let index = 0; index < 3; index++) {
      const socket = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
      players.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }
    const a = success(await send<SessionReceipt>(players[0], 'room:create', { roomCode: '401005', nickname: '返回键魏' }));
    const b = success(await send<SessionReceipt>(players[1], 'room:join', { roomCode: a.roomCode, nickname: '返回键蜀' }));
    const c = success(await send<SessionReceipt>(players[2], 'room:join', { roomCode: a.roomCode, nickname: '返回键吴' }));
    const receipts = [a, b, c];
    for (const [index, faction] of ['wei', 'shu', 'wu'].entries())
      success(await send(players[index], 'room:choose-faction', {
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, faction, round: 1,
      }));
    for (let index = 0; index < 3; index++)
      success(await send(players[index], 'room:ready', {
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, ready: true, round: 1,
      }));
    localStorage.setItem('three-kingdoms-chess:online-session-v1', JSON.stringify({
      roomCode: a.roomCode, reconnectToken: a.reconnectToken, playerId: a.playerId, nickname: '返回键魏',
    }));
    history.replaceState({ page: 'home' }, '', `${origin}/three-chess/`);
    history.pushState({ page: 'room' }, '', `${origin}/three-chess/?mode=online&room=${a.roomCode}`);
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.board-panel').exists(), 'Active room did not restore before browser back');

    history.back();
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitUntil(() => wrapper!.find('.reset-dialog[open]').exists(), 'Browser back did not request exit confirmation');
    await wrapper.findAll('.reset-dialog[open] button').find(button => button.text() === '确认退出')!.trigger('click');
    await waitUntil(() => wrapper!.find('.home-page').exists(), 'Browser back did not complete room exit');
    await waitUntil(() => server.rooms.getRoom(a.roomCode)?.players.length === 2, 'Browser back did not release the player seat');
    assert.equal(server.rooms.getRoom(a.roomCode)?.game?.results.wei, 'lost');
    assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);
  } finally { wrapper?.unmount(); players.forEach(socket => socket.disconnect()); }
});

test('leaving a waiting room releases the seat and allows creating another room', async () => {
  localStorage.clear(); sessionStorage.clear();
  history.replaceState(null, '', `${origin}/three-chess/?mode=online`);
  const wrapper = mount(App, { attachTo: document.body });
  let code = '';
  try {
    await waitUntil(() => wrapper.findAll('button').some(button =>
      button.text() === '创建房间' && button.attributes('disabled') === undefined), 'Online connection did not open');
    await wrapper.get('.lobby-entry-card input[autocomplete="nickname"]').setValue('临时房主');
    await wrapper.get('input[aria-label="创建房间号"]').setValue('401001');
    await wrapper.findAll('button').find(button => button.text() === '创建房间')!.trigger('click');
    await waitUntil(() => wrapper.find('.room-lobby').exists(), 'Room creation did not open the waiting area');
    code = JSON.parse(localStorage.getItem('three-kingdoms-chess:online-session-v1')!).roomCode;
    assert.equal(server.rooms.getRoom(code)?.players.length, 1);

    await wrapper.findAll('.header-actions button').find(button => button.text() === '首页')!.trigger('click');
    await waitUntil(() => wrapper.find('.home-page').exists(), 'Waiting-room navigation did not open the home page');
    await waitUntil(() => server.rooms.getRoom(code) === undefined, 'Waiting-room exit did not remove the last seat');
    assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);

    await wrapper.findAll('.home-action-card').find(button => button.text() === '好友对战')!.trigger('click');
    await waitUntil(() => wrapper.findAll('button').some(button => button.text() === '创建房间' && button.attributes('disabled') === undefined),
      'Could not create another room after leaving');
    await wrapper.get('.lobby-entry-card input[autocomplete="nickname"]').setValue('新房主');
    await wrapper.get('input[aria-label="创建房间号"]').setValue('401002');
    await wrapper.findAll('button').find(button => button.text() === '创建房间')!.trigger('click');
    await waitUntil(() => wrapper.find('.room-lobby').exists(), 'New room did not open after leaving');
    assert.ok(server.rooms.getRoom('401002')?.players.length === 1);
  } finally { wrapper.unmount(); }
});

test('leaving while disconnected queues the exit and flushes it before a new room', async () => {
  localStorage.clear(); sessionStorage.clear();
  history.replaceState(null, '', `${origin}/three-chess/?mode=online`);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await waitUntil(() => wrapper.findAll('button').some(button =>
      button.text() === '创建房间' && button.attributes('disabled') === undefined), 'Online connection did not open');
    await wrapper.get('.lobby-entry-card input[autocomplete="nickname"]').setValue('断网离房');
    await wrapper.get('input[aria-label="创建房间号"]').setValue('401006');
    await wrapper.findAll('button').find(button => button.text() === '创建房间')!.trigger('click');
    await waitUntil(() => wrapper.find('.room-lobby').exists(), 'Offline-exit room did not open');
    const player = server.rooms.getRoom('401006')!.players[0];
    server.io.sockets.sockets.get(player.socketId!)?.disconnect(true);
    await new Promise(resolve => setTimeout(resolve, 80));
    await wrapper.findAll('.header-actions button').find(button => button.text() === '首页')!.trigger('click');
    await waitUntil(() => wrapper.find('.home-page').exists(), 'Offline exit did not allow page navigation');
    assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);
    assert.ok(JSON.parse(localStorage.getItem(PENDING_LEAVES_KEY) || '[]').length > 0);
    await waitUntil(() => server.rooms.getRoom('401006') === undefined, 'Queued exit was not flushed after reconnect', 6_000);
    assert.equal(localStorage.getItem(PENDING_LEAVES_KEY), null);

    await wrapper.findAll('.header-actions button').find(button => button.text() === '好友组局')!.trigger('click');
    await waitUntil(() => wrapper.findAll('button').some(button =>
      button.text() === '创建房间' && button.attributes('disabled') === undefined), 'Could not create after queued exit');
    await wrapper.get('.lobby-entry-card input[autocomplete="nickname"]').setValue('新房间玩家');
    await wrapper.get('input[aria-label="创建房间号"]').setValue('401007');
    await wrapper.findAll('button').find(button => button.text() === '创建房间')!.trigger('click');
    await waitUntil(() => wrapper.find('.room-lobby').exists(), 'New room did not open after queued exit');
    assert.equal(server.rooms.getRoom('401007')?.players.length, 1);
  } finally { wrapper.unmount(); }
});

test('browser back from a waiting room releases the seat and forward cannot revive it', async () => {
  localStorage.clear(); sessionStorage.clear();
  history.replaceState(null, '', `${origin}/three-chess/`);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await wrapper.findAll('.home-action-card').find(button => button.text() === '好友对战')!.trigger('click');
    await waitUntil(() => wrapper.findAll('button').some(button =>
      button.text() === '创建房间' && button.attributes('disabled') === undefined), 'Online connection did not open');
    await wrapper.get('.lobby-entry-card input[autocomplete="nickname"]').setValue('返回测试房主');
    await wrapper.get('input[aria-label="创建房间号"]').setValue('401003');
    await wrapper.findAll('button').find(button => button.text() === '创建房间')!.trigger('click');
    await waitUntil(() => wrapper.find('.room-lobby').exists(), 'Room did not open before browser back');
    assert.equal(server.rooms.getRoom('401003')?.players.length, 1);

    history.back();
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitUntil(() => wrapper.find('.home-page').exists(), 'Browser back did not leave the waiting room');
    await waitUntil(() => server.rooms.getRoom('401003') === undefined, 'Browser back did not release the waiting seat');
    assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);

    history.forward();
    await new Promise(resolve => setTimeout(resolve, 80));
    window.dispatchEvent(new PopStateEvent('popstate'));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);
    assert.equal(wrapper.find('.room-lobby').exists(), false);
    history.pushState({ page: 'room' }, '', `${origin}/three-chess/?mode=online&room=401003`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitUntil(() => wrapper.find('.invite-page').exists(), 'Reopening the old room URL did not query the room again');
    await waitUntil(() => wrapper.get('.invite-entry').text().includes('邀请已失效'), 'Old room URL was revived instead of rechecked');
    assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);
    assert.equal(server.rooms.getRoom('401003'), undefined);
  } finally { wrapper.unmount(); }
});

test('leaving a finished room to local play releases identity and keeps the result for others', async () => {
  localStorage.clear(); sessionStorage.clear();
  history.replaceState(null, '', `${origin}/three-chess/`);
  const players: Socket[] = [];
  let wrapper: ReturnType<typeof mount> | null = null;
  try {
    for (let index = 0; index < 3; index++) {
      const socket = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
      players.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }
    const a = success(await send<SessionReceipt>(players[0], 'room:create', { roomCode: '401004', nickname: '结束后离房' }));
    const b = success(await send<SessionReceipt>(players[1], 'room:join', { roomCode: a.roomCode, nickname: '结束蜀' }));
    const c = success(await send<SessionReceipt>(players[2], 'room:join', { roomCode: a.roomCode, nickname: '结束吴' }));
    const receipts = [a, b, c];
    for (const [index, faction] of ['wei', 'shu', 'wu'].entries())
      success(await send(players[index], 'room:choose-faction', {
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, faction, round: 1,
      }));
    for (let index = 0; index < 3; index++)
      success(await send(players[index], 'room:ready', {
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, ready: true, round: 1,
      }));
    localStorage.setItem('three-kingdoms-chess:online-session-v1', JSON.stringify({
      roomCode: a.roomCode, reconnectToken: a.reconnectToken, playerId: a.playerId, nickname: '结束后离房',
    }));
    history.replaceState(null, '', `${origin}/three-chess/?mode=online&room=${a.roomCode}`);
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.board-panel').exists(), 'Finished-room player did not resume');
    success(await send(players[1], 'game:resign', { roomCode: a.roomCode, reconnectToken: b.reconnectToken }));
    success(await send(players[2], 'game:resign', { roomCode: a.roomCode, reconnectToken: c.reconnectToken }));
    await waitUntil(() => wrapper!.find('.result-banner').exists(), 'Finished result did not render');

    await wrapper.findAll('.header-actions button').find(button => button.text() === '首页')!.trigger('click');
    await waitUntil(() => wrapper!.find('.home-page').exists(), 'Finished-room navigation did not open home');
    await wrapper.findAll('.home-action-card').find(button => button.text() === '本地试玩')!.trigger('click');
    await waitUntil(() => wrapper!.find('.local-workbench').exists(), 'Home did not open local play');
    await waitUntil(() => server.rooms.getRoom(a.roomCode)?.players.length === 2, 'Finished player identity was not released');
    assert.equal(server.rooms.getRoom(a.roomCode)?.game?.winner, 'wei');
    assert.equal(server.rooms.getRoom(a.roomCode)?.players.some(player => player.id === a.playerId), false);
    assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);
  } finally { wrapper?.unmount(); players.forEach(socket => socket.disconnect()); }
});

test('expired reconnect credentials are cleared without an obsolete-room error', async () => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('three-kingdoms-chess:online-session-v1', JSON.stringify({
    roomCode: '987654', reconnectToken: 'expired-token', playerId: 'expired-player', nickname: '过期玩家',
  }));
  history.replaceState(null, '', `${origin}/three-chess/?mode=online&room=987654`);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await waitUntil(() => wrapper.find('.lobby-page').exists(), 'Expired room did not return to the join flow');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(wrapper.find('.connection-note.error').exists(), false);
    assert.doesNotMatch(wrapper.text(), /原房间已失效/);
    assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);
    assert.equal(wrapper.find('.room-lobby').exists(), false);
  } finally { wrapper.unmount(); }
});

test('an invitation URL inspects the room, joins the chosen seat, and survives refresh', async () => {
  localStorage.clear(); sessionStorage.clear();
  const players: Socket[] = [];
  let wrapper: ReturnType<typeof mount> | null = null;
  try {
    const owner = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
    players.push(owner);
    await new Promise<void>((resolve, reject) => { owner.once('connect', resolve); owner.once('connect_error', reject); });
    const receipt = success(await send<SessionReceipt>(owner, 'room:create', {
      roomCode: '001357', nickname: '邀请房主', listed: false,
    }));
    const invite = `${origin}/three-chess/?mode=online&room=${receipt.roomCode}`;
    history.replaceState(null, '', invite);
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.invite-page').exists(), 'Invitation did not load the room page');
    await waitUntil(() => wrapper!.get('.invite-entry').text().includes('1/3'), 'Invitation room summary did not load');
    assert.equal(wrapper.get('.invite-page h1').text(), '好友邀请');
    assert.match(wrapper.get('.invite-entry').text(), /001357/);
    assert.match(wrapper.get('.invite-entry').text(), /1\/3/);
    assert.equal(wrapper.find('.invite-page input[autocomplete="nickname"]').attributes('placeholder'), undefined);
    await wrapper.get('.invite-page input[autocomplete="nickname"]').setValue('受邀魏');
    await wrapper.findAll('.invite-page button').find(button => button.text() === '加入房间')!.trigger('click');
    await waitUntil(() => wrapper!.find('.room-lobby').exists(), 'Invitation join did not open the waiting room');
    assert.equal(server.rooms.getRoom(receipt.roomCode)?.players.length, 2);
    const saved = JSON.parse(localStorage.getItem('three-kingdoms-chess:online-session-v1')!);
    assert.equal(saved.roomCode, '001357');

    wrapper.unmount();
    history.replaceState(null, '', invite);
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.room-lobby').exists(), 'Invitation room did not restore after refresh');
    assert.equal(server.rooms.getRoom(receipt.roomCode)?.players.length, 2);
    assert.equal(wrapper.text().includes('reconnectToken'), false);
  } finally { wrapper?.unmount(); players.forEach(socket => socket.disconnect()); }
});

test('a full or started invitation shows status and a spectator entry', async () => {
  localStorage.clear(); sessionStorage.clear();
  const players: Socket[] = [];
  let wrapper: ReturnType<typeof mount> | null = null;
  try {
    for (let index = 0; index < 3; index++) {
      const socket = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
      players.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }
    const a = success(await send<SessionReceipt>(players[0], 'room:create', { roomCode: '401358', nickname: '满房魏' }));
    const b = success(await send<SessionReceipt>(players[1], 'room:join', { roomCode: a.roomCode, nickname: '满房蜀' }));
    const c = success(await send<SessionReceipt>(players[2], 'room:join', { roomCode: a.roomCode, nickname: '满房吴' }));
    const receipts = [a, b, c];
    const invite = `${origin}/three-chess/?mode=online&room=${a.roomCode}`;
    history.replaceState(null, '', invite);
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.invite-page').exists(), 'Full invitation did not load');
    await waitUntil(() => wrapper!.get('.invite-entry').text().includes('房间已满'), 'Full invitation status did not load');
    assert.match(wrapper.get('.invite-entry').text(), /房间已满/);
    assert.ok(wrapper.findAll('.invite-page button').some(button => button.text() === '进入观战'));
    wrapper.unmount(); wrapper = null;

    for (const [index, faction] of ['wei', 'shu', 'wu'].entries())
      success(await send(players[index], 'room:choose-faction', {
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, faction, round: 1,
      }));
    for (let index = 0; index < 3; index++)
      success(await send(players[index], 'room:ready', {
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, ready: true, round: 1,
      }));
    assert.equal(server.rooms.getRoom(a.roomCode)?.phase, 'playing');

    history.replaceState(null, '', invite);
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.invite-page').exists(), 'Started invitation did not load');
    await waitUntil(() => wrapper!.get('.invite-entry').text().includes('对局已经开始'), 'Started invitation status did not load');
    assert.match(wrapper.get('.invite-entry').text(), /对局已经开始/);
    await wrapper.findAll('.invite-page button').find(button => button.text() === '进入观战')!.trigger('click');
    await waitUntil(() => wrapper!.find('.board-panel').exists(), 'Invitation spectator entry did not open the board');
    assert.equal(server.rooms.getRoom(a.roomCode)?.players.length, 3);
  } finally { wrapper?.unmount(); players.forEach(socket => socket.disconnect()); }
});

test('invalid invitations do not create rooms, and an existing room is never overwritten', async () => {
  localStorage.clear(); sessionStorage.clear();
  const players: Socket[] = [];
  let wrapper: ReturnType<typeof mount> | null = null;
  try {
    history.replaceState(null, '', `${origin}/three-chess/?mode=online&room=999998`);
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.invite-page').exists(), 'Missing invitation did not load');
    await waitUntil(() => wrapper!.get('.invite-entry').text().includes('邀请已失效'), 'Missing invitation was not explained');
    assert.equal(server.rooms.getRoom('999998'), undefined);
    assert.ok(wrapper.findAll('.invite-page button').some(button => button.text() === '返回大厅'));
    wrapper.unmount(); wrapper = null;

    for (let index = 0; index < 2; index++) {
      const socket = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
      players.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }
    const current = success(await send<SessionReceipt>(players[0], 'room:create', { roomCode: '401359', nickname: '原房主' }));
    const invited = success(await send<SessionReceipt>(players[1], 'room:create', { roomCode: '401360', nickname: '邀请房主' }));
    localStorage.setItem('three-kingdoms-chess:online-session-v1', JSON.stringify({
      roomCode: current.roomCode, reconnectToken: current.reconnectToken, playerId: current.playerId, nickname: '原房主',
    }));
    history.replaceState(null, '', `${origin}/three-chess/?mode=online&room=${invited.roomCode}`);
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.invite-page').exists(), 'Existing-room conflict did not load');
    await waitUntil(() => wrapper!.get('.invite-entry').text().includes('你已在房间 401359'), 'Existing room was not identified');
    assert.match(wrapper.get('.invite-entry').text(), /不会自动退出或覆盖/);
    assert.ok(wrapper.findAll('.invite-page button').some(button => button.text() === '返回原房间'));
    assert.ok(wrapper.findAll('.invite-page button').some(button => button.text() === '退出原房间并加入邀请'));
    const saved = JSON.parse(localStorage.getItem('three-kingdoms-chess:online-session-v1')!);
    assert.equal(saved.roomCode, '401359');
    assert.equal(saved.reconnectToken, current.reconnectToken);
    assert.equal(server.rooms.getRoom(current.roomCode)?.players.length, 1);
    assert.equal(server.rooms.getRoom(invited.roomCode)?.players.length, 1);

    await wrapper.findAll('.invite-page button').find(button => button.text() === '退出原房间并加入邀请')!.trigger('click');
    await waitUntil(() => !wrapper!.get('.invite-entry').text().includes('你已在房间')
      && wrapper!.get('.invite-entry').text().includes('1/3'), 'Invitation did not open after leaving the original room');
    assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);
    await wrapper.findAll('.invite-page button').find(button => button.text() === '加入房间')!.trigger('click');
    await waitUntil(() => wrapper!.find('.room-lobby').exists(), 'Invitation was not joined after leaving the original room');
    assert.equal(JSON.parse(localStorage.getItem('three-kingdoms-chess:online-session-v1')!).roomCode, '401360');
  } finally { wrapper?.unmount(); players.forEach(socket => socket.disconnect()); }
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
    assert.match(wrapper.get('.board-heading').text(), new RegExp(`房间 ${a.roomCode}`));
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
    assert.match(wrapper.get('.board-heading').text(), new RegExp(`房间 ${a.roomCode}`));
    assert.equal(wrapper.findAll('.move-list li').length, 1);
    assert.equal(server.rooms.getRoom(a.roomCode)?.players.length, 3);
    await wrapper.findAll('button').find(button => button.text() === '退出观战')!.trigger('click');
    assert.equal(wrapper.find('.board-panel').exists(), false);
    await waitUntil(() => wrapper!.find('.lobby-page').exists(), 'Exiting spectating did not finish navigation');
    assert.equal(server.rooms.getRoom(a.roomCode)?.players.length, 3);
    await wrapper.findAll('button').find(button => button.text() === '观战')!.trigger('click');
    await waitUntil(() => wrapper!.find('input[aria-label="观战房间号"]').exists(), 'Watch entry did not reopen');
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
      [1, '蜀方刘备，第7路第1线', '160px'],
      [2, '吴方孙权，第3路第1线', '380px'],
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
        await wrapper.findAll('button').find(button => button.text() === '首页')!.trigger('click');
        await wrapper.findAll('.reset-dialog[open] button').find(button => button.text() === '确认退出')!.trigger('click');
        await waitUntil(() => wrapper!.find('.home-page').exists(), 'Player navigation did not open the home page');
        assert.equal(server.rooms.getRoom(a.roomCode)!.game?.results.shu, 'lost');
        assert.equal(server.rooms.getRoom(a.roomCode)!.players.some(player => player.id === b.playerId), false);
        assert.equal(localStorage.getItem('three-kingdoms-chess:online-session-v1'), null);
      }
      wrapper.unmount(); wrapper = null;
    }
  } finally { wrapper?.unmount(); players.forEach(socket => socket.disconnect()); }
});

test('online draw prompt only enables for the current player and both opponents can approve', async () => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', `${origin}/three-chess/`);
  const players: Socket[] = [];
  let wrapper: ReturnType<typeof mount> | null = null;
  try {
    for (let index = 0; index < 3; index++) {
      const socket = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
      players.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }
    const a = success(await send<SessionReceipt>(players[0], 'room:create', { roomCode: '400004', nickname: '提和魏' }));
    const b = success(await send<SessionReceipt>(players[1], 'room:join', { roomCode: a.roomCode, nickname: '提和蜀' }));
    const c = success(await send<SessionReceipt>(players[2], 'room:join', { roomCode: a.roomCode, nickname: '提和吴' }));
    const receipts = [a, b, c];
    for (let index = 0; index < 3; index++) {
      success(await send(players[index], 'room:choose-faction', {
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, faction: ['wei', 'shu', 'wu'][index], round: 1,
      }));
      success(await send(players[index], 'room:ready', {
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, ready: true, round: 1,
      }));
    }
    success(await send(players[0], 'game:offer-draw', { roomCode: a.roomCode, reconnectToken: a.reconnectToken }));
    const room = server.rooms.getRoom(a.roomCode)!;
    const offerId = room.drawOffer!.id;

    localStorage.setItem('three-kingdoms-chess:online-session-v1', JSON.stringify({
      roomCode: a.roomCode, reconnectToken: b.reconnectToken, playerId: b.playerId, nickname: '提和蜀',
    }));
    history.replaceState(null, '', `${origin}/three-chess/?mode=online&room=${a.roomCode}`);
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.draw-offer-card').exists(), 'Shu did not receive draw prompt');
    assert.match(wrapper.get('.draw-offer-card').text(), /提和魏发起和棋.*提和魏、提和蜀、提和吴须全部同意/);
    assert.equal(wrapper.findAll('.board-tools button').find(button => button.text() === '提和')?.attributes('disabled'), '');
    await wrapper.findAll('button').find(button => button.text() === '同意和棋')!.trigger('click');
    await waitUntil(() => room.drawOffer?.votes.shu === 'accept', 'Shu approval was not recorded');
    assert.match(wrapper.get('.draw-offer-card').text(), /已同意 2\/3/);
    wrapper.unmount(); wrapper = null;

    localStorage.setItem('three-kingdoms-chess:online-session-v1', JSON.stringify({
      roomCode: a.roomCode, reconnectToken: c.reconnectToken, playerId: c.playerId, nickname: '提和吴',
    }));
    wrapper = mount(App, { attachTo: document.body });
    await waitUntil(() => wrapper!.find('.draw-offer-card').exists(), 'Wu did not receive draw prompt');
    await wrapper.findAll('button').find(button => button.text() === '同意和棋')!.trigger('click');
    await waitUntil(() => room.phase === 'finished', 'Unanimous draw did not finish the game');
    await waitUntil(() => wrapper!.find('.result-banner').exists(), 'Draw result did not render');
    assert.match(wrapper.get('.result-banner').text(), /和棋.*提和魏、提和蜀、提和吴同意和棋/);
    assert.match(wrapper.get('.ranking-card').text(), /提和魏.*和棋.*提和蜀.*和棋.*提和吴.*和棋/);
    assert.equal(room.game?.winner, null);
    assert.equal(room.game?.status, 'finished');
  } finally { wrapper?.unmount(); players.forEach(socket => socket.disconnect()); }
});

test('all three factions use their default orientation and make a legal move', async () => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', `${origin}/three-chess/`);
  const players: Socket[] = [];
  const mountedWrappers: Array<ReturnType<typeof mount>> = [];
  try {
    for (let index = 0; index < 3; index++) {
      const socket = io(origin, { path: '/three-chess/socket.io', forceNew: true, reconnection: false });
      players.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }
    const a = success(await send<SessionReceipt>(players[0], 'room:create', { roomCode: '400005', nickname: '默认魏' }));
    const b = success(await send<SessionReceipt>(players[1], 'room:join', { roomCode: a.roomCode, nickname: '默认蜀' }));
    const c = success(await send<SessionReceipt>(players[2], 'room:join', { roomCode: a.roomCode, nickname: '默认吴' }));
    const receipts = [a, b, c];
    for (let index = 0; index < 3; index++) {
      success(await send(players[index], 'room:choose-faction', {
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, faction: ['wei', 'shu', 'wu'][index], round: 1,
      }));
      success(await send(players[index], 'room:ready', {
        roomCode: a.roomCode, reconnectToken: receipts[index].reconnectToken, ready: true, round: 1,
      }));
    }
    const room = server.rooms.getRoom(a.roomCode)!;
    const mountFaction = async (receipt: SessionReceipt, nickname: string): Promise<ReturnType<typeof mount>> => {
      localStorage.setItem('three-kingdoms-chess:online-session-v1', JSON.stringify({
        roomCode: a.roomCode, reconnectToken: receipt.reconnectToken, playerId: receipt.playerId, nickname,
      }));
      history.replaceState(null, '', `${origin}/three-chess/?mode=online&room=${a.roomCode}`);
      const mounted = mount(App, { attachTo: document.body });
      mountedWrappers.push(mounted);
      await waitUntil(() => mounted.find('.board-panel').exists(), `${nickname} board did not open`);
      return mounted;
    };

    let current = await mountFaction(a, '默认魏');
    assert.equal(current.get('.board-svg').attributes('aria-label')?.includes('已翻转'), false);
    assert.deepEqual(current.findAll('.river').map(river => river.text()), ['淮 河', '秦 岭']);
    assert.match(current.get('g.piece[aria-label="魏方曹操，第5路第10线"]').attributes('style')!, /translate\(270px, 545px\)/);
    await current.get('g.piece[aria-label="魏方兵，第1路第7线"]').trigger('click');
    await current.get('g.legal-point[aria-label="走到第1路第6线"]').trigger('click');
    await waitUntil(() => room.game?.history.length === 1 && room.game.turn === 'shu', 'Wei UI move failed');
    assert.match(current.get('.last-move-card').text(), /\(1, 7\).*\(1, 6\)/);
    current.unmount(); mountedWrappers.pop();

    current = await mountFaction(b, '默认蜀');
    assert.equal(current.get('.board-svg').attributes('aria-label')?.includes('已翻转'), true);
    assert.deepEqual(current.findAll('.river').map(river => river.text()), ['秦 岭', '淮 河']);
    assert.match(current.get('g.piece[aria-label="蜀方刘备，第7路第1线"]').attributes('style')!, /translate\(160px, 545px\)/);
    assert.match(current.get('g.piece[aria-label="吴方孙权，第3路第1线"]').attributes('style')!, /translate\(380px, 545px\)/);
    await current.get('g.piece[aria-label="蜀方卒，第9路第4线"]').trigger('click');
    const shuTarget = current.get('g.legal-point[aria-label="走到第9路第5线"]');
    assert.equal(shuTarget.find('circle').attributes('cx'), '50');
    assert.equal(shuTarget.find('circle').attributes('cy'), '325');
    await shuTarget.trigger('click');
    await waitUntil(() => room.game?.history.length === 2 && room.game.turn === 'wu', 'Shu UI move failed');
    assert.equal(current.get('.last-trail line').attributes('x1'), '50');
    assert.equal(current.get('.last-trail line').attributes('y1'), '380');
    assert.match(current.get('.last-move-card').text(), /\(9, 4\).*\(9, 5\)/);
    current.unmount(); mountedWrappers.pop();

    current = await mountFaction(c, '默认吴');
    assert.equal(current.get('.board-svg').attributes('aria-label')?.includes('已翻转'), true);
    assert.deepEqual(current.findAll('.river').map(river => river.text()), ['秦 岭', '淮 河']);
    assert.match(current.get('g.piece[aria-label="蜀方刘备，第7路第1线"]').attributes('style')!, /translate\(160px, 545px\)/);
    assert.match(current.get('g.piece[aria-label="吴方孙权，第3路第1线"]').attributes('style')!, /translate\(380px, 545px\)/);
    await current.get('g.piece[aria-label="吴方卒，第5路第4线"]').trigger('click');
    const wuTarget = current.get('g.legal-point[aria-label="走到第5路第5线"]');
    assert.equal(wuTarget.find('circle').attributes('cx'), '270');
    assert.equal(wuTarget.find('circle').attributes('cy'), '325');
    await wuTarget.trigger('click');
    await waitUntil(() => room.game?.history.length === 3 && room.game.turn === 'wei', 'Wu UI move failed');
    assert.equal(current.get('.last-trail line').attributes('x1'), '270');
    assert.equal(current.get('.last-trail line').attributes('y1'), '380');
    assert.match(current.get('.last-move-card').text(), /\(5, 4\).*\(5, 5\)/);
  } finally {
    for (const mounted of mountedWrappers) mounted.unmount();
    players.forEach(socket => socket.disconnect());
  }
});
