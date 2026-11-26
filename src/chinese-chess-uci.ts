import {
  CHINESE_CHESS_RULES_VERSION,
  chinesePieceAt,
  newChineseGame,
} from './chinese-chess.ts';
import type {
  ChineseGame,
  ChineseKind,
  ChinesePiece,
  ChinesePoint,
} from './chinese-chess.ts';

const FEN_SYMBOLS: Record<ChineseKind, string> = {
  king: 'k',
  advisor: 'a',
  elephant: 'b',
  horse: 'n',
  rook: 'r',
  cannon: 'c',
  pawn: 'p',
};

export const CHINESE_INITIAL_FEN =
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

export function chineseFenFromPieces(pieces: readonly ChinesePiece[]): string {
  const ranks: string[] = [];
  for (let y = 0; y < 10; y++) {
    let rank = '', empty = 0;
    for (let x = 0; x < 9; x++) {
      const piece = chinesePieceAt(pieces, { x, y });
      if (!piece) {
        empty++;
        continue;
      }
      if (empty) {
        rank += String(empty);
        empty = 0;
      }
      const symbol = FEN_SYMBOLS[piece.kind];
      rank += piece.side === 'red' ? symbol.toUpperCase() : symbol;
    }
    if (empty) rank += String(empty);
    ranks.push(rank);
  }
  return `${ranks.join('/')} w - - 0 1`;
}

export function initialChineseFen(): string {
  const fen = chineseFenFromPieces(newChineseGame().pieces);
  if (fen !== CHINESE_INITIAL_FEN)
    throw new Error(`中国象棋初始 FEN 与规则版本 ${CHINESE_CHESS_RULES_VERSION} 不一致。`);
  return fen;
}

export function chinesePointToUci(point: ChinesePoint): string {
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y)
    || point.x < 0 || point.x > 8 || point.y < 0 || point.y > 9)
    throw new Error('中国象棋坐标超出 UCI 棋盘范围。');
  return `${String.fromCharCode(97 + point.x)}${9 - point.y}`;
}

export function uciPointToChinese(value: string): ChinesePoint {
  const match = /^([a-i])([0-9])$/.exec(value);
  if (!match) throw new Error(`无效的中国象棋 UCI 坐标：${value}`);
  return { x: match[1].charCodeAt(0) - 97, y: 9 - Number(match[2]) };
}

export function chineseMoveToUci(move: { from: ChinesePoint; to: ChinesePoint }): string {
  return `${chinesePointToUci(move.from)}${chinesePointToUci(move.to)}`;
}

export function uciMoveToChinese(value: string): { from: ChinesePoint; to: ChinesePoint } {
  const coordinate = value.trim().toLowerCase();
  const match = /^([a-i][0-9])([a-i][0-9])$/.exec(coordinate);
  if (!match) throw new Error(`无效的中国象棋 UCI 走法：${value}`);
  return { from: uciPointToChinese(match[1]), to: uciPointToChinese(match[2]) };
}

export function chineseUciHistory(game: Pick<ChineseGame, 'history'>): string[] {
  return game.history.map(chineseMoveToUci);
}

export function chinesePositionCommand(initialFen: string, moves: readonly string[]): string {
  return `position fen ${initialFen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`;
}

export function parseUciBestMove(value: string): { from: ChinesePoint; to: ChinesePoint } | null {
  const normalized = value.trim().replace(/^bestmove\s+/i, '');
  const token = normalized.split(/\s+/)[0]?.toLowerCase();
  if (!token || token === '(none)' || token === '0000') return null;
  return uciMoveToChinese(token);
}
