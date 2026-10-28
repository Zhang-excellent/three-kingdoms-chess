import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactive, toRaw } from 'vue';
import { TURN_CYCLE, at, legalMoves, moveError, newGame, playMove, resignFaction, validGame } from '../src/game.ts';
import type { Faction, Game, Kind, MoveResult, Piece, TurnSlot } from '../src/game.ts';

const p = (faction: Faction, kind: Kind, x: number, y: number, id = `${faction}-${kind}-${x}-${y}`): Piece => ({ faction, kind, x, y, id });
const fixture = (pieces: Piece[], turn: Faction = 'wei', eliminated: Faction[] = [], turnSlot?: TurnSlot): Game => ({
  ...newGame(), pieces, turn, eliminated, results: { wei: eliminated.includes('wei') ? 'lost' : 'playing', shu: eliminated.includes('shu') ? 'lost' : 'playing', wu: eliminated.includes('wu') ? 'lost' : 'playing' },
  turnSlot: turnSlot ?? (turn === 'shu' ? 1 : turn === 'wu' ? 2 : 0),
});
const kings = () => [p('wei','king',4,9),p('shu','king',2,0),p('wu','king',6,0)];
function success(result: MoveResult): Game { if (!result.ok) assert.fail(result.error); return result.game; }

test('resigning current or waiting faction keeps turn, history and results consistent', () => {
  const initial = newGame();
  const afterWu = success(resignFaction(initial, 'wu'));
  assert.equal(afterWu.turn, 'wei'); assert.equal(afterWu.turnSlot, 0);
  assert.equal(afterWu.results.wu, 'lost'); assert.equal(afterWu.results.wei, 'playing'); assert.equal(afterWu.history.length, 0);
  assert.equal(afterWu.pieces.some(piece => piece.faction === 'wu'), false);
  assert.equal(validGame(afterWu), true);
  const afterWei = success(resignFaction(afterWu, 'wei'));
  assert.equal(afterWei.status, 'finished'); assert.equal(afterWei.winner, 'shu');
  assert.deepEqual(afterWei.results, { wu: 'lost', wei: 'lost', shu: 'won' });
  assert.equal(validGame(afterWei), true);
  assert.equal(resignFaction(afterWei, 'shu').ok, false);
  const current = success(resignFaction(initial, 'wei'));
  assert.equal(current.turn, 'shu'); assert.equal(current.turnSlot, 1);
  assert.equal(validGame(current), true);
});
test('old ranking snapshots and inconsistent win-loss states are rejected', () => {
  const current = newGame();
  assert.equal(validGame({ ...current, rulesVersion: 'independent-three-way-ranking-v1', placements: {} }), false);
  assert.equal(validGame({ ...current, results: { ...current.results, shu: 'won' } }), false);
});

test('initial board has 29 unique pieces and the central pawn belongs to Shu', () => {
  const g = newGame();
  assert.equal(g.pieces.length,29); assert.equal(new Set(g.pieces.map(q=>`${q.x},${q.y}`)).size,29);
  assert.deepEqual(['wei','shu','wu'].map(f=>g.pieces.filter(q=>q.faction===f).length),[16,7,6]);
  assert.equal(at(g.pieces,{x:4,y:3})?.faction,'shu'); assert.equal(g.turn,'wei'); assert.equal(g.turnSlot,0); assert.equal(validGame(g),true);
});
test('the first nine moves follow Wei, Shu, Wu three times and record every cycle slot', () => {
  let g = newGame();
  const moves = [
    ['wei-pawn-0-6',{x:0,y:5}], ['shu-pawn-2-3',{x:2,y:4}], ['wu-pawn-6-3',{x:6,y:4}],
    ['wei-pawn-4-6',{x:4,y:5}], ['shu-pawn-0-3',{x:0,y:4}], ['wu-pawn-8-3',{x:8,y:4}],
    ['wei-pawn-2-6',{x:2,y:5}], ['shu-pawn-4-3',{x:4,y:4}], ['wu-feng-5-2',{x:5,y:3}],
  ] as const;
  const expected = ['wei','shu','wu','wei','shu','wu','wei','shu','wu'] as const;
  for (let index=0; index<moves.length; index++) {
    assert.equal(g.turn,expected[index]); assert.equal(g.turnSlot,index % 3);
    g = success(playMove(g,moves[index][0],moves[index][1]));
  }
  assert.deepEqual(g.history.map(record=>record.faction),expected);
  assert.deepEqual(g.history.map(record=>record.turnSlot),[0,1,2,0,1,2,0,1,2]);
  assert.equal(g.turn,'wei'); assert.equal(g.turnSlot,0);
  assert.equal(g.history.length,9); assert.deepEqual(g.lastMove?.from,{x:5,y:2}); assert.deepEqual(g.lastMove?.to,{x:5,y:3});
  assert.equal(validGame(g),true);
});
test('wrong player and illegal moves neither change turn nor add history', () => {
  const g = newGame(), before = JSON.stringify(g);
  assert.equal(playMove(g,'shu-rook-0-0',{x:0,y:1}).ok,false);
  assert.equal(playMove(g,'wei-pawn-0-6',{x:1,y:6}).ok,false);
  assert.equal(g.turnSlot,0);
  assert.equal(JSON.stringify(g),before);
});
test('move processing accepts raw Vue state and preserves an undo snapshot', () => {
  const state = reactive(newGame()), previous = structuredClone(toRaw(state));
  const next = success(playMove(toRaw(state),'wei-pawn-4-6',{x:4,y:5}));
  assert.equal(previous.turn,'wei'); assert.equal(previous.turnSlot,0); assert.equal(next.turn,'shu'); assert.equal(next.turnSlot,1); assert.equal(at(previous.pieces,{x:4,y:6})?.kind,'pawn');
});
test('rook paths are blocked by any faction and diagonals are forbidden', () => {
  const rook = p('wei','rook',4,5);
  assert.equal(moveError([rook],rook,{x:4,y:0}),null);
  assert.ok(moveError([rook,p('wu','pawn',4,3)],rook,{x:4,y:0}));
  assert.ok(moveError([rook],rook,{x:5,y:4}));
});
test('all different factions may capture each other, while all pieces still block paths', () => {
  for (const attacker of ['wei','shu','wu'] as Faction[]) for (const defender of ['wei','shu','wu'] as Faction[]) {
    const rook=p(attacker,'rook',0,0), target=p(defender,'pawn',0,2);
    assert.equal(moveError([rook,target],rook,target),attacker === defender ? '这里已有本方棋子。' : null);
    assert.ok(moveError([rook,target],rook,{x:0,y:3}));
  }
});
test('friendly targets cannot be occupied', () => {
  const rook=p('wei','rook',0,8), own=p('wei','pawn',0,6);
  assert.ok(moveError([rook,own],rook,{x:0,y:6}));
});
test('cannon captures with exactly one screen from any faction, including a king', () => {
  const cannon=p('shu','cannon',1,2), enemy=p('wei','rook',1,7);
  for (const screen of [p('wei','king',1,4),p('shu','pawn',1,4),p('wu','feng',1,4)])
    assert.equal(moveError([cannon,screen,enemy],cannon,enemy),null);
  assert.ok(moveError([cannon,enemy],cannon,enemy));
  assert.ok(moveError([cannon,p('wu','pawn',1,3),p('shu','pawn',1,5),enemy],cannon,enemy));
});
test('cannon cannot jump without capturing or capture its own side', () => {
  const cannon=p('shu','cannon',1,2), screen=p('wu','pawn',1,4), ally=p('shu','rook',1,7);
  assert.ok(moveError([cannon,screen],cannon,{x:1,y:7}));
  assert.ok(moveError([cannon,screen,ally],cannon,ally));
  assert.equal(moveError([cannon],cannon,{x:1,y:7}),null);
});
test('horse leg is determined by the first orthogonal step', () => {
  const horse=p('wei','horse',4,5);
  assert.equal(moveError([horse],horse,{x:6,y:4}),null);
  assert.ok(moveError([horse,p('wu','pawn',5,5)],horse,{x:6,y:4}));
  assert.equal(moveError([horse,p('wu','pawn',4,4)],horse,{x:6,y:4}),null);
  assert.ok(moveError([horse,p('wu','pawn',4,4)],horse,{x:5,y:3}));
});
test('elephant obeys eye blocking and cannot cross the river', () => {
  const elephant=p('wei','elephant',4,7);
  assert.equal(moveError([elephant],elephant,{x:2,y:5}),null);
  assert.ok(moveError([elephant,p('shu','pawn',3,6)],elephant,{x:2,y:5}));
  const river=p('wei','elephant',2,5); assert.ok(moveError([river],river,{x:4,y:3}));
});
test('advisor remains in its palace and moves one diagonal', () => {
  const advisor=p('wei','advisor',3,9);
  assert.equal(moveError([advisor],advisor,{x:4,y:8}),null);
  assert.ok(moveError([advisor],advisor,{x:2,y:8})); assert.ok(moveError([advisor],advisor,{x:3,y:8}));
});
test('Cao Cao is restricted to the lower palace', () => {
  const king=p('wei','king',3,8);
  assert.equal(moveError([king],king,{x:4,y:8}),null);
  assert.ok(moveError([king],king,{x:2,y:8})); assert.ok(moveError([king],king,{x:4,y:7}));
});
test('Liu Bei and Sun Quan use the shared back rank with inclusive file 2 and 8 boundaries', () => {
  for (const faction of ['shu','wu'] as Faction[]) {
    const left=p(faction,'king',2,0), right=p(faction,'king',6,0);
    assert.equal(moveError([left],left,{x:1,y:0}),null); assert.equal(moveError([right],right,{x:7,y:0}),null);
    assert.ok(moveError([p(faction,'king',1,0)],p(faction,'king',1,0),{x:0,y:0}));
    assert.ok(moveError([right],right,{x:6,y:1}));
  }
});
test('facing kings cause no prohibition, and no long-range flying king capture exists', () => {
  const cao=p('wei','king',4,8), liu=p('shu','king',4,0);
  assert.equal(moveError([cao,liu],cao,{x:4,y:7}),null); assert.ok(moveError([cao,liu],cao,liu));
});
test('pawns have faction-dependent direction and gain sideways movement only after crossing', () => {
  const red=p('wei','pawn',4,5), black=p('shu','pawn',4,4);
  assert.equal(moveError([red],red,{x:4,y:4}),null); assert.ok(moveError([red],red,{x:5,y:5}));
  const crossedRed=p('wei','pawn',4,4); assert.equal(moveError([crossedRed],crossedRed,{x:5,y:4}),null);
  assert.ok(moveError([crossedRed],crossedRed,{x:4,y:5}));
  assert.equal(moveError([black],black,{x:4,y:5}),null); assert.ok(moveError([black],black,{x:5,y:4}));
  const crossedBlack=p('shu','pawn',4,5); assert.equal(moveError([crossedBlack],crossedBlack,{x:5,y:5}),null);
});
test('Feng can move forward one or two, backward one, and sideways one', () => {
  const feng=p('wu','feng',4,3);
  for (const point of [{x:4,y:4},{x:4,y:5},{x:4,y:2},{x:3,y:3},{x:5,y:3}]) assert.equal(moveError([feng],feng,point),null);
  for (const point of [{x:4,y:1},{x:2,y:3},{x:5,y:4},{x:4,y:6}]) assert.ok(moveError([feng],feng,point));
});
test('Feng never jumps and captures at the same destinations as movement', () => {
  const feng=p('shu','feng',3,2), enemy=p('wei','rook',3,4);
  assert.equal(moveError([feng,enemy],feng,enemy),null);
  assert.ok(moveError([feng,p('wu','pawn',3,3),enemy],feng,enemy));
  assert.equal(moveError([feng,p('wu','pawn',3,4)],feng,{x:3,y:4}),null);
});
test('capturing Liu Bei removes every Shu piece and passes the turn to Sun Quan', () => {
  const rook=p('wei','rook',2,1,'attacker'), g=fixture([...kings(),rook,p('shu','cannon',0,5),p('wu','pawn',8,3)]);
  const next=success(playMove(g,'attacker',{x:2,y:0}));
  assert.equal(next.turn,'wu'); assert.equal(next.turnSlot,2); assert.deepEqual(next.eliminated,['shu']); assert.equal(next.pieces.some(q=>q.faction==='shu'),false);
  assert.deepEqual(next.results,{wei:'playing',shu:'lost',wu:'playing'}); assert.equal(next.status,'playing'); assert.equal(next.winner,null);
  assert.equal(next.pieces.some(q=>q.faction==='wu'),true); assert.deepEqual(next.lastMove?.eliminated,['shu']);
});
test('capturing Sun Quan marks Wu lost and passes the next move to Shu', () => {
  const rook=p('wei','rook',6,1,'attacker'), g=fixture([...kings(),rook,p('shu','pawn',0,3),p('wu','cannon',8,5)]);
  const next=success(playMove(g,'attacker',{x:6,y:0}));
  assert.equal(next.turn,'shu'); assert.equal(next.turnSlot,1); assert.deepEqual(next.eliminated,['wu']); assert.deepEqual(next.results,{wei:'playing',shu:'playing',wu:'lost'});
});
test('after Shu is eliminated, Wei and Wu alternate without an extra turn', () => {
  let g=fixture([p('wei','king',4,9),p('wu','king',6,0),p('wu','pawn',8,3),p('wei','pawn',0,6)],'wei',['shu']);
  g=success(playMove(g,'wei-pawn-0-6',{x:0,y:5})); assert.equal(g.turn,'wu'); assert.equal(g.turnSlot,2);
  g=success(playMove(g,'wu-pawn-8-3',{x:8,y:4})); assert.equal(g.turn,'wei'); assert.equal(g.turnSlot,0);
});
test('Cao Cao first eliminated leaves Shu and Wu competing, then Wu can win', () => {
  const g=fixture([...kings(),p('shu','rook',4,7,'shu-attacker'),p('wu','rook',2,1,'wu-attacker')],'shu');
  const afterCao=success(playMove(g,'shu-attacker',{x:4,y:9}));
  assert.equal(afterCao.status,'playing'); assert.equal(afterCao.turn,'wu'); assert.equal(afterCao.turnSlot,2);
  assert.deepEqual(afterCao.eliminated,['wei']); assert.deepEqual(afterCao.results,{wei:'lost',shu:'playing',wu:'playing'});
  assert.equal(afterCao.pieces.some(q=>q.faction==='wei'),false); assert.equal(validGame(afterCao),true);
  const afterWu=success(playMove(afterCao,'wu-attacker',{x:2,y:2}));
  assert.equal(afterWu.turn,'shu'); assert.equal(afterWu.turnSlot,1); assert.deepEqual(afterWu.results,{wei:'lost',shu:'playing',wu:'playing'});
  const afterShu=success(playMove(afterWu,'shu-attacker',{x:4,y:8}));
  assert.equal(afterShu.turn,'wu'); assert.equal(afterShu.turnSlot,2); assert.equal(validGame(afterShu),true);
  const final=success(playMove(afterCao,'wu-attacker',{x:2,y:0}));
  assert.equal(final.status,'finished'); assert.equal(final.winner,'wu'); assert.deepEqual(final.eliminated,['wei','shu']);
  assert.deepEqual(final.results,{wei:'lost',shu:'lost',wu:'won'}); assert.equal(final.turn,null); assert.equal(final.turnSlot,null);
  assert.deepEqual(final.lastMove?.eliminated,['shu']); assert.equal(playMove(final,'wu-king-6-0',{x:7,y:0}).ok,false);
  assert.equal(validGame(final),true);
});
test('every first and second elimination ordering marks two losses and one win', () => {
  for (const first of ['wei','shu','wu'] as Faction[]) for (const second of ['wei','shu','wu'] as Faction[]) {
    if (first === second) continue;
    const champion = (['wei','shu','wu'] as Faction[]).find(f => f !== first && f !== second)!;
    const targetKing = second === 'wei' ? p('wei','king',4,9) : second === 'shu' ? p('shu','king',2,0) : p('wu','king',6,0);
    const winnerKing = champion === 'wei' ? p('wei','king',4,9) : champion === 'shu' ? p('shu','king',2,0) : p('wu','king',6,0);
    const attacker = p(champion,'rook',targetKing.x,second === 'wei' ? 8 : 1,'finisher');
    const before=fixture([targetKing,winnerKing,attacker],champion,[first]);
    assert.equal(validGame(before),true);
    const after=success(playMove(before,'finisher',targetKing));
    assert.deepEqual(after.eliminated,[first,second]); assert.equal(after.winner,champion);
    assert.equal(after.results[first],'lost'); assert.equal(after.results[second],'lost'); assert.equal(after.results[champion],'won'); assert.equal(validGame(after),true);
  }
});
test('Wei wins only when the last other king is captured', () => {
  const g=fixture([p('wei','king',4,9),p('wu','king',6,0),p('wei','rook',6,1,'attacker')],'wei',['shu']);
  const next=success(playMove(g,'attacker',{x:6,y:0})); assert.equal(next.winner,'wei'); assert.equal(next.turn,null);
  assert.deepEqual(next.results,{shu:'lost',wu:'lost',wei:'won'});
});
test('a country with no legal move is eliminated on its turn', () => {
  const g=fixture([p('wei','king',4,9),p('wei','pawn',0,6),p('shu','king',1,0),p('shu','pawn',2,0),p('shu','elephant',2,1),p('wei','pawn',1,2),p('wei','pawn',3,2),p('wu','king',7,0)]);
  const next=success(playMove(g,'wei-pawn-0-6',{x:0,y:5}));
  assert.equal(next.turn,'wu'); assert.equal(next.turnSlot,2); assert.deepEqual(next.eliminated,['shu']); assert.equal(next.pieces.some(q=>q.faction==='shu'),false);
  assert.deepEqual(next.results,{wei:'playing',shu:'lost',wu:'playing'});
});
test('stalemating Wu on its turn eliminates Wu and leaves Wei and Shu competing', () => {
  const g=fixture([p('wei','king',4,9),p('wei','pawn',0,6),p('shu','king',1,0),p('wu','king',7,0),p('wu','pawn',6,0),p('wu','elephant',6,1),p('shu','pawn',5,2),p('shu','pawn',7,2)],'shu');
  const next=success(playMove(g,'shu-king-1-0',{x:2,y:0}));
  assert.equal(next.turn,'wei'); assert.equal(next.turnSlot,0); assert.deepEqual(next.eliminated,['wu']); assert.equal(next.pieces.some(q=>q.faction==='wu'),false);
  assert.deepEqual(next.results,{wei:'playing',shu:'playing',wu:'lost'});
});
test('removed armies cease to block paths or supply cannon screens', () => {
  const g=fixture([...kings(),p('wei','rook',2,1,'attacker'),p('shu','pawn',5,5),p('wu','cannon',5,2),p('wei','pawn',5,7)]);
  const next=success(playMove(g,'attacker',{x:2,y:0}));
  const cannon=next.pieces.find(q=>q.kind==='cannon')!;
  assert.equal(moveError(next.pieces,cannon,{x:5,y:5}),null); assert.ok(moveError(next.pieces,cannon,{x:5,y:7}));
});
test('trial mode permits moving into attack; it does not silently enforce standard check safety', () => {
  const g=fixture([...kings(),p('shu','rook',3,2)]);
  assert.equal(moveError(g.pieces,g.pieces[0],{x:3,y:9}),null);
});
test('malformed coordinates and overlapping snapshots are rejected', () => {
  const g=newGame(); assert.ok(moveError(g.pieces,g.pieces[0],{x:NaN,y:9}));
  assert.ok(moveError(g.pieces,g.pieces[0],{x:-1,y:9}));
  const duplicate=structuredClone(g); duplicate.pieces[1].x=duplicate.pieces[0].x; duplicate.pieces[1].y=duplicate.pieces[0].y;
  assert.equal(validGame(duplicate),false); assert.equal(validGame({...g,turn:'invalid'}),false);
  assert.equal(validGame({...g,schema:1}),false); assert.equal(validGame({...g,rulesVersion:'turn-cycle-wei-shu-wei-wu-v1'}),false);
  assert.equal(validGame({...g,turnSlot:1}),false); assert.equal(validGame({...g,turnSlot:2}),false);
  assert.deepEqual(TURN_CYCLE,['wei','shu','wu']);
});
test('deterministic multi-game runs preserve occupancy, turns, kings and snapshot validity', () => {
  let seed=2317;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for (let match=0;match<6;match++) {
    let g=newGame();
    for (let step=0;step<150 && g.status==='playing';step++) {
      const available=g.pieces.filter(q=>q.faction===g.turn).flatMap(q=>legalMoves(g.pieces,q).map(to=>({q,to})));
      assert.ok(available.length>0);
      const chosen=available[Math.floor(random()*available.length)];
      g=success(playMove(g,chosen.q.id,chosen.to)); assert.equal(validGame(g),true);
      assert.equal(new Set(g.pieces.map(q=>`${q.x},${q.y}`)).size,g.pieces.length);
    }
  }
});
