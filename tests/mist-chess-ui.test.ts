import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createOnlineServer } from '../server/create-server.ts';
import { MIST_CHESS_SESSION_KEY } from '../src/mist-chess.ts';

const server = createOnlineServer({ authDbPath: ':memory:' });
await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
GlobalRegistrator.register({ url: origin });
const { mount } = await import('@vue/test-utils');
const componentPath = './.compiled-MistChessPage.mts';
const { default: MistChessPage } = await import(componentPath);

after(async () => {
  localStorage.clear();
  GlobalRegistrator.unregister();
  server.mist.dispose();
  await new Promise<void>(resolve => server.io.close(() => resolve()));
  server.authService.close();
});

const waitUntil = async (condition: () => boolean, message: string, timeoutMs = 4500) => {
  const attempts = Math.ceil(timeoutMs / 50);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

async function enterGuestSeat(
  wrapper: Awaited<ReturnType<typeof mount>>,
  seatSelector: '.game-table-seat.red' | '.game-table-seat.black',
  nickname: string,
) {
  await waitUntil(
    () => !(wrapper.get(seatSelector).element as HTMLButtonElement).disabled,
    `${seatSelector} did not become available`,
  );
  const side = seatSelector.endsWith('.red') ? 'red' : 'black';
  (wrapper.vm as unknown as { openSeat: (side: 'red' | 'black') => void }).openSeat(side);
  const dialog = wrapper.get('.mist-seat-dialog').element as HTMLDialogElement;
  await waitUntil(() => dialog.open, 'Mist chess seat dialog did not open');
  await wrapper.get('.mist-seat-dialog input').setValue(nickname);
  await wrapper.get('.mist-seat-dialog form').trigger('submit');
  await waitUntil(() => wrapper.findAll('.mist-piece').length > 0
    && wrapper.text().includes(nickname), `${nickname} did not enter the board`);
}

test('mist chess opens one table, projects one side per player, hides opponent moves and never opens spectator board', async t => {
  localStorage.removeItem(MIST_CHESS_SESSION_KEY);
  const red = mount(MistChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => red.unmount());
  assert.equal(red.findAll('.game-table-seat').length, 2);
  assert.equal((red.get('.game-table-center').element as HTMLButtonElement).disabled, true);
  await waitUntil(() => red.get('.mist-page').attributes('data-connection') === 'online', `red did not connect: ${red.text()}`);
  await enterGuestSeat(red, '.game-table-seat.red', '迷雾红游客');
  assert.equal(red.findAll('.mist-piece').length, 18);
  assert.equal(red.findAll('.mist-piece.red').length, 16);
  assert.ok(red.findAll('.mist-fog-cell').length > 0);

  const redReady = red.findAll('button').find(button => button.text() === '开始');
  assert.ok(redReady);
  await redReady.trigger('click');
  await waitUntil(() => red.get('.self-seat').classes().includes('ready'), 'red ready state did not render');

  localStorage.removeItem(MIST_CHESS_SESSION_KEY);
  const black = mount(MistChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => black.unmount());
  await waitUntil(() => black.get('.mist-page').attributes('data-connection') === 'online', `black did not connect: ${black.text()}`);
  await waitUntil(() => black.get('.game-table-seat.red').text().includes('迷雾红游客'), 'black did not receive occupied red seat');
  await enterGuestSeat(black, '.game-table-seat.black', '迷雾黑游客');
  assert.equal(black.findAll('.mist-piece').length, 18);
  assert.equal(black.findAll('.mist-piece.black').length, 16);
  const blackReady = black.findAll('button').find(button => button.text() === '开始');
  assert.ok(blackReady);
  await blackReady.trigger('click');
  await waitUntil(() => red.get('.mist-board-heading').text().includes('轮到 迷雾红游客 行棋'), 'game did not start for red');
  await waitUntil(() => black.get('.mist-board-heading').text().includes('轮到 迷雾红游客 行棋'), 'game did not start for black');

  await red.get('.mist-piece[aria-label="红方兵，1 路第 7 线"]').trigger('click');
  await waitUntil(() => red.findAll('.mist-target').length === 1, 'server legal target did not render');
  await red.get('.mist-target[aria-label="走到第1路第6线"]').trigger('click');
  await waitUntil(() => red.get('.mist-history').text().includes('(1, 6)'), 'red own move did not render');
  await waitUntil(() => black.get('.mist-board-heading').text().includes('轮到 迷雾黑游客 行棋'), 'black did not receive turn update');
  assert.equal(black.get('.mist-history').text().includes('(1, 6)'), false);
  assert.equal(black.get('.mist-history').text().includes('共 1 手'), true);

  localStorage.removeItem(MIST_CHESS_SESSION_KEY);
  const visitor = mount(MistChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => visitor.unmount());
  await waitUntil(() => visitor.get('.mist-page').attributes('data-connection') === 'online', `visitor did not connect: ${visitor.text()}`);
  await waitUntil(() => visitor.get('.game-table-center').text().includes('暂不开放观战'), 'visitor did not see spectator closure');
  assert.equal((visitor.get('.game-table-center').element as HTMLButtonElement).disabled, true);
  assert.equal(visitor.findAll('.mist-piece').length, 0);

  type LeaveForNavigation = { leaveForNavigation: () => Promise<void> };
  await (black.vm as unknown as LeaveForNavigation).leaveForNavigation();
  await (red.vm as unknown as LeaveForNavigation).leaveForNavigation();
  assert.equal(localStorage.getItem(MIST_CHESS_SESSION_KEY), null);
});
