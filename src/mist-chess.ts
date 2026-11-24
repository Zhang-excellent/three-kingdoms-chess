import {
  applyChineseMovePieces,
  chineseMovesIgnoringCheck,
  chinesePieceAt,
  newChineseGame,
} from './chinese-chess.ts';
import type {
  ChineseKind,
  ChineseMoveRecord,
  ChinesePiece,
  ChinesePoint,
  ChineseSide,
} from './chinese-chess.ts';

export const MIST_CHESS_RULES_VERSION = 'mist-chinese-chess-v1';
export const MIST_CHESS_GAME_ID = 'mist-chess';
export const MIST_CHESS_SESSION_KEY = 'three-kingdoms-chess:mist-chess-session-v1';
export const MIST_BOARD_CELLS: readonly ChinesePoint[] = Array.from(
  { length: 90 },
  (_, index) => ({ x: index % 9, y: Math.floor(index / 9) }),
);

export type MistPhase = 'lobby' | 'playing' | 'finished';
export type MistEndReason = 'king-captured' | 'stalemate' | 'resignation' | 'draw' | null;

export interface MistGame {
  schema: 1;
  rulesVersion: typeof MIST_CHESS_RULES_VERSION;
  pieces: ChinesePiece[];
  turn: ChineseSide;
  status: 'playing' | 'finished';
  winner: ChineseSide | null;
  endReason: MistEndReason;
  lastMove: ChineseMoveRecord | null;
  history: ChineseMoveRecord[];
}

export interface MistLegalMove {
  pieceId: string;
  to: ChinesePoint;
}

export interface MistGameView {
  schema: 1;
  rulesVersion: typeof MIST_CHESS_RULES_VERSION;
  pieces: ChinesePiece[];
  turn: ChineseSide;
  status: 'playing' | 'finished';
  winner: ChineseSide | null;
  endReason: MistEndReason;
  lastMove: ChineseMoveRecord | null;
  history: ChineseMoveRecord[];
  visibleCells: ChinesePoint[];
  legalMoves: MistLegalMove[];
  moveCount: number;
  lostKinds: ChineseKind[];
  fullBoardVisible: boolean;
}

export interface MistPlayerView {
  id: string;
  nickname: string;
  avatar: string | null;
  identity: 'account' | 'guest';
  side: ChineseSide;
  ready: boolean;
  online: boolean;
  offlineUntil: number | null;
}

export interface MistState {
  gameId: typeof MIST_CHESS_GAME_ID;
  phase: MistPhase;
  version: number;
  round: number;
  players: MistPlayerView[];
  game: MistGameView | null;
  drawOfferBy: ChineseSide | null;
  selfId: string | null;
  selfSide: ChineseSide | null;
}

export interface MistReceipt {
  gameId: typeof MIST_CHESS_GAME_ID;
  playerId: string;
  reconnectToken: string;
  state: MistState;
}

export interface MistMoveIntent {
  requestId: string;
  version: number;
  pieceId: string;
  to: ChinesePoint;
}

export type MistAck<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string; state?: MistState };

const pointKey = (point: ChinesePoint): string => `${point.x},${point.y}`;
const clonePoints = (points: Iterable<ChinesePoint>): ChinesePoint[] =>
  Array.from(points, point => ({ x: point.x, y: point.y }));

export function newMistGame(): MistGame {
  const classic = newChineseGame();
  return {
    schema: 1,
    rulesVersion: MIST_CHESS_RULES_VERSION,
    pieces: structuredClone(classic.pieces),
    turn: 'red',
    status: 'playing',
    winner: null,
    endReason: null,
    lastMove: null,
    history: [],
  };
}

export function otherMistSide(side: ChineseSide): ChineseSide {
  return side === 'red' ? 'black' : 'red';
}

export function mistMoveForbidden(
  game: Pick<MistGame, 'turn' | 'history'>,
  piece: Pick<ChinesePiece, 'side' | 'kind'>,
): boolean {
  return game.history.length === 0 && game.turn === 'red' && piece.side === 'red' && piece.kind === 'cannon';
}

export function allMistMoves(
  game: Pick<MistGame, 'pieces' | 'turn' | 'history'>,
  side: ChineseSide,
): MistLegalMove[] {
  return game.pieces
    .filter(piece => piece.side === side && !mistMoveForbidden(game, piece))
    .flatMap(piece => chineseMovesIgnoringCheck(game.pieces, piece)
      .map(to => ({ pieceId: piece.id, to: { x: to.x, y: to.y } })));
}

export function mistVisibleCells(game: Pick<MistGame, 'pieces' | 'status' | 'turn' | 'history'>, side: ChineseSide): ChinesePoint[] {
  if (game.status === 'finished') return clonePoints(MIST_BOARD_CELLS);
  const visible = new Set<string>();
  for (const piece of game.pieces) {
    if (piece.side !== side) continue;
    visible.add(pointKey(piece));
    if (!mistMoveForbidden(game, piece)) {
      for (const move of chineseMovesIgnoringCheck(game.pieces, piece)) visible.add(pointKey(move));
    }
  }
  return Array.from(visible, key => {
    const [x, y] = key.split(',').map(Number);
    return { x, y };
  });
}

function visibleRecord(record: ChineseMoveRecord | null): ChineseMoveRecord | null {
  return record ? structuredClone(record) : null;
}

export function projectMistGame(game: MistGame, side: ChineseSide): MistGameView {
  const fullBoardVisible = game.status === 'finished';
  const visibleCells = mistVisibleCells(game, side);
  const visible = new Set(visibleCells.map(pointKey));
  const pieces = fullBoardVisible
    ? structuredClone(game.pieces)
    : structuredClone(game.pieces.filter(piece => piece.side === side || visible.has(pointKey(piece))));
  const legalMoves = allMistMoves(game, side);
  const history = fullBoardVisible
    ? structuredClone(game.history)
    : structuredClone(game.history.filter(record => record.side === side));
  const lastMove = fullBoardVisible
    ? visibleRecord(game.lastMove)
    : game.lastMove?.side === side ? visibleRecord(game.lastMove) : null;
  const lostKinds = game.history
    .flatMap(record => record.captured?.side === side ? [record.captured.kind] : []);
  return {
    schema: 1,
    rulesVersion: MIST_CHESS_RULES_VERSION,
    pieces,
    turn: game.turn,
    status: game.status,
    winner: game.winner,
    endReason: game.endReason,
    lastMove,
    history,
    visibleCells,
    legalMoves,
    moveCount: game.history.length,
    lostKinds,
    fullBoardVisible,
  };
}

export function spectatorMistGame(game: MistGame): MistGameView {
  return {
    schema: 1,
    rulesVersion: MIST_CHESS_RULES_VERSION,
    pieces: structuredClone(game.pieces),
    turn: game.turn,
    status: game.status,
    winner: game.winner,
    endReason: game.endReason,
    lastMove: visibleRecord(game.lastMove),
    history: structuredClone(game.history),
    visibleCells: clonePoints(MIST_BOARD_CELLS),
    legalMoves: [],
    moveCount: game.history.length,
    lostKinds: game.history.flatMap(record => record.captured ? [record.captured.kind] : []),
    fullBoardVisible: true,
  };
}

export function playMistMove(game: MistGame, pieceId: string, to: ChinesePoint):
  { ok: true; game: MistGame } | { ok: false } {
  if (game.status !== 'playing') return { ok: false };
  const piece = game.pieces.find(item => item.id === pieceId);
  if (!piece || piece.side !== game.turn) return { ok: false };
  if (mistMoveForbidden(game, piece)) return { ok: false };
  if (!chineseMovesIgnoringCheck(game.pieces, piece).some(move => move.x === to.x && move.y === to.y))
    return { ok: false };

  const next = structuredClone(game);
  const captured = chinesePieceAt(next.pieces, to) ?? undefined;
  next.pieces = applyChineseMovePieces(next.pieces, piece, to);
  const record: ChineseMoveRecord = {
    number: next.history.length + 1,
    side: next.turn,
    pieceId,
    kind: piece.kind,
    from: { x: piece.x, y: piece.y },
    to: { x: to.x, y: to.y },
    ...(captured ? { captured: structuredClone(captured) } : {}),
  };
  next.history.push(record);
  next.lastMove = record;

  if (captured?.kind === 'king' && captured.side !== piece.side) {
    next.status = 'finished';
    next.winner = piece.side;
    next.endReason = 'king-captured';
    return { ok: true, game: next };
  }

  const opponent = otherMistSide(piece.side);
  next.turn = opponent;
  if (allMistMoves(next, opponent).length === 0) {
    next.status = 'finished';
    next.winner = piece.side;
    next.endReason = 'stalemate';
  }
  return { ok: true, game: next };
}

export function resignMistGame(game: MistGame, side: ChineseSide): MistGame {
  if (game.status !== 'playing') return structuredClone(game);
  const next = structuredClone(game);
  next.status = 'finished';
  next.winner = otherMistSide(side);
  next.endReason = 'resignation';
  return next;
}

export function drawMistGame(game: MistGame): MistGame {
  if (game.status !== 'playing') return structuredClone(game);
  const next = structuredClone(game);
  next.status = 'finished';
  next.winner = null;
  next.endReason = 'draw';
  return next;
}

export function validMistGame(value: unknown): value is MistGame {
  if (!value || typeof value !== 'object') return false;
  const game = value as MistGame;
  if (game.schema !== 1 || game.rulesVersion !== MIST_CHESS_RULES_VERSION
    || (game.turn !== 'red' && game.turn !== 'black')
    || (game.status !== 'playing' && game.status !== 'finished')
    || (game.winner !== null && game.winner !== 'red' && game.winner !== 'black')
    || !['king-captured', 'stalemate', 'resignation', 'draw', null].includes(game.endReason)
    || !Array.isArray(game.pieces) || !Array.isArray(game.history)) return false;
  const ids = new Set<string>(), occupied = new Set<string>();
  for (const piece of game.pieces) {
    if (!piece || typeof piece.id !== 'string'
      || (piece.side !== 'red' && piece.side !== 'black')
      || !['king', 'advisor', 'elephant', 'horse', 'rook', 'cannon', 'pawn'].includes(piece.kind)
      || !Number.isInteger(piece.x) || !Number.isInteger(piece.y)
      || piece.x < 0 || piece.x > 8 || piece.y < 0 || piece.y > 9) return false;
    const key = pointKey(piece);
    if (ids.has(piece.id) || occupied.has(key)) return false;
    ids.add(piece.id);
    occupied.add(key);
  }
  if (game.status === 'playing') return game.winner === null && game.endReason === null;
  if (game.endReason === 'draw') return game.winner === null;
  return game.winner !== null && game.endReason !== null;
}
