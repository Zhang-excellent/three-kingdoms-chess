import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createOnlineServer } from '../server/create-server.ts';
import { HORSE_CHESS_SESSION_KEY } from '../src/horse-chess.ts';

const server = createOnlineServer({ authDbPath: ':memory:' });
await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
GlobalRegistrator.register({ url: origin });
const { mount } = await import('@vue/test-utils');
const componentPath = './.compiled-HorseChessPage.mts';
const { default: HorseChessPage } = await import(componentPath);

after(async () => {
  GlobalRegistrator.unregister();
  server.horse.dispose();
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
  seatSelector: '.self-seat' | '.opponent-seat',
  nickname: string,
) {
  await waitUntil(
    () => !(wrapper.get(seatSelector).element as HTMLButtonElement).disabled,
    `${seatSelector} did not become available`,
  );
  await wrapper.get(seatSelector).trigger('click');
  assert.equal((wrapper.get('.horse-seat-dialog').element as HTMLDialogElement).open, true);
  await wrapper.get('.horse-seat-dialog input').setValue(nickname);
  await wrapper.get('.horse-seat-dialog form').trigger('submit');
  await waitUntil(() => wrapper.text().includes(nickname), `${nickname} did not take a seat`);
}

test('Horse Chess opens as one table, seats by avatar, starts after both ready, and stays read-only for visitors', async t => {
  localStorage.removeItem(HORSE_CHESS_SESSION_KEY);
  const red = mount(HorseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => red.unmount());
  assert.equal(red.findAll('.horse-piece').length, 18);
  assert.equal(red.findAll('.horse-table-seat').length, 2);
  assert.match(red.get('.self-seat').text(), /红方席位/);

  await waitUntil(() => red.get('.horse-page').attributes('data-connection') === 'online', 'red did not connect');
  await waitUntil(() => red.get('.horse-board-heading').text().includes('点击空席位入座'), 'empty-table guidance did not render');
  await enterGuestSeat(red, '.self-seat', '马棋红游客');
  assert.ok(red.get('.self-seat').classes().includes('red'));

  const redReady = red.findAll('button').find(button => button.text() === '准备');
  assert.ok(redReady);
  await redReady.trigger('click');
  await waitUntil(() => red.get('.self-seat').classes().includes('ready'), 'red ready state did not render');
  assert.equal(red.findAll('.horse-piece').length, 18);
  assert.match(red.get('.horse-board-heading').text(), /点击空席位入座/);

  localStorage.removeItem(HORSE_CHESS_SESSION_KEY);
  const black = mount(HorseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => black.unmount());
  assert.equal(black.findAll('.horse-piece').length, 18);
  await waitUntil(() => black.get('.horse-page').attributes('data-connection') === 'online', 'black did not connect');
  await waitUntil(() => black.get('.self-seat').text().includes('马棋红游客'), 'black did not receive red seat');
  await enterGuestSeat(black, '.opponent-seat', '马棋黑游客');
  assert.ok(black.get('.self-seat').classes().includes('black'));
  assert.equal((black.get('.opponent-seat').element as HTMLButtonElement).disabled, true);
  assert.match(red.get('.opponent-seat').text(), /马棋黑游客/);
  assert.match(red.get('.horse-board-heading').text(), /等待双方准备/);
  assert.equal(red.findAll('.horse-target').length, 0);

  const blackReady = black.findAll('button').find(button => button.text() === '准备');
  assert.ok(blackReady);
  await blackReady.trigger('click');
  await waitUntil(() => red.get('.horse-board-heading').text().includes('轮到 马棋红游客 行棋'), 'game did not start for red');
  await waitUntil(() => black.get('.horse-board-heading').text().includes('轮到 马棋红游客 行棋'), 'game did not start for black');
  assert.equal(red.findAll('.horse-piece').length, 18);
  assert.equal(black.findAll('.horse-piece').length, 18);

  await red.get('.horse-piece[aria-label="红方马，2 路第 10 线"]').trigger('click');
  await red.get('.horse-target[aria-label="走到第3路第8线"]').trigger('click');
  await waitUntil(() => black.get('.horse-history').text().includes('(3, 8)'), 'horse move did not synchronize');
  assert.match(black.get('.horse-board-heading').text(), /轮到 马棋黑游客 行棋/);

  localStorage.removeItem(HORSE_CHESS_SESSION_KEY);
  const visitor = mount(HorseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => visitor.unmount());
  await waitUntil(() => visitor.get('.horse-page').attributes('data-connection') === 'online', 'visitor did not connect');
  await waitUntil(() => visitor.get('.horse-history').text().includes('(3, 8)'), 'visitor did not receive active game');
  assert.equal(visitor.findAll('.horse-piece').length, 18);
  assert.match(visitor.get('.horse-board-heading').text(), /轮到 马棋黑游客 行棋/);
  assert.equal(visitor.findAll('button').some(button => ['准备', '认输', '再来一局', '退出房间'].includes(button.text())), false);
  await visitor.get('.horse-piece.red').trigger('click');
  assert.equal(visitor.findAll('.horse-target').length, 0);

  type LeaveForNavigation = { leaveForNavigation: () => Promise<void> };
  await (visitor.vm as unknown as LeaveForNavigation).leaveForNavigation();
  await (black.vm as unknown as LeaveForNavigation).leaveForNavigation();
  await (red.vm as unknown as LeaveForNavigation).leaveForNavigation();
  assert.equal(localStorage.getItem(HORSE_CHESS_SESSION_KEY), null);
});
