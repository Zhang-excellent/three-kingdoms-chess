import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactive, toRaw } from 'vue';
import { TURN_CYCLE, allied, at, legalMoves, moveError, newGame, playMove, validGame } from '../src/game.ts';
import type { Faction, Game, Kind, MoveResult, Piece, TurnSlot } from '../src/game.ts';

const p = (faction: Faction, kind: Kind, x: number, y: number, id = `${faction}-${kind}-${x}-${y}`): Piece => ({ faction, kind, x, y, id });
const fixture = (pieces: Piece[], turn: Faction = 'wei', eliminated: Faction[] = [], turnSlot?: TurnSlot): Game => ({
  ...newGame(), pieces, turn, eliminated,
  turnSlot: turnSlot ?? (turn === 'shu' ? 1 : turn === 'wu' ? 3 : eliminated.includes('wu') ? 2 : 0),
});
const kings = () => [p('wei','king',4,9),p('shu','king',2,0),p('wu','king',6,0)];
function success(result: MoveResult): Game { if (!result.ok) assert.fail(result.error); return result.game; }

test('initial board has 29 unique pieces and the central pawn belongs to Shu', () => {
  const g = newGame();
  assert.equal(g.pieces.length,29); assert.equal(new Set(g.pieces.map(q=>`${q.x},${q.y}`)).size,29);
  assert.deepEqual(['wei','shu','wu'].map(f=>g.pieces.filter(q=>q.faction===f).length),[16,7,6]);
  assert.equal(at(g.pieces,{x:4,y:3})?.faction,'shu'); assert.equal(g.turn,'wei'); assert.equal(g.turnSlot,0); assert.equal(validGame(g),true);
});
test('the first eight moves follow Wei, Shu, Wei, Wu twice and record every exact cycle slot', () => {
  let g = newGame();
  const moves = [
    ['wei-pawn-0-6',{x:0,y:5}], ['shu-pawn-2-3',{x:2,y:4}],
    ['wei-pawn-4-6',{x:4,y:5}], ['wu-pawn-6-3',{x:6,y:4}],
    ['wei-pawn-2-6',{x:2,y:5}], ['shu-pawn-0-3',{x:0,y:4}],
    ['wei-pawn-6-6',{x:6,y:5}], ['wu-pawn-8-3',{x:8,y:4}],
  ] as const;
  const expected = ['wei','shu','wei','wu','wei','shu','wei','wu'] as const;
  for (let index=0; index<moves.length; index++) {
    assert.equal(g.turn,expected[index]); assert.equal(g.turnSlot,index % 4);
    g = success(playMove(g,moves[index][0],moves[index][1]));
  }
  assert.deepEqual(g.history.map(record=>record.faction),expected);
  assert.deepEqual(g.history.map(record=>record.turnSlot),[0,1,2,3,0,1,2,3]);
  assert.equal(g.turn,'wei'); assert.equal(g.turnSlot,0);
  assert.equal(g.history.length,8); assert.deepEqual(g.lastMove?.from,{x:8,y:3}); assert.deepEqual(g.lastMove?.to,{x:8,y:4});
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
test('Shu and Wu may neither capture nor occupy each other; ally pieces also block rook paths', () => {
  const rook=p('shu','rook',0,0), ally=p('wu','pawn',0,2);
  assert.equal(allied('shu','wu'),true); assert.equal(allied('wei','shu'),false);
  assert.ok(moveError([rook,ally],rook,{x:0,y:2})); assert.ok(moveError([rook,ally],rook,{x:0,y:3}));
  assert.equal(moveError([rook,ally],rook,{x:0,y:1}),null);
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
test('cannon cannot jump without capturing or capture an ally', () => {
  const cannon=p('shu','cannon',1,2), screen=p('wu','pawn',1,4), ally=p('wu','rook',1,7);
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
  assert.ok(moveError([feng,p('wu','pawn',3,4)],feng,{x:3,y:4}));
});
test('capturing Liu Bei removes every Shu piece and passes the turn to Sun Quan', () => {
  const rook=p('wei','rook',2,1,'attacker'), g=fixture([...kings(),rook,p('shu','cannon',0,5),p('wu','pawn',8,3)]);
  const next=success(playMove(g,'attacker',{x:2,y:0}));
  assert.equal(next.turn,'wu'); assert.equal(next.turnSlot,3); assert.deepEqual(next.eliminated,['shu']); assert.equal(next.pieces.some(q=>q.faction==='shu'),false);
  assert.equal(next.pieces.some(q=>q.faction==='wu'),true); assert.deepEqual(next.lastMove?.eliminated,['shu']);
});
test('capturing Sun Quan passes the next move to Liu Bei', () => {
  const rook=p('wei','rook',6,1,'attacker'), g=fixture([...kings(),rook,p('shu','pawn',0,3),p('wu','cannon',8,5)],'wei',[],2);
  const next=success(playMove(g,'attacker',{x:6,y:0}));
  assert.equal(next.turn,'shu'); assert.equal(next.turnSlot,1); assert.deepEqual(next.eliminated,['wu']);
});
test('after a country is eliminated, the two surviving countries alternate', () => {
  let g=fixture([p('wei','king',4,9),p('wu','king',6,0),p('wu','pawn',8,3),p('wei','pawn',0,6)],'wei',['shu']);
  g=success(playMove(g,'wei-pawn-0-6',{x:0,y:5})); assert.equal(g.turn,'wu'); assert.equal(g.turnSlot,3);
  g=success(playMove(g,'wu-pawn-8-3',{x:8,y:4})); assert.equal(g.turn,'wei'); assert.equal(g.turnSlot,0);
});
test('capturing Cao Cao immediately wins for the alliance and freezes play', () => {
  const g=fixture([...kings(),p('shu','rook',4,7,'attacker')],'shu');
  const next=success(playMove(g,'attacker',{x:4,y:9}));
  assert.equal(next.winner,'alliance'); assert.equal(next.status,'finished'); assert.equal(next.turn,null); assert.equal(next.turnSlot,null);
  assert.equal(playMove(next,'wu-king-6-0',{x:7,y:0}).ok,false); assert.equal(validGame(next),true);
});
test('Wei wins when the last alliance king is captured', () => {
  const g=fixture([p('wei','king',4,9),p('wu','king',6,0),p('wei','rook',6,1,'attacker')],'wei',['shu']);
  const next=success(playMove(g,'attacker',{x:6,y:0})); assert.equal(next.winner,'wei'); assert.equal(next.turn,null);
});
test('a country with no legal move is eliminated on its turn, including ally blockage', () => {
  const g=fixture([p('wei','king',4,9),p('wei','pawn',0,6),p('shu','king',1,0),p('wu','king',7,0),p('wu','rook',2,0)]);
  const next=success(playMove(g,'wei-pawn-0-6',{x:0,y:5}));
  assert.equal(next.turn,'wu'); assert.equal(next.turnSlot,3); assert.deepEqual(next.eliminated,['shu']); assert.equal(next.pieces.some(q=>q.faction==='shu'),false);
});
test('stalemating Wu from the second Wei slot eliminates Wu and hands play to Shu', () => {
  const g=fixture([p('wei','king',4,9),p('wei','pawn',0,6),p('shu','king',1,0),p('shu','rook',6,0),p('shu','pawn',8,0),p('wu','king',7,0)],'wei',[],2);
  const next=success(playMove(g,'wei-pawn-0-6',{x:0,y:5}));
  assert.equal(next.turn,'shu'); assert.equal(next.turnSlot,1); assert.deepEqual(next.eliminated,['wu']); assert.equal(next.pieces.some(q=>q.faction==='wu'),false);
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
  assert.equal(validGame({...g,schema:1}),false); assert.equal(validGame({...g,turnSlot:1}),false); assert.equal(validGame({...g,turnSlot:2}),true);
  assert.deepEqual(TURN_CYCLE,['wei','shu','wei','wu']);
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
