export type BeastSide = 'lower' | 'upper';
export type BeastKind = 'elephant' | 'lion' | 'tiger' | 'leopard' | 'wolf' | 'dog' | 'cat' | 'rat';
export type BeastStatus = 'playing' | 'finished';
export type BeastDrawReason = 'threefold' | 'halfmove';
export type BeastFinishReason = 'den' | 'capture-all' | 'stalemate' | BeastDrawReason;
export type BeastTerrainKind = 'land' | 'river' | 'trap' | 'den';

export interface BeastPoint {
  x: number;
  y: number;
}

export interface BeastPiece extends BeastPoint {
  id: string;
  side: BeastSide;
  kind: BeastKind;
}

export interface BeastTerrain {
  kind: BeastTerrainKind;
  owner: BeastSide | null;
}

export interface BeastMove {
  number: number;
  side: BeastSide;
  pieceId: string;
  kind: BeastKind;
  from: BeastPoint;
  to: BeastPoint;
  captured: BeastPiece | null;
  path: BeastPoint[];
  jumpedRiver: boolean;
}

export interface BeastGameState {
  schema: 1;
  rulesVersion: typeof BEAST_CHESS_RULES_VERSION;
  initialPieces: BeastPiece[];
  initialTurn: BeastSide;
  pieces: BeastPiece[];
  turn: BeastSide | null;
  status: BeastStatus;
  winner: BeastSide | null;
  drawReason: BeastDrawReason | null;
  finishReason: BeastFinishReason | null;
  history: BeastMove[];
  lastMove: BeastMove | null;
  noCaptureHalfMoves: number;
  positionCounts: Record<string, number>;
}

export interface BeastGame extends BeastGameState {
  undoStates: BeastGameState[];
}

export type BeastResult =
  | { ok: true; game: BeastGame; notice: string }
  | { ok: false; error: string };

export const BEAST_CHESS_RULES_VERSION = 'beast-chess-v1';
export const BEAST_BOARD_COLUMNS = 7;
export const BEAST_BOARD_ROWS = 9;
export const BEAST_REPETITION_DRAW_COUNT = 3;
export const BEAST_HALFMOVE_DRAW_COUNT = 100;

export const BEAST_KIND_NAMES: Record<BeastKind, string> = {
  elephant: '象',
  lion: '狮',
  tiger: '虎',
  leopard: '豹',
  wolf: '狼',
  dog: '狗',
  cat: '猫',
  rat: '鼠',
};

export const BEAST_KIND_RANKS: Record<BeastKind, number> = {
  elephant: 8,
  lion: 7,
  tiger: 6,
  leopard: 5,
  wolf: 4,
  dog: 3,
  cat: 2,
  rat: 1,
};

export const BEAST_SIDE_NAMES: Record<BeastSide, string> = {
  lower: '下方',
  upper: '上方',
};

const INITIAL_PIECES: readonly Omit<BeastPiece, 'id'>[] = [
  { side: 'lower', kind: 'tiger', x: 0, y: 0 },
  { side: 'lower', kind: 'lion', x: 6, y: 0 },
  { side: 'lower', kind: 'cat', x: 1, y: 1 },
  { side: 'lower', kind: 'dog', x: 5, y: 1 },
  { side: 'lower', kind: 'elephant', x: 0, y: 2 },
  { side: 'lower', kind: 'wolf', x: 2, y: 2 },
  { side: 'lower', kind: 'leopard', x: 4, y: 2 },
  { side: 'lower', kind: 'rat', x: 6, y: 2 },
  { side: 'upper', kind: 'lion', x: 0, y: 8 },
  { side: 'upper', kind: 'tiger', x: 6, y: 8 },
  { side: 'upper', kind: 'dog', x: 1, y: 7 },
  { side: 'upper', kind: 'cat', x: 5, y: 7 },
  { side: 'upper', kind: 'rat', x: 0, y: 6 },
  { side: 'upper', kind: 'leopard', x: 2, y: 6 },
  { side: 'upper', kind: 'wolf', x: 4, y: 6 },
  { side: 'upper', kind: 'elephant', x: 6, y: 6 },
];

const ONE_STEPS: readonly BeastPoint[] = [
  { x: 0, y: 1 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: -1, y: 0 },
];

const RIVER_JUMPS: readonly BeastPoint[] = [
  { x: -3, y: 0 },
  { x: 3, y: 0 },
  { x: 0, y: -4 },
  { x: 0, y: 4 },
];

export const BEAST_INITIAL_POSITIONS: ReadonlyArray<Readonly<BeastPiece>> = INITIAL_PIECES.map((piece, index) => ({
  id: `${piece.side}-${piece.kind}-${piece.x}-${piece.y}-${index}`,
  ...piece,
}));

export function isBeastPoint(value: unknown): value is BeastPoint {
  const point = value as Partial<BeastPoint> | null;
  return Number.isInteger(point?.x)
    && Number.isInteger(point?.y)
    && point!.x! >= 0
    && point!.x! < BEAST_BOARD_COLUMNS
    && point!.y! >= 0
    && point!.y! < BEAST_BOARD_ROWS;
}

export function beastCoordinate(point: BeastPoint): string {
  if (!isBeastPoint(point)) throw new Error('斗兽棋坐标超出棋盘。');
  return `${String.fromCharCode('A'.charCodeAt(0) + point.x)}${point.y + 1}`;
}

export function beastTerrain(point: BeastPoint): BeastTerrain {
  if (!isBeastPoint(point)) throw new Error('斗兽棋坐标超出棋盘。');
  if (point.x === 3 && point.y === 0) return { kind: 'den', owner: 'lower' };
  if (point.x === 3 && point.y === 8) return { kind: 'den', owner: 'upper' };
  if ((point.x === 2 || point.x === 4) && point.y === 0) return { kind: 'trap', owner: 'lower' };
  if (point.x === 3 && point.y === 1) return { kind: 'trap', owner: 'lower' };
  if ((point.x === 2 || point.x === 4) && point.y === 8) return { kind: 'trap', owner: 'upper' };
  if (point.x === 3 && point.y === 7) return { kind: 'trap', owner: 'upper' };
  if ((point.y === 3 || point.y === 4 || point.y === 5)
    && (point.x === 1 || point.x === 2 || point.x === 4 || point.x === 5))
    return { kind: 'river', owner: null };
  return { kind: 'land', owner: null };
}

export function beastPieceAt(pieces: readonly BeastPiece[], point: BeastPoint): BeastPiece | null {
  return pieces.find(piece => piece.x === point.x && piece.y === point.y) ?? null;
}

export function beastEffectiveRank(piece: BeastPiece, point: BeastPoint = piece): number {
  const terrain = beastTerrain(point);
  return terrain.kind === 'trap' && terrain.owner !== piece.side ? 0 : BEAST_KIND_RANKS[piece.kind];
}

export function otherBeastSide(side: BeastSide): BeastSide {
  return side === 'lower' ? 'upper' : 'lower';
}

export function beastPieceCounts(pieces: readonly BeastPiece[]): Record<BeastSide, number> {
  return {
    lower: pieces.filter(piece => piece.side === 'lower').length,
    upper: pieces.filter(piece => piece.side === 'upper').length,
  };
}

export function capturedBeastPieces(game: BeastGameState): Record<BeastSide, BeastPiece[]> {
  const currentIds = new Set(game.pieces.map(piece => piece.id));
  return {
    lower: game.initialPieces.filter(piece => piece.side === 'lower' && !currentIds.has(piece.id)),
    upper: game.initialPieces.filter(piece => piece.side === 'upper' && !currentIds.has(piece.id)),
  };
}

function captureAllowed(attacker: BeastPiece, target: BeastPiece, to: BeastPoint): boolean {
  const attackRank = beastEffectiveRank(attacker);
  const defenseRank = beastEffectiveRank(target, to);
  if (attackRank === 0) return false;
  if (defenseRank === 0) return true;
  if (attacker.kind === 'rat' && target.kind === 'elephant') return true;
  if (attacker.kind === 'elephant' && target.kind === 'rat') return false;
  return attackRank >= defenseRank;
}

interface BeastStep {
  path: BeastPoint[];
  jumpedRiver: boolean;
}

type BeastStepResult = BeastStep | { error: string };

function stepFor(pieces: readonly BeastPiece[], piece: BeastPiece, to: BeastPoint): BeastStepResult {
  if (!isBeastPoint(to)) return { error: '不能走出棋盘。' };
  if (to.x === piece.x && to.y === piece.y) return { error: '请选择另一个格子。' };
  const target = beastPieceAt(pieces, to);
  if (target?.side === piece.side) return { error: '不能进入己方棋子所在的格子。' };
  const destination = beastTerrain(to);
  if (destination.kind === 'den' && destination.owner === piece.side)
    return { error: '不能进入己方兽穴。' };

  const dx = to.x - piece.x;
  const dy = to.y - piece.y;
  if (Math.abs(dx) + Math.abs(dy) === 1) {
    const source = beastTerrain(piece);
    if (destination.kind === 'river' && piece.kind !== 'rat')
      return { error: '只有鼠可以进入河流。' };
    if (target && (source.kind === 'river' || destination.kind === 'river')) {
      const bothInRiver = source.kind === 'river' && destination.kind === 'river';
      if (!bothInRiver || piece.kind !== 'rat' || target.kind !== 'rat')
        return { error: '不能跨水陆吃子；河中鼠只能吃河中的鼠。' };
    }
    if (target && !captureAllowed(piece, target, to))
      return { error: '当前棋子不能吃掉目标棋子。' };
    return { path: [{ ...to }], jumpedRiver: false };
  }

  if (piece.kind !== 'lion' && piece.kind !== 'tiger')
    return { error: '普通棋子每次只能上下左右走一格。' };
  if (!RIVER_JUMPS.some(offset => offset.x === dx && offset.y === dy))
    return { error: '狮子、老虎只能横跨两格河或纵跨三格河。' };

  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const path: BeastPoint[] = [];
  const crossingLength = Math.abs(dx) + Math.abs(dy) - 1;
  for (let distance = 1; distance <= crossingLength; distance++) {
    const point = { x: piece.x + stepX * distance, y: piece.y + stepY * distance };
    if (beastTerrain(point).kind !== 'river')
      return { error: '跳河必须完整越过连续河流。' };
    if (beastPieceAt(pieces, point))
      return { error: '河流路径中有棋子，不能跳河。' };
    path.push(point);
  }
  if (target && !captureAllowed(piece, target, to))
    return { error: '当前棋子不能吃掉目标棋子。' };
  return { path, jumpedRiver: true };
}

export function legalBeastMoves(game: BeastGameState, pieceId: string): BeastPoint[] {
  if (game.status !== 'playing' || !game.turn) return [];
  const piece = game.pieces.find(item => item.id === pieceId);
  if (!piece || piece.side !== game.turn) return [];
  const moves: BeastPoint[] = [];
  for (let y = 0; y < BEAST_BOARD_ROWS; y++) {
    for (let x = 0; x < BEAST_BOARD_COLUMNS; x++) {
      const to = { x, y };
      if (!('error' in stepFor(game.pieces, piece, to))) moves.push(to);
    }
  }
  return moves;
}

export function beastHasAnyLegalMove(pieces: readonly BeastPiece[], side: BeastSide): boolean {
  for (const piece of pieces.filter(item => item.side === side)) {
    for (const direction of ONE_STEPS) {
      const to = { x: piece.x + direction.x, y: piece.y + direction.y };
      if (isBeastPoint(to) && !('error' in stepFor(pieces, piece, to))) return true;
    }
    if (piece.kind === 'lion' || piece.kind === 'tiger') {
      for (const jump of RIVER_JUMPS) {
        const to = { x: piece.x + jump.x, y: piece.y + jump.y };
        if (isBeastPoint(to) && !('error' in stepFor(pieces, piece, to))) return true;
      }
    }
  }
  return false;
}

export function beastPositionKey(pieces: readonly BeastPiece[], turn: BeastSide): string {
  const board = pieces
    .map(piece => `${piece.side}:${piece.kind}:${piece.x}:${piece.y}`)
    .sort()
    .join('|');
  return `${turn}|${board}`;
}

function cloneState(game: BeastGameState): BeastGameState {
  return structuredClone({
    schema: game.schema,
    rulesVersion: game.rulesVersion,
    initialPieces: game.initialPieces,
    initialTurn: game.initialTurn,
    pieces: game.pieces,
    turn: game.turn,
    status: game.status,
    winner: game.winner,
    drawReason: game.drawReason,
    finishReason: game.finishReason,
    history: game.history,
    lastMove: game.lastMove,
    noCaptureHalfMoves: game.noCaptureHalfMoves,
    positionCounts: game.positionCounts,
  });
}

function withUndo(state: BeastGameState, undoStates: readonly BeastGameState[]): BeastGame {
  return { ...state, undoStates: undoStates.map(cloneState) };
}

function validatePieces(pieces: readonly BeastPiece[]): void {
  const ids = new Set<string>();
  const points = new Set<string>();
  for (const piece of pieces) {
    if (typeof piece.id !== 'string' || !piece.id)
      throw new Error('棋子缺少有效编号。');
    if (!Number.isInteger(piece.x) || !Number.isInteger(piece.y)
      || piece.x < 0 || piece.x >= BEAST_BOARD_COLUMNS
      || piece.y < 0 || piece.y >= BEAST_BOARD_ROWS)
      throw new Error(`棋子 ${piece.id} 的坐标超出棋盘。`);
    if (!(piece.side in BEAST_SIDE_NAMES) || !(piece.kind in BEAST_KIND_NAMES))
      throw new Error(`棋子 ${piece.id} 的阵营或种类无效。`);
    if (ids.has(piece.id)) throw new Error(`棋子编号重复：${piece.id}`);
    const point = `${piece.x},${piece.y}`;
    if (points.has(point)) throw new Error(`棋子位置重叠：${beastCoordinate(piece)}`);
    ids.add(piece.id);
    points.add(point);
  }
}

export function createBeastGame(pieces: readonly BeastPiece[], turn: BeastSide = 'lower'): BeastGame {
  validatePieces(pieces);
  const initialPieces = structuredClone([...pieces]);
  const state: BeastGameState = {
    schema: 1,
    rulesVersion: BEAST_CHESS_RULES_VERSION,
    initialPieces,
    initialTurn: turn,
    pieces: structuredClone(initialPieces),
    turn,
    status: 'playing',
    winner: null,
    drawReason: null,
    finishReason: null,
    history: [],
    lastMove: null,
    noCaptureHalfMoves: 0,
    positionCounts: { [beastPositionKey(initialPieces, turn)]: 1 },
  };
  return withUndo(state, []);
}

export function newBeastGame(): BeastGame {
  return createBeastGame(BEAST_INITIAL_POSITIONS.map(piece => ({ ...piece })));
}

function finishGame(
  game: BeastGameState,
  winner: BeastSide | null,
  finishReason: BeastFinishReason,
  drawReason: BeastDrawReason | null,
): void {
  game.status = 'finished';
  game.winner = winner;
  game.turn = null;
  game.finishReason = finishReason;
  game.drawReason = drawReason;
}

export function playBeastMove(game: BeastGame, pieceId: string, to: BeastPoint): BeastResult {
  if (game.status !== 'playing' || !game.turn)
    return { ok: false, error: '对局已经结束。' };
  const piece = game.pieces.find(item => item.id === pieceId);
  if (!piece) return { ok: false, error: '没有找到要移动的棋子。' };
  if (piece.side !== game.turn)
    return { ok: false, error: `现在轮到${BEAST_SIDE_NAMES[game.turn]}行棋。` };
  const step = stepFor(game.pieces, piece, to);
  if ('error' in step) return { ok: false, error: step.error };

  const snapshot = cloneState(game);
  const next = cloneState(game);
  const moving = next.pieces.find(item => item.id === pieceId)!;
  const captured = beastPieceAt(next.pieces, to);
  const from = { x: moving.x, y: moving.y };
  if (captured) next.pieces = next.pieces.filter(item => item.id !== captured.id);
  moving.x = to.x;
  moving.y = to.y;

  const move: BeastMove = {
    number: next.history.length + 1,
    side: piece.side,
    pieceId,
    kind: piece.kind,
    from,
    to: { ...to },
    captured: captured ? structuredClone(captured) : null,
    path: step.path.map(point => ({ ...point })),
    jumpedRiver: step.jumpedRiver,
  };
  next.history.push(move);
  next.lastMove = move;
  next.noCaptureHalfMoves = captured ? 0 : next.noCaptureHalfMoves + 1;

  const opponent = otherBeastSide(piece.side);
  const destination = beastTerrain(to);
  if (destination.kind === 'den' && destination.owner === opponent) {
    finishGame(next, piece.side, 'den', null);
    return withUndoResult(next, game, `${BEAST_SIDE_NAMES[piece.side]}进入敌方兽穴，获得胜利。`);
  }
  const opponentPieces = next.pieces.filter(item => item.side === opponent);
  if (opponentPieces.length === 0) {
    finishGame(next, piece.side, 'capture-all', null);
    return withUndoResult(next, game, `${BEAST_SIDE_NAMES[piece.side]}吃光对方棋子，获得胜利。`);
  }
  if (!beastHasAnyLegalMove(next.pieces, opponent)) {
    finishGame(next, piece.side, 'stalemate', null);
    return withUndoResult(next, game, `${BEAST_SIDE_NAMES[opponent]}无子可走，${BEAST_SIDE_NAMES[piece.side]}获胜。`);
  }

  next.turn = opponent;
  const key = beastPositionKey(next.pieces, opponent);
  next.positionCounts[key] = (next.positionCounts[key] ?? 0) + 1;
  if (next.positionCounts[key] >= BEAST_REPETITION_DRAW_COUNT) {
    finishGame(next, null, 'threefold', 'threefold');
    return withUndoResult(next, game, '同一完整局面第三次出现，本局和棋。');
  }
  if (next.noCaptureHalfMoves >= BEAST_HALFMOVE_DRAW_COUNT) {
    finishGame(next, null, 'halfmove', 'halfmove');
    return withUndoResult(next, game, '连续 100 个半回合没有吃子，本局和棋。');
  }
  return withUndoResult(next, game, `轮到${BEAST_SIDE_NAMES[opponent]}行棋。`);
}

function withUndoResult(state: BeastGameState, previous: BeastGame, notice: string): BeastResult {
  const undoStates = [...previous.undoStates.map(cloneState), cloneState(previous)];
  return { ok: true, game: withUndo(state, undoStates), notice };
}

export function undoBeastMove(game: BeastGame): BeastGame | null {
  const previous = game.undoStates.at(-1);
  if (!previous) return null;
  return withUndo(cloneState(previous), game.undoStates.slice(0, -1));
}

export function cloneBeastGame(game: BeastGame): BeastGame {
  return withUndo(cloneState(game), game.undoStates);
}
