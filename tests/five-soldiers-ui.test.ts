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

const waitUntil = async (condition: () => boolean, message: string, timeoutMs = 3500) => {
  const attempts = Math.ceil(timeoutMs / 50);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${message}\n${document.body.textContent ?? ''}`);
};

test('other games page contains only one five-soldiers selector', async t => {
  const wrapper = mount(OtherGamesPage, { attachTo: document.body });
  t.after(() => wrapper.unmount());
  assert.equal(wrapper.findAll('button.variant-entry').length, 1);
  assert.equal(wrapper.get('.variant-entry').text(), '兵五兵联盟→');
});

test('two browser components join the same table, ready and complete a move', async t => {
  const red = mount(FiveSoldiersPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => red.unmount());
  await waitUntil(() => red.get('.five-page').attributes('data-connection') === 'online', `red did not connect: ${red.text()}`);
  await waitUntil(() => !(red.get('.five-enter-button').element as HTMLButtonElement).disabled, 'red room inspection did not finish');
  assert.ok(red.find('input[autocomplete="nickname"]').exists());
  await red.get('input[autocomplete="nickname"]').setValue('红方游客');
  await red.get('.five-enter-button').trigger('click');
  await waitUntil(() => red.find('.five-waiting').exists(), 'red did not enter');
  assert.match(red.get('.five-waiting').text(), /红方游客/);

  localStorage.removeItem(FIVE_SOLDIERS_SESSION_KEY);
  const black = mount(FiveSoldiersPage, { attachTo: document.body, props: { accountName: null } });
  t.after(() => black.unmount());
  await waitUntil(() => black.get('.five-page').attributes('data-connection') === 'online', `black did not connect: ${black.text()}`);
  await waitUntil(() => !(black.get('.five-enter-button').element as HTMLButtonElement).disabled, 'black room inspection did not finish');
  await waitUntil(() => black.get('.five-seat-option.black').classes().includes('selected'), 'black side was not auto-selected');
  await black.get('input[autocomplete="nickname"]').setValue('黑方游客');
  await black.get('.five-enter-button').trigger('click');
  await waitUntil(() => black.find('.five-waiting').exists(), 'black did not enter');

  await red.findAll('button').find(button => button.text() === '准备')!.trigger('click');
  await black.findAll('button').find(button => button.text() === '准备')!.trigger('click');
  await waitUntil(() => red.find('.five-board-svg').exists() && black.find('.five-board-svg').exists(), 'game did not start');
  assert.equal(red.findAll('.five-piece').length, 26);
  assert.equal(black.findAll('.five-piece').length, 26);
  assert.match(red.get('.five-board-heading').text(), /红方游客.*行棋/);

  await red.get('.five-piece[aria-label="红方兵，1 路第 7 线"]').trigger('click');
  await red.get('.five-target[aria-label="走到第1路第6线"]').trigger('click');
  await waitUntil(() => red.get('.five-history').text().includes('(1, 6)'), 'red move did not render');
  await waitUntil(() => black.get('.five-history').text().includes('(1, 6)'), 'black did not receive the move');

  localStorage.removeItem(FIVE_SOLDIERS_SESSION_KEY);
  const accountView = mount(FiveSoldiersPage, { attachTo: document.body, props: { accountName: '五兵账号' } });
  t.after(() => accountView.unmount());
  assert.equal(accountView.find('input[autocomplete="nickname"]').exists(), false);
  assert.match(accountView.get('.five-account-name').text(), /五兵账号/);
});
