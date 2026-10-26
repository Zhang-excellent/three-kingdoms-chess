import type { Faction, Game, Point } from './game.ts';

export type RoomPhase = 'lobby' | 'playing' | 'finished';

export interface RoomPlayerView {
  id: string;
  nickname: string;
  faction: Faction | null;
  ready: boolean;
  online: boolean;
  offlineUntil: number | null;
}

export interface RoomView {
  code: string;
  phase: RoomPhase;
  version: number;
  players: RoomPlayerView[];
  game: Game | null;
  selfId: string;
}

export interface SessionReceipt {
  roomCode: string;
  playerId: string;
  reconnectToken: string;
  state: RoomView;
}

export interface MoveIntent {
  requestId: string;
  version: number;
  pieceId: string;
  to: Point;
}

export type ClientAck<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string; state?: RoomView };

export const ONLINE_SESSION_KEY = 'three-kingdoms-chess:online-session-v1';
export const PENDING_LEAVES_KEY = 'three-kingdoms-chess:pending-leaves-v1';
