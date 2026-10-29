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

export type DrawVote = 'accept' | 'reject';

export interface DrawOfferView {
  id: string;
  proposer: Faction;
  eligible: Faction[];
  votes: Partial<Record<Faction, DrawVote>>;
}

export interface RoomView {
  code: string;
  phase: RoomPhase;
  version: number;
  round: number;
  players: RoomPlayerView[];
  game: Game | null;
  drawOffer: DrawOfferView | null;
  selfId: string | null;
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

/** getRandomValues works on the site's HTTP IP address; randomUUID requires a secure context. */
export function createMoveRequestId(source: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
  const random = new Uint32Array(4);
  source.getRandomValues(random);
  return `move-${Array.from(random, value => value.toString(36)).join('-')}`;
}
