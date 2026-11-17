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
  GlobalRegistrator.unregister();
  server.chinese.dispose();
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

test('two browser clients enter classic Chinese chess and complete one legal move', async t => {
  const red = mount(ChineseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => red.unmount());
  await waitUntil(() => red.get('.chinese-page').attributes('data-connection') === 'online', 'red did not connect');
  await waitUntil(() => !(red.get('.chinese-enter-button').element as HTMLButtonElement).disabled, 'red room did not load');
  await red.get('input[autocomplete="nickname"]').setValue('象棋红游客');
  await red.get('.chinese-enter-button').trigger('click');
  await waitUntil(() => red.find('.chinese-waiting').exists(), 'red did not enter');

  localStorage.removeItem(CHINESE_CHESS_SESSION_KEY);
  const black = mount(ChineseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => black.unmount());
  await waitUntil(() => black.get('.chinese-page').attributes('data-connection') === 'online', 'black did not connect');
  await waitUntil(() => !(black.get('.chinese-enter-button').element as HTMLButtonElement).disabled, 'black room did not load');
  await waitUntil(() => black.get('.chinese-seat-option.black').classes().includes('selected'), 'black side was not selected');
  await black.get('input[autocomplete="nickname"]').setValue('象棋黑游客');
  await black.get('.chinese-enter-button').trigger('click');
  await waitUntil(() => black.find('.chinese-waiting').exists(), 'black did not enter');

  await red.findAll('button').find(button => button.text() === '准备')!.trigger('click');
  await black.findAll('button').find(button => button.text() === '准备')!.trigger('click');
  await waitUntil(() => red.find('.chinese-board-svg').exists() && black.find('.chinese-board-svg').exists(), 'Chinese chess did not start');
  assert.equal(red.findAll('.chinese-piece').length, 32);
  assert.match(red.get('.chinese-board-heading').text(), /象棋红游客.*行棋/);
  await red.get('.chinese-piece[aria-label="红方兵，1 路第 7 线"]').trigger('click');
  await red.get('.chinese-target[aria-label="走到第1路第6线"]').trigger('click');
  await waitUntil(() => black.get('.chinese-history').text().includes('(1, 6)'), 'Chinese chess move did not synchronize');
  assert.match(black.get('.chinese-board-heading').text(), /轮到 象棋黑游客 行棋/);
});
