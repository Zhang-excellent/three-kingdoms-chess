import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const origin = 'http://localhost:5173';
GlobalRegistrator.register({ url: origin });
const { mount } = await import('@vue/test-utils');
const compiled = './.compiled-app.mts';
const { default: App } = await import(compiled);
after(() => GlobalRegistrator.unregister());

const fixture = readFileSync(resolve('tests/fixtures/三国象棋棋谱-20261029-234542.md'), 'utf8');
const waitUntil = async (condition: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (condition()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
};
function markdownFile(name: string, content: string): File {
  const file = new File([content], name, { type: 'text/markdown' });
  if (typeof file.text !== 'function')
    Object.defineProperty(file, 'text', { configurable: true, value: async () => content });
  return file;
}
async function importFile(wrapper: ReturnType<typeof mount>, file: File) {
  const input = wrapper.get('input.replay-file-input');
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
  await input.trigger('change');
}

test('local replay imports the legacy 60-step record, jumps through snapshots, and leaves live play untouched', async t => {
  localStorage.clear();
  history.replaceState(null, '', `${origin}/?mode=local`);
  const wrapper = mount(App, { attachTo: document.body });
  t.after(() => wrapper.unmount());

  await wrapper.get('g.piece[aria-label="魏方兵，第1路第7线"]').trigger('click');
  await wrapper.get('g.legal-point[aria-label="走到第1路第6线"]').trigger('click');
  assert.equal(wrapper.get('.player-card.active h2').text(), '刘备');
  const liveSave = localStorage.getItem('three-kingdoms-chess:win-loss-v1');
  assert.ok(liveSave);

  await wrapper.findAll('.local-view-tabs button').find(button => button.text() === '棋谱复盘')!.trigger('click');
  assert.ok(wrapper.find('.replay-empty').exists());
  await importFile(wrapper, markdownFile('三国象棋棋谱-20261029-234542.md', fixture));
  await waitUntil(() => wrapper.find('.replay-console').exists(), 'Replay console did not open');
  assert.match(wrapper.get('.replay-console-head').text(), /第 0 步 \/ 共 60 步/);
  assert.match(wrapper.get('.replay-declared-result').text(), /曹操胜利；刘备失败；孙权失败/);
  assert.match(wrapper.get('.replay-warning').text(), /缺少认输或出局事件/);
  assert.equal(wrapper.findAll('.replay-move-list li').length, 60);
  assert.equal(wrapper.findAll('g.piece').length, 29);
  assert.equal(localStorage.getItem('three-kingdoms-chess:win-loss-v1'), liveSave);

  await wrapper.findAll('.replay-move-list li')[12].trigger('click');
  assert.match(wrapper.get('.replay-console-head').text(), /第 13 步 \/ 共 60 步/);
  assert.match(wrapper.get('.last-move-card').text(), /曹操 · 兵.*\(7, 7\).*\(7, 6\).*吃掉吴方卒/);
  assert.equal(wrapper.findAll('.player-card .player-status').map(item => item.text()).filter(text => text === '本步').length, 1);
  assert.doesNotMatch(wrapper.get('.player-cards').text(), /行棋中/);
  assert.equal(wrapper.find('g.piece[aria-label="吴方卒，第7路第6线"]').exists(), false);
  assert.ok(wrapper.find('.last-trail').exists());

  await wrapper.findAll('.replay-controls button').find(button => button.text() === '上一步')!.trigger('click');
  assert.match(wrapper.get('.replay-console-head').text(), /第 12 步 \/ 共 60 步/);
  assert.ok(wrapper.find('g.piece[aria-label="吴方卒，第7路第6线"]').exists());
  const boardOrientation = wrapper.get('.board-svg').attributes('aria-label');
  await wrapper.findAll('button').find(button => button.text() === '翻转棋盘')!.trigger('click');
  assert.notEqual(wrapper.get('.board-svg').attributes('aria-label'), boardOrientation);
  await wrapper.get('g.piece[aria-label="魏方兵，第1路第7线"]').trigger('click');
  assert.equal(wrapper.findAll('g.legal-point').length, 0);
  assert.match(wrapper.get('.replay-console-head').text(), /第 12 步 \/ 共 60 步/);

  await wrapper.findAll('.replay-controls button').find(button => button.text() === '最后一步')!.trigger('click');
  const cardCounts = wrapper.findAll('.player-card-bottom>span').map(item => item.text());
  assert.deepEqual(cardCounts, ['14 枚子力', '4 枚子力', '4 枚子力']);

  await wrapper.findAll('.replay-controls button').find(button => button.text() === '初始局面')!.trigger('click');
  await wrapper.findAll('.replay-speed button').find(button => button.text() === '快')!.trigger('click');
  await wrapper.findAll('.replay-controls button').find(button => button.text() === '自动播放')!.trigger('click');
  await waitUntil(() => !wrapper.get('.replay-console-head').text().includes('第 0 步'), 'Replay autoplay did not advance');
  await wrapper.findAll('.replay-controls button').find(button => button.text() === '暂停')!.trigger('click');
  let pausedStep = wrapper.get('.replay-console-head').text();
  await new Promise(resolveWait => setTimeout(resolveWait, 450));
  assert.equal(wrapper.get('.replay-console-head').text(), pausedStep);

  await wrapper.findAll('.replay-controls button').find(button => button.text() === '自动播放')!.trigger('click');
  await waitUntil(() => wrapper.get('.replay-console-head').text() !== pausedStep, 'Replay did not resume before module switch');
  await wrapper.findAll('.local-view-tabs button').find(button => button.text() === '自由试玩 / 录谱')!.trigger('click');
  await new Promise(resolveWait => setTimeout(resolveWait, 450));
  await wrapper.findAll('.local-view-tabs button').find(button => button.text() === '棋谱复盘')!.trigger('click');
  const afterSwitch = wrapper.get('.replay-console-head').text();
  await new Promise(resolveWait => setTimeout(resolveWait, 450));
  assert.equal(wrapper.get('.replay-console-head').text(), afterSwitch);
  pausedStep = afterSwitch;

  const broken = fixture.replace('1. 曹操 · 炮 (2, 8) → (2, 6)', '1. 曹操 · 炮 (10, 8) → (2, 6)');
  await importFile(wrapper, markdownFile('损坏棋谱.md', broken));
  await waitUntil(() => wrapper.find('.replay-import-error').exists(), 'Broken replay error did not render');
  assert.match(wrapper.get('.replay-import-error').text(), /第 1 步坐标超出棋盘范围/);
  assert.equal(wrapper.findAll('.replay-move-list li').length, 60);
  assert.equal(wrapper.get('.replay-console-head').text(), pausedStep);
  assert.equal(localStorage.getItem('three-kingdoms-chess:win-loss-v1'), liveSave);

  await wrapper.findAll('.local-view-tabs button').find(button => button.text() === '自由试玩 / 录谱')!.trigger('click');
  assert.equal(wrapper.find('.replay-console').exists(), false);
  assert.equal(wrapper.get('.player-card.active h2').text(), '刘备');
  assert.equal(wrapper.findAll('.move-list li').length, 1);
  assert.equal(localStorage.getItem('three-kingdoms-chess:win-loss-v1'), liveSave);
});
