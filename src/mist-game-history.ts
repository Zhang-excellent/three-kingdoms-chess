import {
  MIST_CHESS_RULES_VERSION,
  playMistMove,
  validMistGame,
} from './mist-chess.ts';
import type { MistGame } from './mist-chess.ts';
import type { ChineseMoveRecord, ChineseSide } from './chinese-chess.ts';

export type MistArchivedEndReason =
  | 'king-captured'
  | 'stalemate'
  | 'resignation'
  | 'draw'
  | 'exit'
  | 'timeout';

export interface ArchivedMistParticipant {
  playerId: string;
  userId: string | null;
  nickname: string;
  side: ChineseSide;
  result: 'won' | 'lost' | 'draw';
}

export interface ArchivedMistEvent {
  type: 'end';
  step: number;
  reason: MistArchivedEndReason;
  side?: ChineseSide;
  winner: ChineseSide | null;
}

export interface ArchivedMistGameRecord {
  gameType: 'mist-chess';
  id: string;
  roomCode: string;
  round: number;
  startedAt: number;
  endedAt: number;
  rulesVersion: typeof MIST_CHESS_RULES_VERSION;
  initialGame: MistGame;
  participants: ArchivedMistParticipant[];
  moves: ChineseMoveRecord[];
  events: ArchivedMistEvent[];
  finalGame: MistGame;
  endReason: MistArchivedEndReason;
  moveCount: number;
  winner: ChineseSide | null;
}

export interface RecentMistGameSummary {
  id: string;
  roomCode: string;
  endedAt: number;
  side: ChineseSide;
  result: 'won' | 'lost' | 'draw';
  opponents: string[];
  moveCount: number;
  endReason: MistArchivedEndReason;
}

export interface MistReplayDocument {
  record: ArchivedMistGameRecord;
  frames: MistGame[];
  moves: ChineseMoveRecord[];
}

export type MistReplayResult =
  | { ok: true; replay: MistReplayDocument }
  | { ok: false; error: string };

const signature = (game: MistGame): string =>
  game.pieces.map(piece => `${piece.side}:${piece.kind}:${piece.x},${piece.y}`).sort().join('|');

export function replayArchivedMistGame(record: ArchivedMistGameRecord): MistReplayResult {
  try {
    if (record.gameType !== 'mist-chess' || record.rulesVersion !== MIST_CHESS_RULES_VERSION)
      throw new Error('迷雾象棋棋谱的玩法或规则版本不受支持。');
    if (!validMistGame(record.initialGame) || !validMistGame(record.finalGame))
      throw new Error('迷雾象棋棋谱的初始或最终局面无效。');
    if (record.finalGame.status !== 'finished') throw new Error('棋谱没有记录正式终局。');
    if (record.moveCount !== record.moves.length) throw new Error('棋谱步数与行棋记录数量不一致。');

    let game = structuredClone(record.initialGame);
    const frames: MistGame[] = [structuredClone(game)];
    for (const [index, move] of record.moves.entries()) {
      if (game.status !== 'playing') throw new Error(`第 ${index + 1} 步之前对局已经结束。`);
      if (game.turn !== move.side) throw new Error(`第 ${index + 1} 步行动方与回放轮次不一致。`);
      const piece = game.pieces.find(item => item.id === move.pieceId);
      if (!piece) throw new Error(`第 ${index + 1} 步起点棋子不存在。`);
      if (piece.side !== move.side || piece.kind !== move.kind)
        throw new Error(`第 ${index + 1} 步记录棋子与回放起点不一致。`);
      const captured = game.pieces.find(item => item.x === move.to.x && item.y === move.to.y) ?? null;
      if (!!captured !== !!move.captured
        || (captured && move.captured && (captured.id !== move.captured.id || captured.side !== move.captured.side
          || captured.kind !== move.captured.kind)))
        throw new Error(`第 ${index + 1} 步吃子记录与回放局面不一致。`);
      const result = playMistMove(game, move.pieceId, move.to);
      if (!result.ok) throw new Error(`第 ${index + 1} 步无法按迷雾象棋规则复原。`);
      game = result.game;
      frames.push(structuredClone(game));
    }

    if (signature(game) !== signature(record.finalGame))
      throw new Error('行棋记录还原的最终盘面与保存的最终局面不一致。');
    const finalFrame = frames.at(-1)!;
    finalFrame.status = record.finalGame.status;
    finalFrame.winner = record.finalGame.winner;
    finalFrame.endReason = record.finalGame.endReason;
    finalFrame.lastMove = structuredClone(record.finalGame.lastMove);
    frames[frames.length - 1] = finalFrame;
    return { ok: true, replay: { record: structuredClone(record), frames, moves: structuredClone(record.moves) } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '迷雾象棋棋谱无法复盘。' };
  }
}
