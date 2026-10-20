export type Faction = 'wei' | 'shu' | 'wu';
export type Kind = 'king' | 'rook' | 'horse' | 'elephant' | 'advisor' | 'cannon' | 'pawn' | 'feng';
export type TurnSlot = 0 | 1 | 2 | 3;
export interface Point { x: number; y: number }
export interface Piece extends Point { id: string; faction: Faction; kind: Kind }
export interface MoveRecord {
  number: number; faction: Faction; turnSlot: TurnSlot; pieceId: string; kind: Kind;
  from: Point; to: Point; captured: Piece | null; eliminated: Faction[];
}
export interface Game {
  schema: 2; pieces: Piece[]; turn: Faction | null; turnSlot: TurnSlot | null; eliminated: Faction[];
  history: MoveRecord[]; lastMove: MoveRecord | null;
  winner: 'wei' | 'alliance' | null; status: 'playing' | 'finished';
}
export type MoveResult = { ok: true; game: Game; notices: string[] } | { ok: false; error: string };

export const ORDER: Faction[] = ['wei', 'shu', 'wu'];
export const TURN_CYCLE: readonly Faction[] = ['wei', 'shu', 'wei', 'wu'];
export const RULES_VERSION = 'turn-cycle-wei-shu-wei-wu-v1';
export const PLAYERS = {
  wei: { nation: '魏', name: '曹操', color: '#ac493b', initial: '曹', team: '独立阵营' },
  shu: { nation: '蜀', name: '刘备', color: '#303943', initial: '刘', team: '蜀吴联盟' },
  wu: { nation: '吴', name: '孙权', color: '#28704f', initial: '孙', team: '蜀吴联盟' },
};

export function pieceName(piece: Pick<Piece, 'kind' | 'faction'>): string {
  if (piece.kind === 'king') return PLAYERS[piece.faction].name;
  return ({ rook: '车', horse: '马', elephant: piece.faction === 'wei' ? '相' : '象',
    advisor: piece.faction === 'wei' ? '仕' : '士', cannon: '炮',
    pawn: piece.faction === 'wei' ? '兵' : '卒', feng: '锋' } as Record<string, string>)[piece.kind];
}

export function newGame(): Game {
  const pieces: Piece[] = [];
  const add = (faction: Faction, kind: Kind, x: number, y: number) =>
    pieces.push({ id: `${faction}-${kind}-${x}-${y}`, faction, kind, x, y });
  const back: Kind[] = ['rook', 'horse', 'elephant', 'advisor', 'king', 'advisor', 'elephant', 'horse', 'rook'];
  back.forEach((kind, x) => add('wei', kind, x, 9));
  [1, 7].forEach(x => add('wei', 'cannon', x, 7));
  [0, 2, 4, 6, 8].forEach(x => add('wei', 'pawn', x, 6));
  add('shu', 'rook', 0, 0); add('shu', 'king', 2, 0);
  add('shu', 'cannon', 1, 2); add('shu', 'feng', 3, 2);
  [0, 2, 4].forEach(x => add('shu', 'pawn', x, 3));
  add('wu', 'rook', 8, 0); add('wu', 'king', 6, 0);
  add('wu', 'cannon', 7, 2); add('wu', 'feng', 5, 2);
  [6, 8].forEach(x => add('wu', 'pawn', x, 3));
  return { schema: 2, pieces, turn: 'wei', turnSlot: 0, eliminated: [], history: [], lastMove: null, winner: null, status: 'playing' };
}

export const at = (pieces: Piece[], p: Point): Piece | undefined => pieces.find(q => q.x === p.x && q.y === p.y);
export const inside = (p: Point): boolean => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < 9 && p.y >= 0 && p.y < 10;
export const allied = (a: Faction, b: Faction): boolean => a === b || (a !== 'wei' && b !== 'wei');

function between(pieces: Piece[], from: Point, to: Point): number {
  const dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
  let x = from.x + dx, y = from.y + dy, count = 0;
  while (x !== to.x || y !== to.y) {
    if (at(pieces, { x, y })) count++;
    x += dx; y += dy;
  }
  return count;
}

/** Movement and occupancy only. V0.1 uses capture-the-king; check safety is intentionally unresolved. */
export function moveError(pieces: Piece[], piece: Piece, to: Point): string | null {
  if (!inside(to)) return '不能走出棋盘。';
  const dx = to.x - piece.x, dy = to.y - piece.y;
  if (!dx && !dy) return '请选择另一个交叉点。';
  const target = at(pieces, to);
  if (target && allied(piece.faction, target.faction)) return target.faction === piece.faction
    ? '这里已有本方棋子。' : '蜀吴互不吃子，也不能占据盟友的位置。';
  const ax = Math.abs(dx), ay = Math.abs(dy), forward = piece.faction === 'wei' ? -1 : 1;
  switch (piece.kind) {
    case 'rook':
      if (dx && dy) return '车只能沿横线或竖线行走。';
      return between(pieces, piece, to) ? '车的路径被棋子挡住了。' : null;
    case 'cannon':
      if (dx && dy) return '炮只能沿横线或竖线行走。';
      if (target) return between(pieces, piece, to) === 1 ? null : '炮吃子时必须恰好隔一枚炮架。';
      return between(pieces, piece, to) === 0 ? null : '炮不吃子时不能跳子。';
    case 'horse': {
      if (!((ax === 2 && ay === 1) || (ax === 1 && ay === 2))) return '马走日字。';
      const leg = { x: piece.x + (ax === 2 ? Math.sign(dx) : 0), y: piece.y + (ay === 2 ? Math.sign(dy) : 0) };
      return at(pieces, leg) ? '马腿被挡住了。' : null;
    }
    case 'elephant':
      if (ax !== 2 || ay !== 2) return '相、象斜走两格。';
      if ((piece.faction === 'wei' && to.y < 5) || (piece.faction !== 'wei' && to.y > 4)) return '相、象不能过河。';
      return at(pieces, { x: piece.x + dx / 2, y: piece.y + dy / 2 }) ? '象眼被挡住了。' : null;
    case 'advisor': {
      const palace = to.x >= 3 && to.x <= 5 && (piece.faction === 'wei' ? to.y >= 7 : to.y <= 2);
      return ax === 1 && ay === 1 && palace ? null : '仕、士只能在本方九宫内斜走一格。';
    }
    case 'king':
      if (ax + ay !== 1) return '主公每步只能走一格，没有对面笑杀法。';
      if (piece.faction === 'wei') return to.x >= 3 && to.x <= 5 && to.y >= 7 ? null : '曹操不能离开下方九宫。';
      return to.y === 0 && to.x >= 1 && to.x <= 7 ? null : '刘备、孙权只能在上方底线第 2 至第 8 路活动。';
    case 'pawn': {
      const crossed = piece.faction === 'wei' ? piece.y <= 4 : piece.y >= 5;
      return (dx === 0 && dy === forward) || (crossed && ax === 1 && dy === 0)
        ? null : '兵卒只能向前一格，过河后可横走一格，不能后退。';
    }
    case 'feng':
      if (dx === 0 && dy === forward * 2)
        return at(pieces, { x: piece.x, y: piece.y + forward }) ? '锋不能跳子，中间交叉点必须为空。' : null;
      return (dx === 0 && ay === 1) || (dy === 0 && ax === 1) ? null : '锋向前可走一或两格，向后、左右只能走一格。';
  }
}

export function legalMoves(pieces: Piece[], piece: Piece): Point[] {
  const moves: Point[] = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
    const p = { x, y };
    if (!moveError(pieces, piece, p)) moves.push(p);
  }
  return moves;
}

function victory(game: Game): boolean {
  if (game.eliminated.includes('wei')) {
    game.winner = 'alliance'; game.status = 'finished'; game.turn = null; game.turnSlot = null; return true;
  }
  if (game.eliminated.includes('shu') && game.eliminated.includes('wu')) {
    game.winner = 'wei'; game.status = 'finished'; game.turn = null; game.turnSlot = null; return true;
  }
  return false;
}

function eliminate(game: Game, faction: Faction): void {
  if (!game.eliminated.includes(faction)) game.eliminated.push(faction);
  game.pieces = game.pieces.filter(piece => piece.faction !== faction);
}

function nextTurn(game: Game, movedFaction: Faction, movedSlot: TurnSlot): { faction: Faction; slot: TurnSlot } {
  const living = ORDER.filter(faction => !game.eliminated.includes(faction));
  if (living.length === 2 && living.includes('wei')) {
    const ally = living.find(faction => faction !== 'wei') as 'shu' | 'wu';
    if (movedFaction === 'wei') return { faction: ally, slot: ally === 'shu' ? 1 : 3 };
    return { faction: 'wei', slot: ally === 'shu' ? 2 : 0 };
  }
  const slot = ((movedSlot + 1) % TURN_CYCLE.length) as TurnSlot;
  return { faction: TURN_CYCLE[slot], slot };
}

export function playMove(current: Game, pieceId: string, to: Point): MoveResult {
  if (current.status !== 'playing' || !current.turn || current.turnSlot === null) return { ok: false, error: '对局已经结束，可以重新开局或悔棋复盘。' };
  const piece = current.pieces.find(p => p.id === pieceId);
  if (!piece) return { ok: false, error: '这枚棋子已离开棋盘。' };
  if (piece.faction !== current.turn) return { ok: false, error: `现在轮到${PLAYERS[current.turn].name}行棋。` };
  const error = moveError(current.pieces, piece, to);
  if (error) return { ok: false, error };
  const game: Game = structuredClone(current), notices: string[] = [];
  const captured = at(current.pieces, to) ?? null;
  game.pieces = game.pieces.filter(p => p.id !== captured?.id)
    .map(p => p.id === pieceId ? { ...p, x: to.x, y: to.y } : p);
  if (captured?.kind === 'king') {
    eliminate(game, captured.faction);
    notices.push(`${PLAYERS[captured.faction].name}被吃，${PLAYERS[captured.faction].nation}军全部撤出。`);
  }
  const movedSlot = current.turnSlot;
  const record: MoveRecord = { number: game.history.length + 1, faction: piece.faction, turnSlot: movedSlot, pieceId, kind: piece.kind,
    from: { x: piece.x, y: piece.y }, to: { ...to }, captured: captured ? { ...captured } : null, eliminated: [] };
  if (!victory(game)) {
    while (game.status === 'playing') {
      const candidate = nextTurn(game, piece.faction, movedSlot);
      const hasMove = game.pieces.some(p => p.faction === candidate.faction && legalMoves(game.pieces, p).length > 0);
      if (!hasMove) {
        eliminate(game, candidate.faction); notices.push(`${PLAYERS[candidate.faction].name}无棋可走，困毙出局，全军撤出。`);
        if (victory(game)) break;
      } else { game.turn = candidate.faction; game.turnSlot = candidate.slot; break; }
    }
  }
  record.eliminated = game.eliminated.filter(f => !current.eliminated.includes(f));
  game.history.push(record); game.lastMove = record;
  if (game.status === 'finished') notices.push(game.winner === 'wei' ? '曹操获胜。' : '蜀吴联盟获胜。');
  else notices.push(`轮到${PLAYERS[game.turn!].name}行棋。`);
  return { ok: true, game, notices };
}

/** Reject malformed local snapshots rather than letting coordinates or status corrupt the board. */
export function validGame(value: unknown): value is Game {
  if (!value || typeof value !== 'object') return false;
  const game = value as Game;
  if (game.schema !== 2 || !Array.isArray(game.pieces) || !Array.isArray(game.history) || !Array.isArray(game.eliminated)) return false;
  if (!['playing', 'finished'].includes(game.status) || ![null, 'wei', 'alliance'].includes(game.winner)) return false;
  if (game.eliminated.some(f => !ORDER.includes(f)) || new Set(game.eliminated).size !== game.eliminated.length) return false;
  const isTurnSlot = (slot: unknown): slot is TurnSlot => Number.isInteger(slot) && Number(slot) >= 0 && Number(slot) < TURN_CYCLE.length;
  if (game.status === 'playing' && (!game.turn || !ORDER.includes(game.turn) || game.eliminated.includes(game.turn) || game.winner !== null
    || !isTurnSlot(game.turnSlot) || TURN_CYCLE[game.turnSlot] !== game.turn)) return false;
  if (game.status === 'finished' && (game.turn !== null || game.turnSlot !== null || game.winner === null)) return false;
  if (game.status === 'playing' && game.eliminated.includes('shu') !== game.eliminated.includes('wu')) {
    const expectedSlot = game.eliminated.includes('shu') ? (game.turn === 'wei' ? 0 : 3) : (game.turn === 'wei' ? 2 : 1);
    if (game.turnSlot !== expectedSlot) return false;
  }
  const ids = new Set<string>(), positions = new Set<string>();
  const kinds: Kind[] = ['king', 'rook', 'horse', 'elephant', 'advisor', 'cannon', 'pawn', 'feng'];
  for (const piece of game.pieces) {
    if (!piece || typeof piece.id !== 'string' || !ORDER.includes(piece.faction) || !kinds.includes(piece.kind) || !inside(piece)) return false;
    const key = `${piece.x},${piece.y}`;
    if (ids.has(piece.id) || positions.has(key) || game.eliminated.includes(piece.faction)) return false;
    ids.add(piece.id); positions.add(key);
  }
  for (const faction of ORDER) if (!game.eliminated.includes(faction) && game.pieces.filter(p => p.faction === faction && p.kind === 'king').length !== 1) return false;
  const validRecord = (r: MoveRecord, index: number) => r && r.number === index + 1 && ORDER.includes(r.faction)
    && isTurnSlot(r.turnSlot) && TURN_CYCLE[r.turnSlot] === r.faction
    && kinds.includes(r.kind) && typeof r.pieceId === 'string' && r.from && r.to && inside(r.from) && inside(r.to)
    && Array.isArray(r.eliminated) && r.eliminated.every(f => ORDER.includes(f));
  if (!game.history.every(validRecord)) return false;
  if (game.history.length ? !game.lastMove || !validRecord(game.lastMove, game.history.length - 1) : game.lastMove !== null) return false;
  return true;
}
