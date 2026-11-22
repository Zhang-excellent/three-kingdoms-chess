import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createOnlineServer } from '../server/create-server.ts';
import { BEAST_CHESS_SESSION_KEY } from '../src/beast-chess.ts';

const server = createOnlineServer({ authDbPath: ':memory:' });
await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
GlobalRegistrator.register({ url: origin });
const { mount } = await import('@vue/test-utils');
const componentPath = './.compiled-BeastChessPage.mts';
const { default: BeastChessPage } = await import(componentPath);

after(async () => {
  GlobalRegistrator.unregister();
  server.beast.dispose();
  await new Promise<void>(resolve => server.io.close(() => resolve()));
  server.authService.close();
});

const waitUntil = async (condition: () => boolean, message: string, timeoutMs = 5000) => {
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
  const dialog = wrapper.get('.beast-seat-dialog').element as HTMLDialogElement;
  await waitUntil(() => dialog.open, 'Beast Chess seat dialog did not open');
  await wrapper.get('.beast-seat-dialog input').setValue(nickname);
  await wrapper.get('.beast-seat-dialog form').trigger('submit');
  await waitUntil(() => wrapper.findAll('.beast-piece').length === 16
    && wrapper.text().includes(nickname), `${nickname} did not enter the board`);
}

test('Beast Chess joins one table by seat, starts after both ready, moves in sync and stays read-only for visitors', async t => {
  localStorage.removeItem(BEAST_CHESS_SESSION_KEY);
  const lower = mount(BeastChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => lower.unmount());
  assert.equal(lower.findAll('.game-table-seat').length, 2);
  assert.equal(lower.findAll('.beast-piece').length, 0);
  assert.match(lower.get('.game-table-center').text(), /斗兽棋/);

  await waitUntil(() => lower.get('.beast-page').attributes('data-connection') === 'online', 'lower did not connect');
  await enterGuestSeat(lower, '.game-table-seat.red', '斗兽下方');
  assert.equal(lower.findAll('.beast-piece').length, 16);
  assert.ok(lower.get('.self-seat').classes().includes('lower'));
  assert.equal(lower.get('.beast-table-seat.upper').text().includes('等待棋友'), true);

  const readyLower = lower.findAll('button').find(button => button.text() === '准备');
  assert.ok(readyLower);
  await readyLower.trigger('click');
  await waitUntil(() => lower.get('.self-seat').classes().includes('ready'), 'lower ready state did not render');

  localStorage.removeItem(BEAST_CHESS_SESSION_KEY);
  const upper = mount(BeastChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => upper.unmount());
  await waitUntil(() => upper.get('.beast-page').attributes('data-connection') === 'online', 'upper did not connect');
  await waitUntil(() => upper.get('.game-table-seat.red').text().includes('斗兽下方'), 'upper did not receive lower seat');
  assert.ok(upper.get('.game-table-seat.red').classes().includes('occupied'));
  await enterGuestSeat(upper, '.game-table-seat.black', '斗兽上方');
  assert.match(upper.get('.beast-side-chip').text(), /上方/);
  assert.match(lower.get('.beast-table-seat.upper').text(), /斗兽上方/);
  assert.match(upper.get('.beast-table-seat.upper').text(), /斗兽下方/);
  assert.match(upper.get('.beast-table-seat.lower').text(), /斗兽上方/);
  assert.equal(upper.findAll('.beast-cell')[0].attributes('data-coordinate'), 'G1');
  assert.equal(lower.findAll('.beast-cell')[0].attributes('data-coordinate'), 'A9');
  assert.match(upper.get('.beast-board-grid').attributes('aria-label') ?? '', /上方玩家视角/);
  assert.equal(upper.findAll('.beast-piece img').every(image =>
    (image.attributes('src') ?? '').includes('?v=animal-colors-v4')), true);

  const readyUpper = upper.findAll('button').find(button => button.text() === '准备');
  assert.ok(readyUpper);
  await readyUpper.trigger('click');
  await waitUntil(() => lower.get('.beast-turn-badge').text().includes('轮到 斗兽下方 行棋'), 'game did not start for lower');
  await waitUntil(() => upper.get('.beast-turn-badge').text().includes('轮到 斗兽下方 行棋'), 'game did not start for upper');
  assert.equal(lower.findAll('.beast-piece').length, 16);
  assert.equal(upper.findAll('.beast-piece').length, 16);
  assert.deepEqual(lower.findAll('.beast-action-row button').map(button => button.text()), ['提和', '认输', '退出']);

  await lower.get('.beast-cell[data-coordinate="A1"]').trigger('click');
  await lower.get('.beast-cell[data-coordinate="B1"]').trigger('click');
  await waitUntil(() => upper.get('.beast-history').text().includes('A1 → B1'), 'beast move did not synchronize');
  assert.match(upper.get('.beast-turn-badge').text(), /轮到 斗兽上方 行棋/);
  assert.equal(lower.get('.beast-cell[data-coordinate="B1"]').attributes('disabled'), undefined);
  assert.equal(lower.get('.beast-cell[data-coordinate="B1"]').attributes('aria-disabled'), 'true');

  localStorage.removeItem(BEAST_CHESS_SESSION_KEY);
  const visitor = mount(BeastChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => visitor.unmount());
  await waitUntil(() => visitor.get('.beast-page').attributes('data-connection') === 'online', 'visitor did not connect');
  await waitUntil(() => visitor.get('.game-table-center').classes().includes('active'), 'visitor table did not show active game');
  assert.equal(visitor.findAll('.beast-piece').length, 0);
  await visitor.get('.game-table-center').trigger('click');
  await waitUntil(() => visitor.get('.beast-history').text().includes('A1 → B1'), 'visitor did not enter spectator board');
  assert.equal(visitor.findAll('.beast-piece').length, 16);
  assert.equal(visitor.findAll('.beast-action-row').length, 0);
  await visitor.get('.beast-cell[data-coordinate="G9"]').trigger('click');
  assert.equal(visitor.findAll('.beast-cell.target').length, 0);

  type LeaveForNavigation = { leaveForNavigation: () => Promise<void> };
  await (visitor.vm as unknown as LeaveForNavigation).leaveForNavigation();
  await (upper.vm as unknown as LeaveForNavigation).leaveForNavigation();
  await (lower.vm as unknown as LeaveForNavigation).leaveForNavigation();
  assert.equal(localStorage.getItem(BEAST_CHESS_SESSION_KEY), null);
});
