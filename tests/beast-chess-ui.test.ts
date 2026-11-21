import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://127.0.0.1/three-chess/?mode=beast-chess' });
const { mount } = await import('@vue/test-utils');
const componentPath = './.compiled-BeastChessPage.mts';
const { default: BeastChessPage } = await import(componentPath);

after(() => GlobalRegistrator.unregister());

test('Beast Chess opens directly, moves, rejects illegal input, undoes and restarts in place', async () => {
  const wrapper = mount(BeastChessPage, { attachTo: document.body });
  try {
    assert.equal(wrapper.findAll('.beast-cell').length, 63);
    assert.equal(wrapper.findAll('.beast-piece').length, 16);
    assert.match(wrapper.get('.beast-turn').text(), /轮到下方行棋/);
    assert.match(wrapper.get('.beast-side-panel').text(), /上方[\s\S]*8[\s\S]*下方[\s\S]*8/);
    assert.equal(wrapper.findAll('.beast-piece img').every(image => {
      const source = image.attributes('src') ?? '';
      return source.startsWith('images/beast-chess/pieces/');
    }), true);

    await wrapper.get('.beast-cell[data-coordinate="A1"]').trigger('click');
    assert.ok(wrapper.get('.beast-cell[data-coordinate="A1"]').classes().includes('selected'));
    assert.equal(wrapper.findAll('.beast-cell.target').length, 2);
    assert.equal(wrapper.find('.beast-cell[data-coordinate="B2"]').classes().includes('target'), false);

    await wrapper.get('.beast-cell[data-coordinate="C2"]').trigger('click');
    assert.match(wrapper.get('.beast-feedback').text(), /合法落点/);
    assert.match(wrapper.get('.beast-turn').text(), /轮到下方行棋/);

    await wrapper.get('.beast-cell[data-coordinate="B1"]').trigger('click');
    assert.match(wrapper.get('.beast-turn').text(), /轮到上方行棋/);
    assert.equal(wrapper.get('.beast-cell[data-coordinate="B1"]').find('.beast-piece').exists(), true);
    assert.equal(wrapper.get('.beast-cell[data-coordinate="A1"]').find('.beast-piece').exists(), false);
    assert.match(wrapper.get('.beast-last-move').text(), /A1 → B1/);

    const undo = wrapper.findAll('button').find(button => button.text() === '悔棋');
    assert.ok(undo);
    await undo.trigger('click');
    assert.match(wrapper.get('.beast-turn').text(), /轮到下方行棋/);
    assert.equal(wrapper.get('.beast-cell[data-coordinate="A1"]').find('.beast-piece').exists(), true);

    await wrapper.get('.beast-cell[data-coordinate="A1"]').trigger('click');
    await wrapper.get('.beast-cell[data-coordinate="A2"]').trigger('click');
    const restart = wrapper.findAll('button').find(button => button.text() === '重新开始');
    assert.ok(restart);
    await restart.trigger('click');
    assert.match(wrapper.get('.beast-turn').text(), /轮到下方行棋/);
    assert.match(wrapper.get('.beast-board-heading').text(), /第 0 手/);
    assert.equal(wrapper.get('.beast-cell[data-coordinate="A1"]').find('.beast-piece').exists(), true);

    const back = wrapper.findAll('button').find(button => button.text().includes('返回其他玩法'));
    assert.ok(back);
    await back.trigger('click');
    assert.equal(wrapper.emitted('other')?.length, 1);
  } finally {
    wrapper.unmount();
  }
});
