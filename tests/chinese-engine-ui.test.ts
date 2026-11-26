import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createOnlineServer } from '../server/create-server.ts';
import { PikafishError } from '../server/pikafish-engine.ts';
import type { ChineseEngineClient, ChineseEngineRequest } from '../server/pikafish-engine.ts';
import { CHINESE_CHESS_SESSION_KEY } from '../src/chinese-chess.ts';

class PendingEngine implements ChineseEngineClient {
  readonly configured = true;
  private pending: Array<{
    resolve: (move: string | null) => void;
    reject: (error: Error) => void;
    request: ChineseEngineRequest;
  }> = [];
  bestMove(request: ChineseEngineRequest): Promise<string | null> {
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject, request }));
  }
  resolve(move: string | null): void { this.pending.shift()?.resolve(move); }
  reject(error: Error): void { this.pending.shift()?.reject(error); }
  dispose(): void {}
}

const engine = new PendingEngine();
const server = createOnlineServer({ authDbPath: ':memory:', chineseEngine: engine });
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

const waitUntil = async (condition: () => boolean, message: string, timeoutMs = 4_500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(message);
};

async function enterGuestSeat(
  wrapper: Awaited<ReturnType<typeof mount>>,
  seatSelector: '.game-table-seat.red' | '.game-table-seat.black',
  nickname: string,
) {
  await waitUntil(() => !(wrapper.get(seatSelector).element as HTMLButtonElement).disabled, 'seat did not become available');
  const side = seatSelector.endsWith('.red') ? 'red' : 'black';
  (wrapper.vm as unknown as { openSeat: (side: 'red' | 'black') => void }).openSeat(side);
  const dialog = wrapper.get('.chinese-seat-dialog').element as HTMLDialogElement;
  await waitUntil(() => dialog.open, 'seat dialog did not open');
  await wrapper.get('.chinese-seat-dialog input').setValue(nickname);
  await wrapper.get('.chinese-seat-dialog form').trigger('submit');
  await waitUntil(() => wrapper.findAll('.chinese-piece').length === 32 && wrapper.text().includes(nickname), 'seat join failed');
}

test('Pikafish engine seat can switch back, play black, report failure and retry', async t => {
  localStorage.removeItem(CHINESE_CHESS_SESSION_KEY);
  const wrapper = mount(ChineseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(async () => {
    await (wrapper.vm as unknown as { leaveForNavigation: () => Promise<void> }).leaveForNavigation();
    wrapper.unmount();
  });
  await waitUntil(() => wrapper.get('.chinese-page').attributes('data-connection') === 'online', 'page did not connect');
  await enterGuestSeat(wrapper, '.game-table-seat.black', '人机黑方');

  await wrapper.get('.opponent-seat').trigger('click');
  await waitUntil(() => (wrapper.get('.engine-seat-dialog').element as HTMLDialogElement).open, 'engine dialog did not open');
  await wrapper.get('.engine-choice').trigger('click');
  await waitUntil(() => wrapper.get('.opponent-seat').text().includes('皮卡鱼 · 软件对手'), 'engine seat did not render');
  await wrapper.get('.opponent-seat').trigger('click');
  await wrapper.findAll('.engine-seat-dialog button').find(button => button.text() === '切回等待棋友')!.trigger('click');
  await waitUntil(() => wrapper.get('.opponent-seat').text().includes('等待棋友'), 'engine did not switch back');
  assert.match(wrapper.get('.game-board-waiting-card').text(), /邀请好友/);

  await wrapper.get('.opponent-seat').trigger('click');
  await wrapper.get('.engine-choice').trigger('click');
  await waitUntil(() => wrapper.get('.opponent-seat').text().includes('皮卡鱼'), 'engine did not sit again');
  await wrapper.findAll('button').find(button => button.text() === '开始')!.trigger('click');
  await waitUntil(() => wrapper.get('.chinese-board-heading').text().includes('皮卡鱼思考中'), 'thinking state did not render');
  engine.resolve('h2e2');
  await waitUntil(() => wrapper.get('.chinese-board-heading').text().includes('轮到 人机黑方 行棋'), 'engine first move did not apply');
  assert.equal(wrapper.findAll('.move-list li').length, 1);

  await wrapper.get('.chinese-piece[aria-label="黑方炮，2 路第 3 线"]').trigger('click');
  await wrapper.get('.chinese-target[aria-label="走到第2路第2线"]').trigger('click');
  await waitUntil(() => wrapper.get('.chinese-board-heading').text().includes('皮卡鱼思考中'), 'second engine turn did not start');
  engine.reject(new PikafishError('TIMEOUT', 'test timeout'));
  await waitUntil(() => {
    const bar = wrapper.find('.engine-error-bar');
    return bar.exists() && bar.text().includes('皮卡鱼暂不可用');
  }, 'engine error did not render');
  assert.equal(wrapper.findAll('.move-list li').length, 2);
  await wrapper.get('.engine-error-bar button').trigger('click');
  await waitUntil(() => wrapper.find('.engine-error-bar').exists() === false
    && wrapper.get('.chinese-board-heading').text().includes('皮卡鱼思考中'), 'engine retry did not start');
  engine.resolve('b2b3');
  await waitUntil(() => wrapper.get('.chinese-board-heading').text().includes('轮到 人机黑方 行棋'), 'retry move did not apply');
  assert.equal(wrapper.findAll('.move-list li').length, 3);
});

test('Pikafish can take black while the human stays red and reply to a human move', async t => {
  localStorage.removeItem(CHINESE_CHESS_SESSION_KEY);
  const wrapper = mount(ChineseChessPage, { attachTo: document.body, props: { accountName: null } });
  t.after(async () => {
    await (wrapper.vm as unknown as { leaveForNavigation: () => Promise<void> }).leaveForNavigation();
    wrapper.unmount();
  });
  await waitUntil(() => wrapper.get('.chinese-page').attributes('data-connection') === 'online', 'red page did not connect');
  await enterGuestSeat(wrapper, '.game-table-seat.red', '人机红方');
  await wrapper.get('.opponent-seat').trigger('click');
  await wrapper.get('.engine-choice').trigger('click');
  await waitUntil(() => wrapper.get('.opponent-seat').text().includes('皮卡鱼'), 'black engine did not sit');
  await wrapper.findAll('button').find(button => button.text() === '开始')!.trigger('click');
  await waitUntil(() => wrapper.find('.game-board-waiting-card').exists() === false
    && wrapper.get('.chinese-board-heading').text().includes('轮到 人机红方 行棋'), 'game did not start');
  await wrapper.get('.chinese-piece[aria-label="红方兵，1 路第 7 线"]').trigger('click');
  await wrapper.get('.chinese-target[aria-label="走到第1路第6线"]').trigger('click');
  await waitUntil(() => wrapper.get('.chinese-board-heading').text().includes('皮卡鱼思考中'), 'black engine did not think');
  engine.resolve('b7b8');
  await waitUntil(() => wrapper.get('.chinese-board-heading').text().includes('轮到 人机红方 行棋'), 'black engine move did not apply');
  assert.equal(wrapper.findAll('.move-list li').length, 2);
});
