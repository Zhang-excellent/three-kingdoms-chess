export const FIVE_SOLDIERS_RULES_VERSION = 'five-soldiers-standard-v1';
export const FIVE_SOLDIERS_GAME_ID = 'five-soldiers';
export const FIVE_SOLDIERS_SESSION_KEY = 'three-kingdoms-chess:five-soldiers-session-v1';

export type FiveSide = 'red' | 'black';
export type FiveKind = 'general' | 'advisor' | 'elephant' | 'horse' | 'rook' | 'cannon' | 'pawn';
export type FivePhase = 'lobby' | 'playing' | 'finished';

export interface FivePoint {
  x: number;
  y: number;
}

export interface FivePiece extends FivePoint {
  id: string;
  side: FiveSide;
  kind: FiveKind;
}

export interface FiveMoveRecord {
  number: number;
  side: FiveSide;
  pieceId: string;
  kind: FiveKind;
  from: FivePoint;
  to: FivePoint;
  captured?: FivePiece;
}

export interface FiveGame {
  schema: 1;
  rulesVersion: typeof FIVE_SOLDIERS_RULES_VERSION;
  pieces: FivePiece[];
  turn: FiveSide;
  status: 'playing' | 'finished';
  winner: FiveSide | null;
  lastMove: FiveMoveRecord | null;
  history: FiveMoveRecord[];
}

export interface FivePlayerView {
  id: string;
  nickname: string;
  identity: 'account' | 'guest';
  side: FiveSide;
  ready: boolean;
  online: boolean;
  offlineUntil: number | null;
}

export interface FiveState {
  gameId: typeof FIVE_SOLDIERS_GAME_ID;
  phase: FivePhase;
  version: number;
  round: number;
  players: FivePlayerView[];
  game: FiveGame | null;
  selfId: string | null;
}

export interface FiveReceipt {
  gameId: typeof FIVE_SOLDIERS_GAME_ID;
  playerId: string;
  reconnectToken: string;
  state: FiveState;
}

export interface FiveMoveIntent {
  requestId: string;
  version: number;
  pieceId: string;
  to: FivePoint;
}

export type FiveAck<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string; state?: FiveState };

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

const ORTHOGONAL = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }] as const;
const DIAGONAL = [{ x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 }] as const;

const NAMES: Record<FiveSide, Record<FiveKind, string>> = {
  red: { general: '帅', advisor: '仕', elephant: '相', horse: '马', rook: '车', cannon: '炮', pawn: '兵' },
  black: { general: '将', advisor: '士', elephant: '象', horse: '马', rook: '车', cannon: '炮', pawn: '卒' },
};

export const FIVE_SIDE_NAMES: Record<FiveSide, string> = { red: '红方', black: '黑方' };

export function fiveSideName(side: FiveSide): string { return FIVE_SIDE_NAMES[side]; }
export function otherFiveSide(side: FiveSide): FiveSide { return side === 'red' ? 'black' : 'red'; }
export function fivePieceName(piece: Pick<FivePiece, 'side' | 'kind'>): string { return NAMES[piece.side][piece.kind]; }
export function isFiveSide(value: unknown): value is FiveSide { return value === 'red' || value === 'black'; }

export function newFiveGame(): FiveGame {
  const pieces: FivePiece[] = [];
  const add = (side: FiveSide, kind: FiveKind, x: number, y: number) =>
    pieces.push({ id: `${side}-${kind}-${x}-${y}`, side, kind, x, y });

  add('black', 'rook', 0, 0); add('black', 'horse', 1, 0); add('black', 'elephant', 2, 0);
  add('black', 'advisor', 3, 0); add('black', 'general', 4, 0); add('black', 'advisor', 5, 0);
  add('black', 'elephant', 6, 0); add('black', 'horse', 7, 0); add('black', 'rook', 8, 0);
  add('black', 'cannon', 1, 2); add('black', 'cannon', 7, 2);
  for (const x of [0, 2, 4, 6, 8]) add('black', 'pawn', x, 3);

  add('red', 'pawn', 0, 6); add('red', 'pawn', 2, 6); add('red', 'pawn', 4, 6);
  add('red', 'pawn', 6, 6); add('red', 'pawn', 8, 6);
  add('red', 'elephant', 2, 9); add('red', 'advisor', 3, 9); add('red', 'general', 4, 9);
  add('red', 'elephant', 6, 9); add('red', 'advisor', 5, 9);

  return {
    schema: 1,
    rulesVersion: FIVE_SOLDIERS_RULES_VERSION,
    pieces,
    turn: 'red',
    status: 'playing',
    winner: null,
    lastMove: null,
    history: [],
  };
}

export function fivePieceAt(pieces: readonly FivePiece[], point: FivePoint): FivePiece | null {
  return pieces.find(piece => piece.x === point.x && piece.y === point.y) ?? null;
}

export function legalFiveMoves(pieces: readonly FivePiece[], piece: FivePiece): FivePoint[] {
  const moves: FivePoint[] = [];
  const at = (x: number, y: number) => fivePieceAt(pieces, { x, y });
  const inside = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 9 && y >= 0 && y < 10;
  const targetAllowed = (x: number, y: number) => inside(x, y) && at(x, y)?.side !== piece.side;
  const add = (x: number, y: number) => { if (targetAllowed(x, y)) moves.push({ x, y }); };
  const inPalace = (x: number, y: number) => x >= 3 && x <= 5
    && (piece.side === 'red' ? y >= 7 && y <= 9 : y >= 0 && y <= 2);

  if (piece.kind === 'general') {
    for (const step of ORTHOGONAL) {
      const x = piece.x + step.x, y = piece.y + step.y;
      if (inPalace(x, y)) add(x, y);
    }
  } else if (piece.kind === 'advisor') {
    for (const step of DIAGONAL) {
      const x = piece.x + step.x, y = piece.y + step.y;
      if (inPalace(x, y)) add(x, y);
    }
  } else if (piece.kind === 'elephant') {
    for (const step of DIAGONAL) {
      const x = piece.x + step.x * 2, y = piece.y + step.y * 2;
      const sideOk = piece.side === 'red' ? y >= 5 : y <= 4;
      if (sideOk && !at(piece.x + step.x, piece.y + step.y)) add(x, y);
    }
  } else if (piece.kind === 'horse') {
    for (const step of HORSE_STEPS) {
      if (!at(piece.x + step.legX, piece.y + step.legY)) add(piece.x + step.dx, piece.y + step.dy);
    }
  } else if (piece.kind === 'rook') {
    for (const step of ORTHOGONAL) {
      let x = piece.x + step.x, y = piece.y + step.y;
      while (inside(x, y)) {
        const target = at(x, y);
        if (!target) moves.push({ x, y });
        else {
          if (target.side !== piece.side) moves.push({ x, y });
          break;
        }
        x += step.x; y += step.y;
      }
    }
  } else if (piece.kind === 'cannon') {
    for (const step of ORTHOGONAL) {
      let x = piece.x + step.x, y = piece.y + step.y, screenSeen = false;
      while (inside(x, y)) {
        const target = at(x, y);
        if (!screenSeen) {
          if (!target) moves.push({ x, y });
          else screenSeen = true;
        } else if (target) {
          if (target.side !== piece.side) moves.push({ x, y });
          break;
        }
        x += step.x; y += step.y;
      }
    }
  } else if (piece.kind === 'pawn') {
    const forward = piece.side === 'red' ? -1 : 1;
    add(piece.x, piece.y + forward);
    const crossed = piece.side === 'red' ? piece.y <= 4 : piece.y >= 5;
    if (crossed) { add(piece.x - 1, piece.y); add(piece.x + 1, piece.y); }
  }
  return moves;
}

export function validFiveGame(value: unknown): value is FiveGame {
  if (!value || typeof value !== 'object') return false;
  const game = value as FiveGame;
  if (game.schema !== 1 || game.rulesVersion !== FIVE_SOLDIERS_RULES_VERSION
    || (game.turn !== 'red' && game.turn !== 'black') || (game.status !== 'playing' && game.status !== 'finished')
    || (game.winner !== null && game.winner !== 'red' && game.winner !== 'black')
    || !Array.isArray(game.pieces) || !Array.isArray(game.history)) return false;
  const ids = new Set<string>(), points = new Set<string>();
  for (const piece of game.pieces) {
    if (!piece || typeof piece.id !== 'string' || !isFiveSide(piece.side)
      || !['general', 'advisor', 'elephant', 'horse', 'rook', 'cannon', 'pawn'].includes(piece.kind)
      || !Number.isInteger(piece.x) || !Number.isInteger(piece.y) || piece.x < 0 || piece.x > 8 || piece.y < 0 || piece.y > 9) return false;
    const point = `${piece.x},${piece.y}`;
    if (ids.has(piece.id) || points.has(point)) return false;
    ids.add(piece.id); points.add(point);
  }
  return game.status === 'playing' ? game.winner === null : game.winner !== null;
}

export function playFiveMove(game: FiveGame, pieceId: string, to: FivePoint): { ok: true; game: FiveGame } | { ok: false; error: string } {
  if (game.status !== 'playing') return { ok: false, error: '本局已经结束。' };
  const piece = game.pieces.find(item => item.id === pieceId);
  if (!piece) return { ok: false, error: '没有找到要移动的棋子。' };
  if (piece.side !== game.turn) return { ok: false, error: `现在轮到${fiveSideName(game.turn)}行棋。` };
  if (!legalFiveMoves(game.pieces, piece).some(move => move.x === to.x && move.y === to.y))
    return { ok: false, error: '这个位置不符合该棋子的走法。' };

  const next = structuredClone(game);
  const moving = next.pieces.find(item => item.id === pieceId)!;
  const from = { x: moving.x, y: moving.y };
  const captured = fivePieceAt(next.pieces, to) ?? undefined;
  if (captured) next.pieces = next.pieces.filter(item => item.id !== captured.id);
  moving.x = to.x; moving.y = to.y;
  const record: FiveMoveRecord = {
    number: next.history.length + 1,
    side: next.turn,
    pieceId,
    kind: moving.kind,
    from,
    to: { x: to.x, y: to.y },
    ...(captured ? { captured } : {}),
  };
  next.history.push(record);
  next.lastMove = record;
  if (captured?.kind === 'general') {
    next.status = 'finished';
    next.winner = next.turn;
  } else {
    next.turn = otherFiveSide(next.turn);
  }
  return { ok: true, game: next };
}

export function resignFiveGame(game: FiveGame, side: FiveSide): FiveGame {
  if (game.status !== 'playing') return structuredClone(game);
  const next = structuredClone(game);
  next.status = 'finished';
  next.winner = otherFiveSide(side);
  return next;
}

export function fivePieceCounts(game: FiveGame): Record<FiveSide, number> {
  return {
    red: game.pieces.filter(piece => piece.side === 'red').length,
    black: game.pieces.filter(piece => piece.side === 'black').length,
  };
}
