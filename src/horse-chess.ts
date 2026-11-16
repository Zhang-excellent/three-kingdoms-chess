export const HORSE_CHESS_RULES_VERSION = 'horse-chess-nine-horses-v1';
export const HORSE_CHESS_GAME_ID = 'horse-chess';
export const HORSE_CHESS_SESSION_KEY = 'three-kingdoms-chess:horse-chess-session-v1';

export type HorseSide = 'red' | 'black';
export type HorsePhase = 'lobby' | 'playing' | 'finished';

export interface HorsePoint {
  x: number;
  y: number;
}

export interface HorsePiece extends HorsePoint {
  id: string;
  side: HorseSide;
}

export interface HorseMoveRecord {
  number: number;
  side: HorseSide;
  pieceId: string;
  from: HorsePoint;
  to: HorsePoint;
  captured?: HorsePiece;
}

export interface HorseGame {
  schema: 1;
  rulesVersion: typeof HORSE_CHESS_RULES_VERSION;
  pieces: HorsePiece[];
  turn: HorseSide;
  status: 'playing' | 'finished';
  winner: HorseSide | null;
  lastMove: HorseMoveRecord | null;
  history: HorseMoveRecord[];
}

export interface HorsePlayerView {
  id: string;
  nickname: string;
  identity: 'account' | 'guest';
  side: HorseSide;
  ready: boolean;
  online: boolean;
  offlineUntil: number | null;
}

export interface HorseState {
  gameId: typeof HORSE_CHESS_GAME_ID;
  phase: HorsePhase;
  version: number;
  round: number;
  players: HorsePlayerView[];
  game: HorseGame | null;
  selfId: string | null;
}

export interface HorseReceipt {
  gameId: typeof HORSE_CHESS_GAME_ID;
  playerId: string;
  reconnectToken: string;
  state: HorseState;
}

export interface HorseMoveIntent {
  requestId: string;
  version: number;
  pieceId: string;
  to: HorsePoint;
}

export type HorseAck<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string; state?: HorseState };

const HORSE_STEPS = [
  { dx: 2, dy: 1, legX: 1, legY: 0 },
  { dx: 2, dy: -1, legX: 1, legY: 0 },
  { dx: -2, dy: 1, legX: -1, legY: 0 },
  { dx: -2, dy: -1, legX: -1, legY: 0 },
  { dx: 1, dy: 2, legX: 0, legY: 1 },
  { dx: -1, dy: 2, legX: 0, legY: 1 },
  { dx: 1, dy: -2, legX: 0, legY: -1 },
  { dx: -1, dy: -2, legX: 0, legY: -1 },
] as const;

export const HORSE_SIDE_NAMES: Record<HorseSide, string> = { red: '红方', black: '黑方' };
export const HORSE_GOALS: Record<HorseSide, HorsePoint & { label: string; owner: HorseSide }> = {
  red: { x: 4, y: 0, label: '将', owner: 'black' },
  black: { x: 4, y: 9, label: '帅', owner: 'red' },
};

export function horseSideName(side: HorseSide): string { return HORSE_SIDE_NAMES[side]; }
export function otherHorseSide(side: HorseSide): HorseSide { return side === 'red' ? 'black' : 'red'; }
export function isHorseSide(value: unknown): value is HorseSide { return value === 'red' || value === 'black'; }

export function newHorseGame(): HorseGame {
  const pieces: HorsePiece[] = [];
  for (let x = 0; x < 9; x++) {
    pieces.push({ id: `black-horse-${x}`, side: 'black', x, y: 0 });
    pieces.push({ id: `red-horse-${x}`, side: 'red', x, y: 9 });
  }
  return {
    schema: 1,
    rulesVersion: HORSE_CHESS_RULES_VERSION,
    pieces,
    turn: 'red',
    status: 'playing',
    winner: null,
    lastMove: null,
    history: [],
  };
}

export function horsePieceAt(pieces: readonly HorsePiece[], point: HorsePoint): HorsePiece | null {
  return pieces.find(piece => piece.x === point.x && piece.y === point.y) ?? null;
}

export function legalHorseMoves(pieces: readonly HorsePiece[], piece: HorsePiece): HorsePoint[] {
  const inside = (x: number, y: number) => x >= 0 && x < 9 && y >= 0 && y < 10;
  const moves: HorsePoint[] = [];
  for (const step of HORSE_STEPS) {
    const x = piece.x + step.dx, y = piece.y + step.dy;
    if (!inside(x, y) || horsePieceAt(pieces, { x: piece.x + step.legX, y: piece.y + step.legY })) continue;
    if (horsePieceAt(pieces, { x, y })?.side === piece.side) continue;
    moves.push({ x, y });
  }
  return moves;
}

export function validHorseGame(value: unknown): value is HorseGame {
  if (!value || typeof value !== 'object') return false;
  const game = value as HorseGame;
  if (game.schema !== 1 || game.rulesVersion !== HORSE_CHESS_RULES_VERSION
    || !isHorseSide(game.turn) || (game.status !== 'playing' && game.status !== 'finished')
    || (game.winner !== null && !isHorseSide(game.winner))
    || !Array.isArray(game.pieces) || !Array.isArray(game.history)) return false;
  const ids = new Set<string>(), points = new Set<string>();
  for (const piece of game.pieces) {
    if (!piece || typeof piece.id !== 'string' || !isHorseSide(piece.side)
      || !Number.isInteger(piece.x) || !Number.isInteger(piece.y)
      || piece.x < 0 || piece.x > 8 || piece.y < 0 || piece.y > 9) return false;
    const point = `${piece.x},${piece.y}`;
    if (ids.has(piece.id) || points.has(point)) return false;
    ids.add(piece.id); points.add(point);
  }
  return game.status === 'playing' ? game.winner === null : game.winner !== null;
}

export function playHorseMove(game: HorseGame, pieceId: string, to: HorsePoint):
  { ok: true; game: HorseGame } | { ok: false; error: string } {
  if (game.status !== 'playing') return { ok: false, error: '本局已经结束。' };
  const piece = game.pieces.find(item => item.id === pieceId);
  if (!piece) return { ok: false, error: '没有找到要移动的马。' };
  if (piece.side !== game.turn) return { ok: false, error: `现在轮到${horseSideName(game.turn)}行棋。` };
  if (!legalHorseMoves(game.pieces, piece).some(move => move.x === to.x && move.y === to.y))
    return { ok: false, error: '马走日字，且马腿不能有棋子。' };

  const next = structuredClone(game);
  const moving = next.pieces.find(item => item.id === pieceId)!;
  const from = { x: moving.x, y: moving.y };
  const captured = horsePieceAt(next.pieces, to) ?? undefined;
  if (captured) next.pieces = next.pieces.filter(item => item.id !== captured.id);
  moving.x = to.x; moving.y = to.y;
  const record: HorseMoveRecord = {
    number: next.history.length + 1,
    side: next.turn,
    pieceId,
    from,
    to: { x: to.x, y: to.y },
    ...(captured ? { captured } : {}),
  };
  next.history.push(record);
  next.lastMove = record;
  const goal = HORSE_GOALS[next.turn];
  if (to.x === goal.x && to.y === goal.y) {
    next.status = 'finished';
    next.winner = next.turn;
  } else {
    next.turn = otherHorseSide(next.turn);
  }
  return { ok: true, game: next };
}

export function resignHorseGame(game: HorseGame, side: HorseSide): HorseGame {
  if (game.status !== 'playing') return structuredClone(game);
  const next = structuredClone(game);
  next.status = 'finished';
  next.winner = otherHorseSide(side);
  return next;
}
