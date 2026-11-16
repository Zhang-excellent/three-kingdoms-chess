import {
  ORDER,
  PLAYERS,
  at,
  drawGame,
  legalMoves,
  moveError,
  newGame,
  playMove,
} from './game.ts';
import type { Faction, Game, Kind, Piece, Point } from './game.ts';

export type SimulationEndReason = 'winner' | 'draw' | 'move-limit';

export interface SimulationPolicy {
  name: string;
  coalition: number;
  randomness: number;
  caoExchangeBias: number;
  maxPlies: number;
}

export interface SimulationResult {
  winner: Faction | null;
  eliminated: Faction[];
  firstEliminated: Faction | null;
  moves: number;
  endReason: SimulationEndReason;
  scores: Record<Faction, number>;
}

export interface SimulationSummary {
  games: number;
  wins: Record<Faction, number>;
  winRate: Record<Faction, number>;
  draws: number;
  drawRate: number;
  moveLimitDraws: number;
  averageMoves: number;
  medianMoves: number;
  averageScore: Record<Faction, number>;
  scoreRate: Record<Faction, number>;
  firstEliminated: Record<Faction, number>;
  firstEliminationRate: Record<Faction, number>;
}

interface Candidate {
  piece: Piece;
  to: Point;
  captured: Piece | null;
  pieces: Piece[];
}

const PIECE_VALUES: Record<Kind, number> = {
  king: 100_000,
  rook: 900,
  cannon: 480,
  horse: 340,
  feng: 300,
  elephant: 190,
  advisor: 190,
  pawn: 100,
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const otherCoalition = (faction: Faction): Faction => faction === 'shu' ? 'wu' : 'shu';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function preview(game: Game, piece: Piece, to: Point): Candidate {
  const captured = at(game.pieces, to) ?? null;
  const pieces = game.pieces
    .filter(item => !captured || (item.id !== captured.id && !(captured.kind === 'king' && item.faction === captured.faction)))
    .map(item => item.id === piece.id ? { ...item, x: to.x, y: to.y } : item);
  return { piece, to, captured, pieces };
}

function candidates(game: Game): Candidate[] {
  if (!game.turn) return [];
  return game.pieces
    .filter(piece => piece.faction === game.turn)
    .flatMap(piece => legalMoves(game.pieces, piece).map(to => preview(game, piece, to)));
}

function material(pieces: readonly Piece[], faction: Faction): number {
  return pieces.filter(piece => piece.faction === faction)
    .reduce((total, piece) => total + PIECE_VALUES[piece.kind], 0);
}

function positional(piece: Piece): number {
  const center = 4 - Math.abs(piece.x - 4);
  const forward = piece.faction === 'wei' ? 9 - piece.y : piece.y;
  let score = center * 1.5;
  if (piece.kind === 'pawn' || piece.kind === 'feng') score += forward * 4;
  if (piece.kind === 'rook') score += forward * 2 + center * 3;
  if (piece.kind === 'cannon') {
    const targetFile = piece.faction === 'wei' ? [2, 6] : [4];
    if (targetFile.includes(piece.x)) score += 50;
    score += forward * 2;
  }
  if (piece.kind === 'horse') {
    if (piece.faction === 'wei' && piece.y < 8) score += 28;
    if (piece.faction !== 'wei' && piece.y > 1) score += 28;
  }
  if (piece.kind === 'king') {
    const home = piece.faction === 'wei' ? 9 : 0;
    score -= Math.abs(piece.y - home) * 9;
  }
  return score;
}

function positionScore(pieces: readonly Piece[], faction: Faction): number {
  return pieces.filter(piece => piece.faction === faction)
    .reduce((total, piece) => total + positional(piece), 0);
}

function kingOf(pieces: readonly Piece[], faction: Faction): Piece | null {
  return pieces.find(piece => piece.faction === faction && piece.kind === 'king') ?? null;
}

function canAttack(pieces: readonly Piece[], faction: Faction, target: Point): boolean {
  return pieces.some(piece => piece.faction === faction && moveError(pieces as Piece[], piece, target) === null);
}

function attackedBy(pieces: readonly Piece[], target: Point, factions: readonly Faction[]): boolean {
  return factions.some(faction => canAttack(pieces, faction, target));
}

function evaluateForActor(game: Game, candidate: Candidate, policy: SimulationPolicy): number {
  const actor = candidate.piece.faction;
  const active = ORDER.filter(faction => !game.eliminated.includes(faction));
  if (candidate.captured?.kind === 'king') {
    if (actor === 'wei' || candidate.captured.faction === 'wei' || game.eliminated.includes('wei')) return 10_000_000;
    const cohesion = clamp01(policy.coalition);
    const partnerAdvantage = material(candidate.pieces, actor) - material(candidate.pieces, 'wei');
    return 3_200 + partnerAdvantage * 0.8 - cohesion * 4_200;
  }

  let score = positionScore(candidate.pieces, actor);
  const ownMaterial = material(candidate.pieces, actor);
  if (actor === 'wei') {
    const shu = material(candidate.pieces, 'shu');
    const wu = material(candidate.pieces, 'wu');
    score += ownMaterial - shu * 0.58 - wu * 0.58;
    score += Math.max(0, ownMaterial - Math.max(shu, wu)) * policy.caoExchangeBias * 0.12;
    score += Math.max(0, ownMaterial - Math.min(shu, wu)) * policy.caoExchangeBias * 0.05;
    for (const enemy of ['shu', 'wu'] as const) {
      const king = kingOf(candidate.pieces, enemy);
      if (king) {
        if (canAttack(candidate.pieces, actor, king)) score += 260;
        const distance = Math.abs(candidate.to.x - king.x) + Math.abs(candidate.to.y - king.y);
        if ([2, 6].includes(king.x)) score += Math.max(0, 10 - distance) * 7;
      }
    }
  } else {
    const partner = otherCoalition(actor);
    const cohesion = clamp01(policy.coalition);
    const partnerMaterial = material(candidate.pieces, partner);
    const weiMaterial = material(candidate.pieces, 'wei');
    score += ownMaterial + partnerMaterial * cohesion * 0.44 - weiMaterial * (0.82 + cohesion * 0.62);
    const weiKing = kingOf(candidate.pieces, 'wei');
    if (weiKing && canAttack(candidate.pieces, actor, weiKing)) score += 210 + cohesion * 180;
    if (candidate.captured) {
      if (candidate.captured.faction === 'wei') score += PIECE_VALUES[candidate.captured.kind] * (0.5 + cohesion * 0.6);
      else {
        score -= PIECE_VALUES[candidate.captured.kind] * (0.65 + cohesion * 2.9);
      }
    }
    if (game.eliminated.includes('wei')) {
      score += ownMaterial - material(candidate.pieces, partner);
    }
  }

  const ownKing = kingOf(candidate.pieces, actor);
  if (ownKing) {
    const weiAlive = !game.eliminated.includes('wei');
    const enemySides = active.filter(faction => faction !== actor
      && !(actor !== 'wei' && weiAlive && faction === otherCoalition(actor)));
    if (attackedBy(candidate.pieces, { x: ownKing.x, y: ownKing.y }, enemySides)) score -= 1_250;
    if (candidate.piece.kind === 'king' && game.history.length < 30) score -= 260;
    if (candidate.piece.kind === 'king' && attackedBy(candidate.pieces, candidate.to, enemySides)) score -= 820;
  }

  if (candidate.captured) {
    score += PIECE_VALUES[candidate.captured.kind] * (actor === 'wei' ? 1.08 : 0.75);
  }
  if (attackedBy(candidate.pieces, candidate.to, active.filter(faction => faction !== actor)))
    score -= Math.round(PIECE_VALUES[candidate.piece.kind] * 0.18);
  if (game.history.length > policy.maxPlies * 0.72) score += positional(candidate.piece) + 30;
  return score;
}

function chooseCandidate(candidatesToScore: Candidate[], game: Game, policy: SimulationPolicy, random: () => number): Candidate {
  if (candidatesToScore.length === 1) return candidatesToScore[0];
  const scored = candidatesToScore.map(candidate => ({
    candidate,
    score: evaluateForActor(game, candidate, policy)
      + (random() - 0.5) * policy.randomness,
  })).sort((left, right) => right.score - left.score);
  const top = scored.slice(0, Math.min(4, scored.length));
  const best = top[0].score;
  const weights = top.map(item => Math.exp((item.score - best) / 95));
  let roll = random() * weights.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < top.length; index++) {
    roll -= weights[index];
    if (roll <= 0) return top[index].candidate;
  }
  return top[0].candidate;
}

function scoreResult(game: Game, endReason: SimulationEndReason): Record<Faction, number> {
  if (endReason === 'winner' && game.winner) {
    return {
      wei: game.winner === 'wei' ? 4 : 0,
      shu: game.winner === 'shu' ? 4 : 0,
      wu: game.winner === 'wu' ? 4 : 0,
    };
  }
  if (game.eliminated.length === 1) {
    const eliminated = game.eliminated[0];
    return {
      wei: eliminated === 'wei' ? 0 : 2,
      shu: eliminated === 'shu' ? 0 : 2,
      wu: eliminated === 'wu' ? 0 : 2,
    };
  }
  return { wei: 2, shu: 1, wu: 1 };
}

export function simulateGame(policy: SimulationPolicy, seed: number): SimulationResult {
  const random = seededRandom(seed);
  let game = newGame(), endReason: SimulationEndReason = 'move-limit';
  const maxPlies = Math.max(30, policy.maxPlies);
  while (game.status === 'playing' && game.history.length < maxPlies) {
    const available = candidates(game);
    if (!available.length) break;
    const chosen = chooseCandidate(available, game, policy, random);
    const result = playMove(game, chosen.piece.id, chosen.to);
    if (!result.ok) throw new Error(`Simulation generated an illegal move: ${result.error}`);
    game = result.game;
  }
  if (game.status === 'finished') endReason = game.winner ? 'winner' : 'draw';
  else {
    const drawn = drawGame(game);
    if (!drawn.ok) throw new Error(`Unable to finish move-limit game: ${drawn.error}`);
    game = drawn.game;
    endReason = 'move-limit';
  }
  const firstEliminated = game.history
    .flatMap(record => record.eliminated)
    .find((faction, index, all) => all.indexOf(faction) === index) ?? game.eliminated[0] ?? null;
  return {
    winner: game.winner,
    eliminated: [...game.eliminated],
    firstEliminated,
    moves: game.history.length,
    endReason,
    scores: scoreResult(game, endReason),
  };
}

export function summarizeSimulation(results: readonly SimulationResult[]): SimulationSummary {
  const emptyCounts = (): Record<Faction, number> => ({ wei: 0, shu: 0, wu: 0 });
  const emptyScores = emptyCounts;
  const wins = emptyCounts(), firstEliminated = emptyCounts(), totalScores = emptyScores();
  let draws = 0, moveLimitDraws = 0;
  const moveCounts: number[] = [];
  for (const result of results) {
    if (result.winner) wins[result.winner]++;
    else draws++;
    if (result.endReason === 'move-limit') moveLimitDraws++;
    if (result.firstEliminated) firstEliminated[result.firstEliminated]++;
    for (const faction of ORDER) totalScores[faction] += result.scores[faction];
    moveCounts.push(result.moves);
  }
  const games = results.length;
  const rate = (value: number) => games ? value / games : 0;
  moveCounts.sort((left, right) => left - right);
  const median = moveCounts.length === 0 ? 0
    : moveCounts.length % 2 ? moveCounts[(moveCounts.length - 1) / 2]
      : (moveCounts[moveCounts.length / 2 - 1] + moveCounts[moveCounts.length / 2]) / 2;
  return {
    games,
    wins,
    winRate: { wei: rate(wins.wei), shu: rate(wins.shu), wu: rate(wins.wu) },
    draws,
    drawRate: rate(draws),
    moveLimitDraws,
    averageMoves: games ? moveCounts.reduce((sum, value) => sum + value, 0) / games : 0,
    medianMoves: median,
    averageScore: {
      wei: games ? totalScores.wei / games : 0,
      shu: games ? totalScores.shu / games : 0,
      wu: games ? totalScores.wu / games : 0,
    },
    scoreRate: {
      wei: games ? totalScores.wei / games / 4 : 0,
      shu: games ? totalScores.shu / games / 4 : 0,
      wu: games ? totalScores.wu / games / 4 : 0,
    },
    firstEliminated,
    firstEliminationRate: {
      wei: rate(firstEliminated.wei),
      shu: rate(firstEliminated.shu),
      wu: rate(firstEliminated.wu),
    },
  };
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function factionName(faction: Faction): string {
  return `${PLAYERS[faction].name}（${PLAYERS[faction].nation}）`;
}
