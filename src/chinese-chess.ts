export const CHINESE_CHESS_RULES_VERSION = 'chinese-chess-classic-v1';
export const CHINESE_CHESS_GAME_ID = 'chinese-chess';
export const CHINESE_CHESS_SESSION_KEY = 'three-kingdoms-chess:chinese-chess-session-v1';

export type ChineseSide = 'red' | 'black';
export type ChineseKind = 'king' | 'advisor' | 'elephant' | 'horse' | 'rook' | 'cannon' | 'pawn';
export type ChinesePhase = 'lobby' | 'playing' | 'finished';
export type ChineseEndReason = 'checkmate' | 'stalemate' | 'resignation' | null;

export interface ChinesePoint {
  x: number;
  y: number;
}

export interface ChinesePiece extends ChinesePoint {
  id: string;
  side: ChineseSide;
  kind: ChineseKind;
}

export interface ChineseMoveRecord {
  number: number;
  side: ChineseSide;
  pieceId: string;
  kind: ChineseKind;
  from: ChinesePoint;
  to: ChinesePoint;
  captured?: ChinesePiece;
}

export interface ChineseGame {
  schema: 1;
  rulesVersion: typeof CHINESE_CHESS_RULES_VERSION;
  pieces: ChinesePiece[];
  turn: ChineseSide;
  status: 'playing' | 'finished';
  winner: ChineseSide | null;
  endReason: ChineseEndReason;
  lastMove: ChineseMoveRecord | null;
  history: ChineseMoveRecord[];
}

export interface ChinesePlayerView {
  id: string;
  nickname: string;
  identity: 'account' | 'guest';
  side: ChineseSide;
  ready: boolean;
  online: boolean;
  offlineUntil: number | null;
}

export interface ChineseState {
  gameId: typeof CHINESE_CHESS_GAME_ID;
  phase: ChinesePhase;
  version: number;
  round: number;
  players: ChinesePlayerView[];
  game: ChineseGame | null;
  selfId: string | null;
}

export interface ChineseReceipt {
  gameId: typeof CHINESE_CHESS_GAME_ID;
  playerId: string;
  reconnectToken: string;
  state: ChineseState;
}

export interface ChineseMoveIntent {
  requestId: string;
  version: number;
  pieceId: string;
  to: ChinesePoint;
}

export type ChineseAck<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string; state?: ChineseState };

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

export const CHINESE_SIDE_NAMES: Record<ChineseSide, string> = { red: '红方', black: '黑方' };

export function chineseSideName(side: ChineseSide): string { return CHINESE_SIDE_NAMES[side]; }
export function otherChineseSide(side: ChineseSide): ChineseSide { return side === 'red' ? 'black' : 'red'; }
export function isChineseSide(value: unknown): value is ChineseSide { return value === 'red' || value === 'black'; }
export function chinesePieceName(piece: Pick<ChinesePiece, 'side' | 'kind'>): string {
  return ({
    red: { king: '帅', advisor: '仕', elephant: '相', horse: '马', rook: '车', cannon: '炮', pawn: '兵' },
    black: { king: '将', advisor: '士', elephant: '象', horse: '马', rook: '车', cannon: '炮', pawn: '卒' },
  } as const)[piece.side][piece.kind];
}

export function newChineseGame(): ChineseGame {
  const pieces: ChinesePiece[] = [];
  const add = (side: ChineseSide, kind: ChineseKind, x: number, y: number) =>
    pieces.push({ id: `${side}-${kind}-${x}-${y}`, side, kind, x, y });
  const back: ChineseKind[] = ['rook', 'horse', 'elephant', 'advisor', 'king', 'advisor', 'elephant', 'horse', 'rook'];
  back.forEach((kind, x) => add('black', kind, x, 0));
  [1, 7].forEach(x => add('black', 'cannon', x, 2));
  [0, 2, 4, 6, 8].forEach(x => add('black', 'pawn', x, 3));
  back.forEach((kind, x) => add('red', kind, x, 9));
  [1, 7].forEach(x => add('red', 'cannon', x, 7));
  [0, 2, 4, 6, 8].forEach(x => add('red', 'pawn', x, 6));
  return {
    schema: 1,
    rulesVersion: CHINESE_CHESS_RULES_VERSION,
    pieces,
    turn: 'red',
    status: 'playing',
    winner: null,
    endReason: null,
    lastMove: null,
    history: [],
  };
}

export function chinesePieceAt(pieces: readonly ChinesePiece[], point: ChinesePoint): ChinesePiece | null {
  return pieces.find(piece => piece.x === point.x && piece.y === point.y) ?? null;
}

const inside = (point: ChinesePoint): boolean =>
  Number.isInteger(point.x) && Number.isInteger(point.y) && point.x >= 0 && point.x < 9 && point.y >= 0 && point.y < 10;
const inPalace = (side: ChineseSide, point: ChinesePoint): boolean =>
  point.x >= 3 && point.x <= 5 && (side === 'red' ? point.y >= 7 && point.y <= 9 : point.y >= 0 && point.y <= 2);

function betweenCount(pieces: readonly ChinesePiece[], from: ChinesePoint, to: ChinesePoint): number {
  const dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
  let x = from.x + dx, y = from.y + dy, count = 0;
  while (x !== to.x || y !== to.y) {
    if (chinesePieceAt(pieces, { x, y })) count++;
    x += dx; y += dy;
  }
  return count;
}

function pseudoMoves(pieces: readonly ChinesePiece[], piece: ChinesePiece): ChinesePoint[] {
  const moves: ChinesePoint[] = [];
  const at = (x: number, y: number) => chinesePieceAt(pieces, { x, y });
  const canLand = (x: number, y: number) => inside({ x, y }) && at(x, y)?.side !== piece.side;
  const add = (x: number, y: number) => { if (canLand(x, y)) moves.push({ x, y }); };

  if (piece.kind === 'king') {
    for (const step of ORTHOGONAL) {
      const point = { x: piece.x + step.x, y: piece.y + step.y };
      if (inPalace(piece.side, point)) add(point.x, point.y);
    }
    for (const direction of [-1, 1]) {
      let y = piece.y + direction;
      while (y >= 0 && y < 10) {
        const target = at(piece.x, y);
        if (target) {
          if (target.side !== piece.side && target.kind === 'king') add(piece.x, y);
          break;
        }
        y += direction;
      }
    }
  } else if (piece.kind === 'advisor') {
    for (const step of DIAGONAL) {
      const point = { x: piece.x + step.x, y: piece.y + step.y };
      if (inPalace(piece.side, point)) add(point.x, point.y);
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
      while (inside({ x, y })) {
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
      while (inside({ x, y })) {
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
  } else {
    const forward = piece.side === 'red' ? -1 : 1;
    add(piece.x, piece.y + forward);
    const crossed = piece.side === 'red' ? piece.y <= 4 : piece.y >= 5;
    if (crossed) { add(piece.x - 1, piece.y); add(piece.x + 1, piece.y); }
  }
  return moves;
}

function applyMovePieces(pieces: readonly ChinesePiece[], piece: ChinesePiece, to: ChinesePoint): ChinesePiece[] {
  const captured = chinesePieceAt(pieces, to);
  return pieces
    .filter(item => item.id !== captured?.id)
    .map(item => item.id === piece.id ? { ...item, x: to.x, y: to.y } : item);
}

export function isChineseKingInCheck(pieces: readonly ChinesePiece[], side: ChineseSide): boolean {
  const king = pieces.find(piece => piece.side === side && piece.kind === 'king');
  if (!king) return true;
  return pieces.some(piece => piece.side !== side
    && pseudoMoves(pieces, piece).some(move => move.x === king.x && move.y === king.y));
}

export function legalChineseMoves(pieces: readonly ChinesePiece[], piece: ChinesePiece): ChinesePoint[] {
  return pseudoMoves(pieces, piece).filter(to => !isChineseKingInCheck(applyMovePieces(pieces, piece, to), piece.side));
}

export function allLegalChineseMoves(game: ChineseGame, side = game.turn): Array<{ piece: ChinesePiece; to: ChinesePoint }> {
  return game.pieces.filter(piece => piece.side === side)
    .flatMap(piece => legalChineseMoves(game.pieces, piece).map(to => ({ piece, to })));
}

export function validChineseGame(value: unknown): value is ChineseGame {
  if (!value || typeof value !== 'object') return false;
  const game = value as ChineseGame;
  if (game.schema !== 1 || game.rulesVersion !== CHINESE_CHESS_RULES_VERSION
    || !isChineseSide(game.turn) || (game.status !== 'playing' && game.status !== 'finished')
    || (game.winner !== null && !isChineseSide(game.winner))
    || !['checkmate', 'stalemate', 'resignation', null].includes(game.endReason)
    || !Array.isArray(game.pieces) || !Array.isArray(game.history)) return false;
  const ids = new Set<string>(), points = new Set<string>();
  for (const piece of game.pieces) {
    if (!piece || typeof piece.id !== 'string' || !isChineseSide(piece.side)
      || !['king', 'advisor', 'elephant', 'horse', 'rook', 'cannon', 'pawn'].includes(piece.kind)
      || !inside(piece)) return false;
    const point = `${piece.x},${piece.y}`;
    if (ids.has(piece.id) || points.has(point)) return false;
    ids.add(piece.id); points.add(point);
  }
  if (game.status === 'playing') return game.winner === null && game.endReason === null;
  return game.winner !== null && game.endReason !== null;
}

export function playChineseMove(game: ChineseGame, pieceId: string, to: ChinesePoint):
  { ok: true; game: ChineseGame } | { ok: false; error: string } {
  if (game.status !== 'playing') return { ok: false, error: '本局已经结束。' };
  const piece = game.pieces.find(item => item.id === pieceId);
  if (!piece) return { ok: false, error: '没有找到要移动的棋子。' };
  if (piece.side !== game.turn) return { ok: false, error: `现在轮到${chineseSideName(game.turn)}行棋。` };
  if (!pseudoMoves(game.pieces, piece).some(move => move.x === to.x && move.y === to.y))
    return { ok: false, error: '这个位置不符合该棋子的走法。' };
  const nextPieces = applyMovePieces(game.pieces, piece, to);
  if (isChineseKingInCheck(nextPieces, piece.side))
    return { ok: false, error: '这步棋会让本方将帅处于被将军状态。' };

  const next = structuredClone(game);
  const captured = chinesePieceAt(next.pieces, to) ?? undefined;
  next.pieces = nextPieces;
  const record: ChineseMoveRecord = {
    number: next.history.length + 1,
    side: next.turn,
    pieceId,
    kind: piece.kind,
    from: { x: piece.x, y: piece.y },
    to: { x: to.x, y: to.y },
    ...(captured ? { captured } : {}),
  };
  next.history.push(record);
  next.lastMove = record;
  const opponent = otherChineseSide(next.turn);
  next.turn = opponent;
  if (allLegalChineseMoves(next, opponent).length === 0) {
    next.status = 'finished';
    next.winner = piece.side;
    next.endReason = isChineseKingInCheck(next.pieces, opponent) ? 'checkmate' : 'stalemate';
  }
  return { ok: true, game: next };
}

export function resignChineseGame(game: ChineseGame, side: ChineseSide): ChineseGame {
  if (game.status !== 'playing') return structuredClone(game);
  const next = structuredClone(game);
  next.status = 'finished';
  next.winner = otherChineseSide(side);
  next.endReason = 'resignation';
  return next;
}
