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

const waitUntil = async (condition: () => boolean, message: string, timeoutMs = 3500) => {
  const attempts = Math.ceil(timeoutMs / 50);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

test('two browser clients enter horse chess, ready and complete a legal move', async t => {
  const red = mount(HorseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => red.unmount());
  await waitUntil(() => red.get('.horse-page').attributes('data-connection') === 'online', 'red did not connect');
  await waitUntil(() => !(red.get('.horse-enter-button').element as HTMLButtonElement).disabled, 'red room did not load');
  await red.get('input[autocomplete="nickname"]').setValue('马棋红游客');
  await red.get('.horse-enter-button').trigger('click');
  await waitUntil(() => red.find('.horse-waiting').exists(), 'red did not enter');

  localStorage.removeItem(HORSE_CHESS_SESSION_KEY);
  const black = mount(HorseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => black.unmount());
  await waitUntil(() => black.get('.horse-page').attributes('data-connection') === 'online', 'black did not connect');
  await waitUntil(() => !(black.get('.horse-enter-button').element as HTMLButtonElement).disabled, 'black room did not load');
  await waitUntil(() => black.get('.horse-seat-option.black').classes().includes('selected'), 'black side was not selected');
  await black.get('input[autocomplete="nickname"]').setValue('马棋黑游客');
  await black.get('.horse-enter-button').trigger('click');
  await waitUntil(() => black.find('.horse-waiting').exists(), 'black did not enter');

  await red.findAll('button').find(button => button.text() === '准备')!.trigger('click');
  await black.findAll('button').find(button => button.text() === '准备')!.trigger('click');
  await waitUntil(() => red.find('.horse-board-svg').exists() && black.find('.horse-board-svg').exists(), 'horse game did not start');
  assert.equal(red.findAll('.horse-piece').length, 18);
  assert.match(red.get('.horse-board-heading').text(), /马棋红游客.*行棋/);

  await red.get('.horse-piece[aria-label="红方马，2 路第 10 线"]').trigger('click');
  await red.get('.horse-target[aria-label="走到第3路第8线"]').trigger('click');
  await waitUntil(() => black.get('.horse-history').text().includes('(3, 8)'), 'horse move did not synchronize');
  assert.match(black.get('.horse-board-heading').text(), /轮到 马棋黑游客 行棋/);
});
