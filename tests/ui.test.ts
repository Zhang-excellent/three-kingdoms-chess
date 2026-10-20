import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost:5173' });
const { mount } = await import('@vue/test-utils');
const compiled = './.compiled-app.mts';
const { default: App } = await import(compiled);
after(() => GlobalRegistrator.unregister());
function setup(t: TestContext) {
  localStorage.clear(); const wrapper = mount(App, { attachTo: document.body });
  t.after(() => wrapper.unmount()); return wrapper;
}
const piece = (faction: string, name: string, x: number, y: number) => `g.piece[aria-label="${faction}方${name}，第${x}路第${y}线"]`;
const target = (x: number, y: number) => `g.legal-point[aria-label="走到第${x}路第${y}线"]`;

test('screen starts with 29 pieces, Cao Cao highlighted and undo disabled', t => {
  const wrapper = setup(t);
  assert.equal(wrapper.findAll('g.piece').length,29);
  assert.equal(wrapper.get('.player-card.active h2').text(),'曹操');
  assert.ok(wrapper.findAll('button').find(b=>b.text().includes('悔棋'))?.attributes('disabled') !== undefined);
});
test('clicking a piece reveals legal positions; moving lights Liu Bei and records the last path', async t => {
  const wrapper = setup(t);
  await wrapper.get(piece('魏','兵',1,7)).trigger('click');
  assert.equal(wrapper.findAll('g.legal-point').length,1);
  await wrapper.get(target(1,6)).trigger('click');
  assert.equal(wrapper.get('.player-card.active h2').text(),'刘备');
  assert.ok(wrapper.find(piece('魏','兵',1,6)).exists());
  assert.ok(wrapper.find('.last-trail').exists()); assert.equal(wrapper.findAll('.move-list li').length,1);
  assert.match(wrapper.get('.last-move-card').text(),/曹操/);
  assert.match(wrapper.get('.last-move-card').text(),/\(1, 7\).*\(1, 6\)/);
});
test('three consecutive UI moves rotate Cao Cao, Liu Bei, Sun Quan, Cao Cao', async t => {
  const wrapper = setup(t);
  for (const move of [{f:'魏',n:'兵',x:1,y:7,to:6,next:'刘备'},{f:'蜀',n:'卒',x:3,y:4,to:5,next:'孙权'},{f:'吴',n:'卒',x:7,y:4,to:5,next:'曹操'}]) {
    await wrapper.get(piece(move.f,move.n,move.x,move.y)).trigger('click');
    await wrapper.get(target(move.x,move.to)).trigger('click');
    assert.equal(wrapper.get('.player-card.active h2').text(),move.next);
  }
  assert.equal(wrapper.findAll('.move-list li').length,3);
});
test('wrong-turn and illegal clicks show feedback without advancing the turn', async t => {
  const wrapper = setup(t);
  await wrapper.get(piece('吴','卒',7,4)).trigger('click');
  assert.equal(wrapper.findAll('g.legal-point').length,0); assert.match(wrapper.get('.feedback').text(),/曹操/);
  await wrapper.get(piece('魏','兵',1,7)).trigger('click');
  await wrapper.get(piece('蜀','刘备',3,1)).trigger('click');
  assert.ok(wrapper.find('.feedback.error').exists()); assert.equal(wrapper.get('.player-card.active h2').text(),'曹操');
  assert.equal(wrapper.findAll('.move-list li').length,0);
});
test('undo restores piece position, previous avatar and last-move state', async t => {
  const wrapper = setup(t);
  await wrapper.get(piece('魏','兵',1,7)).trigger('click'); await wrapper.get(target(1,6)).trigger('click');
  const undo = wrapper.findAll('button').find(b=>b.text().includes('悔棋'))!;
  await undo.trigger('click');
  assert.equal(wrapper.get('.player-card.active h2').text(),'曹操'); assert.ok(wrapper.find(piece('魏','兵',1,7)).exists());
  assert.equal(wrapper.find('.last-trail').exists(),false); assert.equal(wrapper.findAll('.move-list li').length,0);
});
test('piece and destination are playable with the Enter key', async t => {
  const wrapper = setup(t);
  await wrapper.get(piece('魏','兵',5,7)).trigger('keydown',{key:'Enter'});
  await wrapper.get(target(5,6)).trigger('keydown',{key:'Enter'});
  assert.equal(wrapper.get('.player-card.active h2').text(),'刘备');
});
