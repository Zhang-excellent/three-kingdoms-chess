import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { newGame, playMove, resignFaction, RULES_VERSION } from '../src/game.ts';

GlobalRegistrator.register({ url: 'http://localhost:5173' });
const { mount } = await import('@vue/test-utils');
const compiled = './.compiled-app.mts';
const { default: App } = await import(compiled);
after(() => GlobalRegistrator.unregister());
function setup(t: TestContext, clear = true) {
  if (clear) localStorage.clear(); const wrapper = mount(App, { attachTo: document.body });
  t.after(() => wrapper.unmount()); return wrapper;
}
function remount(t: TestContext, wrapper: ReturnType<typeof mount>) {
  wrapper.unmount(); const next = mount(App, { attachTo: document.body });
  t.after(() => next.unmount()); return next;
}
const piece = (faction: string, name: string, x: number, y: number) => `g.piece[aria-label="${faction}方${name}，第${x}路第${y}线"]`;
const target = (x: number, y: number) => `g.legal-point[aria-label="走到第${x}路第${y}线"]`;

test('screen starts with 29 pieces, Cao Cao highlighted and undo disabled', t => {
  const wrapper = setup(t);
  assert.equal(wrapper.findAll('g.piece').length,29);
  assert.equal(wrapper.get('.player-card.active h2').text(),'曹操');
  assert.equal(wrapper.get('.app-shell').attributes('data-turn-slot'),'0');
  assert.match(wrapper.get('.turn-order').text(),/曹操.*刘备.*孙权/);
  assert.match(wrapper.get('.alliance-note').text(),/三方独立竞争/);
  assert.ok(wrapper.findAll('button').find(b=>b.text().includes('悔棋'))?.attributes('disabled') !== undefined);
});

test('local flip moves pieces, legal targets and last trail without changing canonical history', async t => {
  const wrapper = setup(t);
  const soldier = piece('魏','兵',1,7);
  assert.match(wrapper.get(soldier).attributes('style')!, /translate\(50px, 380px\)/);
  await wrapper.findAll('button').find(button => button.text() === '翻转棋盘')!.trigger('click');
  assert.match(wrapper.get(soldier).attributes('style')!, /translate\(490px, 215px\)/);
  assert.equal(wrapper.get('.coordinates text').text(), '9');
  await wrapper.get(soldier).trigger('click');
  assert.equal(wrapper.get(target(1,6)).get('circle').attributes('cx'), '490');
  await wrapper.get(target(1,6)).trigger('click');
  assert.equal(wrapper.get('.last-trail line').attributes('x1'), '490');
  assert.equal(wrapper.get('.last-trail line').attributes('y2'), '270');
  assert.match(wrapper.get('.last-move-card').text(), /\(1, 7\).*\(1, 6\)/);
  await wrapper.findAll('button').find(button => button.text() === '翻转棋盘')!.trigger('click');
  assert.equal(wrapper.get('.last-trail line').attributes('x1'), '50');
});

test('flipped board accepts touch on a piece and a legal destination', async t => {
  const wrapper = setup(t);
  await wrapper.findAll('button').find(button => button.text() === '翻转棋盘')!.trigger('click');
  await wrapper.get(piece('魏','兵',1,7)).trigger('touchend', { changedTouches: [{ clientX: 490, clientY: 215 }] });
  assert.equal(wrapper.findAll('g.legal-point').length, 1);
  await wrapper.get(target(1,6)).trigger('touchend', { changedTouches: [{ clientX: 490, clientY: 270 }] });
  assert.equal(wrapper.get('.player-card.active h2').text(), '刘备');
  assert.match(wrapper.get('.last-move-card').text(), /\(1, 7\).*\(1, 6\)/);
});
test('clicking a piece reveals legal positions; moving lights Liu Bei and records the last path', async t => {
  const wrapper = setup(t);
  await wrapper.get(piece('魏','兵',1,7)).trigger('click');
  assert.equal(wrapper.findAll('g.legal-point').length,1);
  await wrapper.get(target(1,6)).trigger('click');
  assert.equal(wrapper.get('.player-card.active h2').text(),'刘备');
  assert.equal(wrapper.get('.app-shell').attributes('data-turn-slot'),'1');
  assert.ok(wrapper.find(piece('魏','兵',1,6)).exists());
  assert.ok(wrapper.find('.last-trail').exists()); assert.equal(wrapper.findAll('.move-list li').length,1);
  assert.match(wrapper.get('.last-move-card').text(),/曹操/);
  assert.match(wrapper.get('.last-move-card').text(),/\(1, 7\).*\(1, 6\)/);
});
test('six consecutive UI moves rotate Cao Cao, Liu Bei and Sun Quan twice', async t => {
  const wrapper = setup(t);
  for (const move of [{f:'魏',n:'兵',x:1,y:7,to:6,next:'刘备',slot:'1'},{f:'蜀',n:'卒',x:3,y:4,to:5,next:'孙权',slot:'2'},{f:'吴',n:'卒',x:7,y:4,to:5,next:'曹操',slot:'0'},{f:'魏',n:'兵',x:5,y:7,to:6,next:'刘备',slot:'1'},{f:'蜀',n:'卒',x:1,y:4,to:5,next:'孙权',slot:'2'},{f:'吴',n:'卒',x:9,y:4,to:5,next:'曹操',slot:'0'}]) {
    await wrapper.get(piece(move.f,move.n,move.x,move.y)).trigger('click');
    await wrapper.get(target(move.x,move.to)).trigger('click');
    assert.equal(wrapper.get('.player-card.active h2').text(),move.next);
    assert.equal(wrapper.get('.app-shell').attributes('data-turn-slot'),move.slot);
  }
  assert.equal(wrapper.findAll('.move-list li').length,6);
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
  assert.equal(wrapper.get('.app-shell').attributes('data-turn-slot'),'0');
  assert.equal(wrapper.find('.last-trail').exists(),false); assert.equal(wrapper.findAll('.move-list li').length,0);
});
test('undo restores the exact Shu or Wu turn and move history', async t => {
  const wrapper = setup(t);
  await wrapper.get(piece('魏','兵',1,7)).trigger('click'); await wrapper.get(target(1,6)).trigger('click');
  await wrapper.get(piece('蜀','卒',3,4)).trigger('click'); await wrapper.get(target(3,5)).trigger('click');
  assert.equal(wrapper.get('.app-shell').attributes('data-turn-slot'),'2');
  await wrapper.get(piece('吴','卒',7,4)).trigger('click'); await wrapper.get(target(7,5)).trigger('click');
  await wrapper.findAll('button').find(b=>b.text().includes('悔棋'))!.trigger('click');
  assert.equal(wrapper.get('.player-card.active h2').text(),'孙权');
  assert.equal(wrapper.get('.app-shell').attributes('data-turn-slot'),'2');
  assert.ok(wrapper.find(piece('吴','卒',7,4)).exists());
  assert.equal(wrapper.findAll('.move-list li').length,2);
});
test('refresh restores the three-slot position from versioned saves', async t => {
  let wrapper = setup(t);
  await wrapper.get(piece('魏','兵',1,7)).trigger('click'); await wrapper.get(target(1,6)).trigger('click');
  await wrapper.get(piece('蜀','卒',3,4)).trigger('click'); await wrapper.get(target(3,5)).trigger('click');
  wrapper = remount(t,wrapper);
  assert.equal(wrapper.get('.player-card.active h2').text(),'孙权');
  assert.equal(wrapper.get('.app-shell').attributes('data-turn-slot'),'2');
  await wrapper.get(piece('吴','卒',7,4)).trigger('click'); await wrapper.get(target(7,5)).trigger('click');
  wrapper = remount(t,wrapper);
  assert.equal(wrapper.get('.player-card.active h2').text(),'曹操');
  assert.equal(wrapper.get('.app-shell').attributes('data-turn-slot'),'0');
  const saved = JSON.parse(localStorage.getItem('three-kingdoms-chess:win-loss-v1')!);
  assert.equal(saved.rulesVersion,RULES_VERSION);
});
test('old alliance and four-slot saves remain untouched until starting a new independent game', async t => {
  localStorage.clear();
  const legacy = JSON.stringify({ rulesVersion: 'turn-cycle-wei-shu-wei-wu-v1', game: { schema: 2, turn: 'wei', turnSlot: 0 }, undo: [] });
  localStorage.setItem('three-kingdoms-chess:turn-cycle-v1',legacy);
  const wrapper = setup(t,false);
  assert.ok(wrapper.find('.legacy-save-banner').exists());
  assert.equal(localStorage.getItem('three-kingdoms-chess:turn-cycle-v1'),legacy);
  assert.equal(localStorage.getItem('three-kingdoms-chess:win-loss-v1'),null);
  await wrapper.get(piece('魏','兵',1,7)).trigger('click');
  assert.equal(wrapper.findAll('g.legal-point').length,0); assert.match(wrapper.get('.feedback.error').text(),/另开一局/);
  await wrapper.get('.legacy-save-banner .primary-button').trigger('click');
  assert.equal(wrapper.find('.legacy-save-banner').exists(),false);
  assert.equal(localStorage.getItem('three-kingdoms-chess:turn-cycle-v1'),legacy);
  const saved = JSON.parse(localStorage.getItem('three-kingdoms-chess:win-loss-v1')!);
  assert.equal(saved.rulesVersion,RULES_VERSION); assert.equal(saved.game.turnSlot,0);
});
test('malformed current save remains available and requires a new game', t => {
  localStorage.clear();
  const malformed = '{"rulesVersion":';
  localStorage.setItem('three-kingdoms-chess:win-loss-v1', malformed);
  const wrapper = setup(t, false);
  assert.ok(wrapper.find('.legacy-save-banner').exists());
  assert.equal(localStorage.getItem('three-kingdoms-chess:win-loss-v1'), malformed);
  assert.match(wrapper.get('.feedback').text(), /另开一局/);
});
test('old ranking save remains untouched and cannot silently resume under win-loss rules', t => {
  localStorage.clear();
  const previous = JSON.stringify({ rulesVersion: 'independent-three-way-ranking-v1', game: { schema: 3, placements: { wei: 3 } }, undo: [] });
  localStorage.setItem('three-kingdoms-chess:independent-v1', previous);
  const wrapper = setup(t, false);
  assert.ok(wrapper.find('.legacy-save-banner').exists());
  assert.equal(localStorage.getItem('three-kingdoms-chess:independent-v1'), previous);
  assert.equal(localStorage.getItem('three-kingdoms-chess:win-loss-v1'), null);
});
test('settings keep music and effect switches and volumes independently on this browser', async t => {
  localStorage.clear();
  let wrapper = setup(t, false);
  await wrapper.findAll('button').find(b => b.text() === '设置')!.trigger('click');
  assert.equal(wrapper.get('#music-toggle').text(), '关闭');
  assert.equal(wrapper.get('#effects-toggle').text(), '关闭');
  assert.equal(wrapper.get('#music-preview').text(), '试听');
  assert.match(wrapper.get('#music-track').text(), /流觞曲水/);
  await wrapper.get('#music-playlist').setValue('guitar');
  assert.match(wrapper.get('#music-track').text(), /乐邦詹士（吉他）/);
  await wrapper.get('#effects-toggle').trigger('click');
  await wrapper.get('#effects-volume').setValue('0.42');
  await wrapper.get('#music-volume').setValue('0.18');
  let saved = JSON.parse(localStorage.getItem('three-kingdoms-chess:audio-v1')!);
  assert.equal(saved.effectsEnabled, true);
  assert.equal(saved.musicEnabled, false);
  assert.equal(saved.effectsVolume, 0.42);
  assert.equal(saved.musicVolume, 0.18);
  assert.equal(saved.musicPlaylistId, 'guitar');
  assert.equal(saved.musicTrackId, 'lebang-zhanshi-guitar');
  wrapper = remount(t, wrapper);
  assert.equal(wrapper.get('#effects-toggle').text(), '开启');
  assert.equal(wrapper.get('#music-toggle').text(), '关闭');
  assert.equal((wrapper.get('#effects-volume').element as HTMLInputElement).value, '0.42');
  assert.equal((wrapper.get('#music-track').element as HTMLSelectElement).value, 'lebang-zhanshi-guitar');
});
test('finished local game presents one winner and two losses without placement labels', t => {
  localStorage.clear();
  const first = resignFaction(newGame(), 'shu');
  assert.equal(first.ok, true); if (!first.ok) return;
  const last = resignFaction(first.game, 'wu');
  assert.equal(last.ok, true); if (!last.ok) return;
  localStorage.setItem('three-kingdoms-chess:win-loss-v1', JSON.stringify({ rulesVersion: RULES_VERSION, game: last.game, undo: [] }));
  const wrapper = setup(t, false);
  assert.match(wrapper.get('.result-banner').text(), /曹操获胜.*刘备、孙权失败/);
  assert.match(wrapper.get('.ranking-card').text(), /曹操.*胜利.*刘备.*失败.*孙权.*失败/);
  assert.doesNotMatch(wrapper.text(), /第[一二三123]名|亚军|季军|冠军/);
});
test('win-loss results survive refresh and undo restores the pre-elimination state', async t => {
  localStorage.clear();
  const before = newGame();
  before.pieces = before.pieces.filter(q=>q.kind==='king');
  before.pieces.push({id:'shu-attacker',faction:'shu',kind:'rook',x:4,y:7},{id:'wu-attacker',faction:'wu',kind:'rook',x:2,y:1});
  before.turn='shu'; before.turnSlot=1;
  const result=playMove(before,'shu-attacker',{x:4,y:9});
  assert.equal(result.ok,true); if (!result.ok) return;
  localStorage.setItem('three-kingdoms-chess:win-loss-v1',JSON.stringify({rulesVersion:RULES_VERSION,game:result.game,undo:[before]}));
  let wrapper=setup(t,false);
  assert.match(wrapper.get('.ranking-card').text(),/曹操.*失败/);
  assert.equal(wrapper.get('.player-card.active h2').text(),'孙权');
  wrapper=remount(t,wrapper);
  assert.match(wrapper.get('.ranking-card').text(),/曹操.*失败/);
  assert.equal(wrapper.get('.app-shell').attributes('data-turn-slot'),'2');
  await wrapper.findAll('button').find(b=>b.text().includes('悔棋'))!.trigger('click');
  assert.match(wrapper.get('.ranking-card').text(),/曹操.*对局中/);
  assert.ok(wrapper.find(piece('魏','曹操',5,10)).exists());
  assert.equal(wrapper.get('.player-card.active h2').text(),'刘备');
});
test('piece and destination are playable with the Enter key', async t => {
  const wrapper = setup(t);
  await wrapper.get(piece('魏','兵',5,7)).trigger('keydown',{key:'Enter'});
  await wrapper.get(target(5,6)).trigger('keydown',{key:'Enter'});
  assert.equal(wrapper.get('.player-card.active h2').text(),'刘备');
});
test('record export stays disabled until a move and creates a Markdown download', async t => {
  const wrapper = setup(t);
  const exportButton = () => wrapper.get('.record-export-button');
  assert.equal(exportButton().attributes('disabled'), '');
  await wrapper.get(piece('魏','兵',1,7)).trigger('click');
  await wrapper.get(target(1,6)).trigger('click');
  assert.equal(exportButton().attributes('disabled'), undefined);
  const blobs: Blob[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  let download = '';
  URL.createObjectURL = blob => {
    assert.ok(blob instanceof Blob);
    blobs.push(blob);
    return 'blob:game-record';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () { download = this.download; };
  try {
    await exportButton().trigger('click');
    assert.match(download, /^三国象棋棋谱-\d{8}-\d{6}\.md$/);
    assert.equal(blobs.length, 1);
    assert.match(await blobs[0].text(), /1\. 曹操 · 兵 \(1, 7\) → \(1, 6\)/);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLAnchorElement.prototype.click = originalClick;
  }
});
