import type { Faction, FactionResult, GameEvent, MoveRecord, Piece } from './game.ts';

export type GameEndReason = 'elimination' | 'resignation' | 'exit' | 'timeout' | 'agreement_draw';

export interface GameParticipant {
  playerId: string;
  userId: string | null;
  nickname: string;
  faction: Faction;
  result: FactionResult;
  eliminated: boolean;
}

export interface GameFinalState {
  status: 'finished';
  winner: Faction | null;
  results: Record<Faction, FactionResult>;
  eliminated: Faction[];
  turnBeforeEnd: Faction | null;
}

export interface ArchivedGameRecord {
  id: string;
  roomCode: string;
  round: number;
  startedAt: number;
  endedAt: number;
  rulesVersion: string;
  initialPieces: Piece[];
  participants: GameParticipant[];
  moves: MoveRecord[];
  events: GameEvent[];
  finalPieces: Piece[];
  finalState: GameFinalState;
  endReason: GameEndReason;
  moveCount: number;
}

export interface RecentGameSummary {
  id: string;
  roomCode: string;
  endedAt: number;
  faction: Faction;
  result: FactionResult;
  opponents: string[];
  moveCount: number;
  endReason: GameEndReason;
}
