import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createOnlineServer } from '../server/create-server.ts';
import { CHINESE_CHESS_SESSION_KEY } from '../src/chinese-chess.ts';

const server = createOnlineServer({ authDbPath: ':memory:' });
await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
GlobalRegistrator.register({ url: origin });
const { mount } = await import('@vue/test-utils');
const componentPath = './.compiled-ChineseChessPage.mts';
const { default: ChineseChessPage } = await import(componentPath);

after(async () => {
  localStorage.clear();
  GlobalRegistrator.unregister();
  server.chinese.dispose();
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
  const dialog = wrapper.get('.chinese-seat-dialog').element as HTMLDialogElement;
  await waitUntil(() => dialog.open, 'Chinese chess seat dialog did not open');
  await wrapper.get('.chinese-seat-dialog input').setValue(nickname);
  await wrapper.get('.chinese-seat-dialog form').trigger('submit');
  await waitUntil(() => wrapper.findAll('.chinese-piece').length === 32
    && wrapper.text().includes(nickname), `${nickname} did not enter the board`);
}

test('Chinese chess opens as one table, seats players by avatar, starts after both ready, and stays read-only for visitors', async t => {
  localStorage.removeItem(CHINESE_CHESS_SESSION_KEY);
  const red = mount(ChineseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => red.unmount());

  assert.equal(red.findAll('.game-table-seat').length, 2);
  assert.equal(red.findAll('.chinese-piece').length, 0);
  assert.match(red.get('.game-table-center').text(), /中国象棋/);

  await waitUntil(() => red.get('.chinese-page').attributes('data-connection') === 'online', `red did not connect: ${red.text()}`);
  await waitUntil(() => !(red.get('.game-table-seat.red').element as HTMLButtonElement).disabled, 'red table seat did not become available');
  await enterGuestSeat(red, '.game-table-seat.red', '中国象棋红游客');
  assert.equal(red.findAll('.chinese-piece').length, 32);
  assert.ok(red.get('.self-seat').classes().includes('red'));
  assert.match(red.get('.self-seat').text(), /中国象棋红游客/);

  const redReady = red.findAll('button').find(button => button.text() === '开始');
  assert.ok(redReady);
  await redReady.trigger('click');
  await waitUntil(() => red.get('.self-seat').classes().includes('ready'), 'red ready state did not render');
  assert.equal(red.findAll('.chinese-piece').length, 32);
  assert.equal(red.get('.chinese-history-heading').text().includes('0'), true);

  localStorage.removeItem(CHINESE_CHESS_SESSION_KEY);
  const black = mount(ChineseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => black.unmount());
  assert.equal(black.findAll('.game-table-seat').length, 2);
  assert.equal(black.findAll('.chinese-piece').length, 0);
  await waitUntil(() => black.get('.chinese-page').attributes('data-connection') === 'online', `black did not connect: ${black.text()}`);
  await waitUntil(() => black.get('.game-table-seat.red').text().includes('中国象棋红游客'), 'black did not receive occupied red seat');
  assert.ok(black.get('.game-table-seat.red').classes().includes('occupied'));
  assert.equal((black.get('.game-table-seat.red').element as HTMLButtonElement).disabled, true);
  await enterGuestSeat(black, '.game-table-seat.black', '中国象棋黑游客');
  assert.ok(black.get('.self-seat').classes().includes('black'));
  assert.match(black.get('.self-seat').text(), /中国象棋黑游客/);
  assert.match(red.get('.opponent-seat').text(), /中国象棋黑游客/);
  assert.equal(red.findAll('.chinese-target').length, 0);

  const blackReady = black.findAll('button').find(button => button.text() === '开始');
  assert.ok(blackReady);
  await blackReady.trigger('click');
  await waitUntil(() => red.get('.chinese-board-heading').text().includes('轮到 中国象棋红游客 行棋'), 'game did not start for red');
  await waitUntil(() => black.get('.chinese-board-heading').text().includes('轮到 中国象棋红游客 行棋'), 'game did not start for black');
  assert.equal(red.findAll('.chinese-piece').length, 32);
  assert.equal(black.findAll('.chinese-piece').length, 32);

  await red.get('.chinese-piece[aria-label="红方兵，1 路第 7 线"]').trigger('click');
  assert.equal(red.findAll('.chinese-target').length, 1);
  await red.get('.chinese-target[aria-label="走到第1路第6线"]').trigger('click');
  await waitUntil(() => red.get('.chinese-history').text().includes('(1, 6)'), 'red move did not render');
  await waitUntil(() => black.get('.chinese-history').text().includes('(1, 6)'), 'black did not receive the move');
  assert.match(black.get('.chinese-board-heading').text(), /轮到 中国象棋黑游客 行棋/);

  localStorage.removeItem(CHINESE_CHESS_SESSION_KEY);
  const visitor = mount(ChineseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => visitor.unmount());
  await waitUntil(() => visitor.get('.chinese-page').attributes('data-connection') === 'online', `visitor did not connect: ${visitor.text()}`);
  await waitUntil(() => visitor.get('.game-table-center').classes().includes('active'), 'visitor table did not show active game');
  assert.equal(visitor.findAll('.chinese-piece').length, 0);
  await visitor.get('.game-table-center').trigger('click');
  await waitUntil(() => visitor.get('.chinese-history').text().includes('(1, 6)'), 'visitor did not enter the spectator board');
  assert.equal(visitor.findAll('.chinese-piece').length, 32);
  assert.match(visitor.get('.chinese-board-heading').text(), /轮到 中国象棋黑游客 行棋/);
  assert.equal(visitor.findAll('button').some(button => ['准备', '认输', '再来一局', '退出房间'].includes(button.text())), false);
  await visitor.get('.chinese-piece[aria-label="红方车，1 路第 10 线"]').trigger('click');
  assert.equal(visitor.findAll('.chinese-target').length, 0);

  type LeaveForNavigation = { leaveForNavigation: () => Promise<void> };
  await (visitor.vm as unknown as LeaveForNavigation).leaveForNavigation();
  await (black.vm as unknown as LeaveForNavigation).leaveForNavigation();
  await (red.vm as unknown as LeaveForNavigation).leaveForNavigation();
  assert.equal(localStorage.getItem(CHINESE_CHESS_SESSION_KEY), null);
});
