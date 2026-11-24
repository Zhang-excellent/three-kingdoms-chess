import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createOnlineServer } from '../server/create-server.ts';
import { FIVE_SOLDIERS_SESSION_KEY } from '../src/five-soldiers.ts';

const server = createOnlineServer({ authDbPath: ':memory:' });
await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
GlobalRegistrator.register({ url: origin });
const { mount } = await import('@vue/test-utils');
const otherGamesComponent = './.compiled-OtherGamesPage.mts';
const fiveSoldiersComponent = './.compiled-FiveSoldiersPage.mts';
const { default: OtherGamesPage } = await import(otherGamesComponent);
const { default: FiveSoldiersPage } = await import(fiveSoldiersComponent);

after(async () => {
  GlobalRegistrator.unregister();
  server.five.dispose();
  await new Promise<void>(resolve => server.io.close(() => resolve()));
  server.authService.close();
});

const waitUntil = async (condition: () => boolean, message: string, timeoutMs = 4500) => {
  const attempts = Math.ceil(timeoutMs / 50);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${message}\n${document.body.textContent ?? ''}`);
};

test('other games page contains four independent game selectors', async t => {
  const wrapper = mount(OtherGamesPage, { attachTo: document.body });
  t.after(() => wrapper.unmount());
  assert.equal(wrapper.findAll('button.variant-entry').length, 5);
  assert.deepEqual(wrapper.findAll('.variant-entry strong').map(item => item.text()), ['五兵联盟', '马棋', '中国象棋', '迷雾象棋', '斗兽棋']);
});

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
  const dialog = wrapper.get('.five-seat-dialog').element as HTMLDialogElement;
  await waitUntil(() => dialog.open, 'Five Soldiers seat dialog did not open');
  await wrapper.get('.five-seat-dialog input').setValue(nickname);
  await wrapper.get('.five-seat-dialog form').trigger('submit');
  await waitUntil(() => wrapper.findAll('.five-piece').length === 26
    && wrapper.text().includes(nickname), `${nickname} did not enter the board`);
}

test('Five Soldiers opens as one table, seats by avatar, starts after both ready, and stays read-only for visitors', async t => {
  localStorage.removeItem(FIVE_SOLDIERS_SESSION_KEY);
  const red = mount(FiveSoldiersPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => red.unmount());
  assert.equal(red.findAll('.game-table-seat').length, 2);
  assert.equal(red.findAll('.five-piece').length, 0);
  assert.match(red.get('.game-table-center').text(), /五兵联盟/);

  await waitUntil(() => red.get('.five-page').attributes('data-connection') === 'online', `red did not connect: ${red.text()}`);
  await waitUntil(() => !(red.get('.game-table-seat.red').element as HTMLButtonElement).disabled, 'red table seat did not become available');
  await enterGuestSeat(red, '.game-table-seat.red', '五兵红游客');
  assert.equal(red.findAll('.five-piece').length, 26);
  assert.ok(red.get('.self-seat').classes().includes('red'));

  const redReady = red.findAll('button').find(button => button.text() === '开始');
  assert.ok(redReady);
  await redReady.trigger('click');
  await waitUntil(() => red.get('.self-seat').classes().includes('ready'), 'red ready state did not render');
  assert.equal(red.findAll('.five-piece').length, 26);

  localStorage.removeItem(FIVE_SOLDIERS_SESSION_KEY);
  const black = mount(FiveSoldiersPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => black.unmount());
  assert.equal(black.findAll('.game-table-seat').length, 2);
  assert.equal(black.findAll('.five-piece').length, 0);
  await waitUntil(() => black.get('.five-page').attributes('data-connection') === 'online', `black did not connect: ${black.text()}`);
  await waitUntil(() => black.get('.game-table-seat.red').text().includes('五兵红游客'), 'black did not receive red seat');
  assert.ok(black.get('.game-table-seat.red').classes().includes('occupied'));
  assert.equal((black.get('.game-table-seat.red').element as HTMLButtonElement).disabled, true);
  await enterGuestSeat(black, '.game-table-seat.black', '五兵黑游客');
  assert.ok(black.get('.self-seat').classes().includes('black'));
  assert.match(red.get('.opponent-seat').text(), /五兵黑游客/);
  assert.equal(red.findAll('.five-target').length, 0);

  const blackReady = black.findAll('button').find(button => button.text() === '开始');
  assert.ok(blackReady);
  await blackReady.trigger('click');
  await waitUntil(() => red.get('.five-board-heading').text().includes('轮到 五兵红游客 行棋'), 'game did not start for red');
  await waitUntil(() => black.get('.five-board-heading').text().includes('轮到 五兵红游客 行棋'), 'game did not start for black');
  assert.equal(red.findAll('.five-piece').length, 26);
  assert.equal(black.findAll('.five-piece').length, 26);
  assert.match(red.get('.five-board-heading').text(), /还可走 2 步/);

  await red.get('.five-piece[aria-label="红方兵，1 路第 7 线"]').trigger('click');
  await red.get('.five-target[aria-label="走到第1路第6线"]').trigger('click');
  await waitUntil(() => red.get('.five-history').text().includes('(1, 6)'), 'red move did not render');
  await waitUntil(() => black.get('.five-history').text().includes('(1, 6)'), 'black did not receive the move');
  assert.match(red.get('.five-board-heading').text(), /还可走 1 步/);

  await red.get('.five-piece[aria-label="红方兵，3 路第 7 线"]').trigger('click');
  await red.get('.five-target[aria-label="走到第3路第6线"]').trigger('click');
  await waitUntil(() => black.get('.five-history').text().includes('(3, 6)'), 'second red move did not synchronize');
  assert.match(red.get('.five-board-heading').text(), /轮到 五兵黑游客 行棋/);

  localStorage.removeItem(FIVE_SOLDIERS_SESSION_KEY);
  const visitor = mount(FiveSoldiersPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => visitor.unmount());
  await waitUntil(() => visitor.get('.five-page').attributes('data-connection') === 'online', `visitor did not connect: ${visitor.text()}`);
  await waitUntil(() => visitor.get('.game-table-center').classes().includes('active'), 'visitor table did not show active game');
  assert.equal(visitor.findAll('.five-piece').length, 0);
  await visitor.get('.game-table-center').trigger('click');
  await waitUntil(() => visitor.get('.five-history').text().includes('(3, 6)'), 'visitor did not enter the spectator board');
  assert.equal(visitor.findAll('.five-piece').length, 26);
  assert.match(visitor.get('.five-board-heading').text(), /轮到 五兵黑游客 行棋/);
  assert.equal(visitor.findAll('button').some(button => ['准备', '认输', '再来一局', '退出房间'].includes(button.text())), false);
  await visitor.get('.five-piece[aria-label="红方兵，1 路第 6 线"]').trigger('click');
  assert.equal(visitor.findAll('.five-target').length, 0);

  type LeaveForNavigation = { leaveForNavigation: () => Promise<void> };
  await (visitor.vm as unknown as LeaveForNavigation).leaveForNavigation();
  await (black.vm as unknown as LeaveForNavigation).leaveForNavigation();
  await (red.vm as unknown as LeaveForNavigation).leaveForNavigation();
  assert.equal(localStorage.getItem(FIVE_SOLDIERS_SESSION_KEY), null);
});
