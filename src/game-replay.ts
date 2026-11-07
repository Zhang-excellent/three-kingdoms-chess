import { ORDER, PLAYERS, TURN_CYCLE, at, inside, moveError, pieceName } from './game.ts';
import type { Faction, Game, GameEvent, Kind, MoveRecord, Piece, Point, TurnSlot } from './game.ts';

export const REPLAY_FORMAT = 'three-kingdoms-chess-record';
export const REPLAY_FORMAT_VERSION = 1;

const KNOWN_LAYOUTS: Record<string, Record<Faction, number>> = {
  'independent-win-loss-draw-v1': { wei: 16, shu: 7, wu: 6 },
  'independent-win-loss-draw-layout-v2': { wei: 16, shu: 6, wu: 7 },
  'independent-win-loss-draw-mirrored-layout-v3': { wei: 16, shu: 6, wu: 7 },
};
const KINDS: Kind[] = ['king', 'rook', 'horse', 'elephant', 'advisor', 'cannon', 'pawn', 'feng'];
const NATION_TO_FACTION: Record<string, Faction> = { 魏: 'wei', 蜀: 'shu', 吴: 'wu' };
const NAME_TO_FACTION: Record<string, Faction> = { 曹操: 'wei', 刘备: 'shu', 孙权: 'wu' };
const TOKEN_KINDS: Record<string, Kind> = {
  车: 'rook', 马: 'horse', 相: 'elephant', 象: 'elephant', 仕: 'advisor', 士: 'advisor',
  炮: 'cannon', 兵: 'pawn', 卒: 'pawn', 锋: 'feng',
};

export type ReplayEvent = GameEvent;

export interface ReplayWarning {
  message: string;
  details: string[];
}

export interface ReplayDocument {
  source: 'structured' | 'legacy';
  formatVersion: number | null;
  rulesVersion: string;
  declaredResult: string;
  declaredWinner: Faction | null;
  moves: MoveRecord[];
  frames: Game[];
  events: ReplayEvent[];
  warnings: ReplayWarning[];
  initialCounts: Record<Faction, number>;
  reconstructedCounts: Record<Faction, number>;
  declaredFinalCounts: Record<Faction, number> | null;
}

export type ReplayParseResult =
  | { ok: true; replay: ReplayDocument }
  | { ok: false; error: string; details?: string[] };

interface RawMove {
  number: number;
  faction: Faction;
  turnSlot?: TurnSlot;
  kind: Kind;
  pieceId?: string;
  from: Point;
  to: Point;
  captured: Piece | null;
  declaredCapture: { faction: Faction; kind: Kind } | null;
  eliminated: Faction[];
}

const counts = (pieces: readonly Piece[]): Record<Faction, number> => ({
  wei: pieces.filter(piece => piece.faction === 'wei').length,
  shu: pieces.filter(piece => piece.faction === 'shu').length,
  wu: pieces.filter(piece => piece.faction === 'wu').length,
});
const countText = (value: Record<Faction, number>) => `魏${value.wei}、蜀${value.shu}、吴${value.wu}`;
const resultText = (results: Record<Faction, string>) =>
  ORDER.map(faction => `${PLAYERS[faction].name}${results[faction] === 'won' ? '胜利' : results[faction] === 'lost' ? '失败' : results[faction] === 'draw' ? '和棋' : '对局中'}`).join('；');
const section = (source: string, title: string): string | null => {
  const match = source.match(new RegExp(`(?:^|\\n)## ${title}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match?.[1]?.trim() ?? null;
};
const displayPoint = (x: number, y: number): Point => ({ x: x - 1, y: y - 1 });
const validPoint = (point: Point) => inside(point);
const clone = <T>(value: T): T => structuredClone(value);

function validRuleVersion(value: string): value is keyof typeof KNOWN_LAYOUTS {
  return Object.hasOwn(KNOWN_LAYOUTS, value);
}

function kindForToken(token: string): Kind | null {
  if (token === '曹操' || token === '刘备' || token === '孙权') return 'king';
  return TOKEN_KINDS[token] ?? null;
}

function parseInitialRows(source: string | null): { pieces: Piece[]; declaredCounts: Record<Faction, number> } {
  if (!source) throw new Error('缺少初始子力段落。');
  const pieces: Piece[] = [];
  const declaredCounts: Record<Faction, number> = { wei: 0, shu: 0, wu: 0 };
  const seen = new Set<Faction>();
  const rowPattern = /^- (魏|蜀|吴)方（(\d+) 枚）：(.*)$/gm;
  for (const match of source.matchAll(rowPattern)) {
    const faction = NATION_TO_FACTION[match[1]];
    if (!faction || seen.has(faction)) throw new Error(`初始子力中的${match[1]}方记录重复或无效。`);
    seen.add(faction);
    const expected = Number(match[2]);
    const body = match[3].trim();
    if (body === '无') {
      if (expected !== 0) throw new Error(`${match[1]}方声明 ${expected} 枚，但具体子力为“无”。`);
      continue;
    }
    const entries = body.split('、').map(item => item.trim()).filter(Boolean);
    if (entries.length !== expected) throw new Error(`${match[1]}方声明 ${expected} 枚，但列出了 ${entries.length} 枚。`);
    for (const entry of entries) {
      const item = entry.match(/^(魏|蜀|吴)方(曹操|刘备|孙权|车|马|相|象|仕|士|炮|兵|卒|锋) \((\d+), (\d+)\)$/);
      if (!item) throw new Error(`无法解析初始子力：${entry}`);
      if (NATION_TO_FACTION[item[1]] !== faction) throw new Error(`初始子力阵营不一致：${entry}`);
      const kind = kindForToken(item[2]);
      const point = displayPoint(Number(item[3]), Number(item[4]));
      if (!kind || !validPoint(point)) throw new Error(`初始子力坐标或棋种无效：${entry}`);
      pieces.push({ id: `${faction}-${kind}-${point.x}-${point.y}`, faction, kind, ...point });
    }
    declaredCounts[faction] = expected;
  }
  if (seen.size !== ORDER.length) throw new Error('初始子力必须包含魏、蜀、吴三方。');
  return { pieces, declaredCounts };
}

function validateInitial(pieces: Piece[], declaredCounts: Record<Faction, number>, rulesVersion: string): void {
  const expected = KNOWN_LAYOUTS[rulesVersion];
  for (const faction of ORDER) {
    if (declaredCounts[faction] !== expected[faction])
      throw new Error(`${PLAYERS[faction].nation}方初始应有 ${expected[faction]} 枚，文件记录为 ${declaredCounts[faction]} 枚。`);
    if (pieces.filter(piece => piece.faction === faction && piece.kind === 'king').length !== 1)
      throw new Error(`${PLAYERS[faction].nation}方初始必须且只能有一枚主公。`);
  }
  const ids = new Set<string>(), positions = new Set<string>();
  for (const piece of pieces) {
    const position = `${piece.x},${piece.y}`;
    if (!inside(piece) || !KINDS.includes(piece.kind) || !ORDER.includes(piece.faction))
      throw new Error(`初始棋子格式或坐标无效：${piece.faction} ${piece.kind} (${piece.x + 1}, ${piece.y + 1})`);
    if (ids.has(piece.id) || positions.has(position))
      throw new Error(`初始棋子重叠或编号重复：${pieceName(piece)} (${piece.x + 1}, ${piece.y + 1})`);
    ids.add(piece.id); positions.add(position);
  }
}

function parseLegacyMoveLines(source: string | null, total: number): RawMove[] {
  if (!source) throw new Error('缺少行棋记录段落。');
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== total) throw new Error(`文件声明总步数为 ${total}，实际找到 ${lines.length} 行行棋记录。`);
  return lines.map((line, index) => {
    const match = line.match(/^(\d+)\.\s+(曹操|刘备|孙权)\s+·\s+(.+?)\s+\((\d+),\s*(\d+)\)\s*→\s*\((\d+),\s*(\d+)\)(?:\s*；\s*(.*))?$/);
    if (!match) throw new Error(`第 ${index + 1} 行棋记录无法解析：${line}`);
    const number = Number(match[1]);
    if (number !== index + 1) throw new Error(`步号不连续：期望第 ${index + 1} 步，实际为第 ${number} 步。`);
    const faction = NAME_TO_FACTION[match[2]];
    const kind = kindForToken(match[3].trim());
    if (!faction || !kind) throw new Error(`第 ${number} 步的行动方或棋子无效。`);
    const from = displayPoint(Number(match[4]), Number(match[5]));
    const to = displayPoint(Number(match[6]), Number(match[7]));
    if (!validPoint(from) || !validPoint(to)) throw new Error(`第 ${number} 步坐标超出棋盘范围。`);
    const extra = match[8]?.trim() ?? '';
    const capturedMatch = extra.match(/吃掉(魏|蜀|吴)方(曹操|刘备|孙权|车|马|相|象|仕|士|炮|兵|卒|锋)/);
    const capturedFaction = capturedMatch ? NATION_TO_FACTION[capturedMatch[1]] : null;
    const capturedKind = capturedMatch ? kindForToken(capturedMatch[2]) : null;
    const eliminated: Faction[] = [];
    const eliminationPart = extra.match(/([^；]+?)出局/);
    if (eliminationPart) for (const name of eliminationPart[1].split('、')) {
      const eliminatedFaction = NAME_TO_FACTION[name.trim()];
      if (!eliminatedFaction) throw new Error(`第 ${number} 步的出局阵营无效：${name}`);
      eliminated.push(eliminatedFaction);
    }
    return { number, faction, kind, from, to, captured: null,
      declaredCapture: capturedFaction && capturedKind ? { faction: capturedFaction, kind: capturedKind } : null,
      eliminated };
  });
}

function parseStructuredPiece(value: unknown, index: number): Piece {
  if (!value || typeof value !== 'object') throw new Error(`结构化初始子力第 ${index + 1} 项格式无效。`);
  const piece = value as Partial<Piece>;
  if (typeof piece.id !== 'string' || !ORDER.includes(piece.faction as Faction) || !KINDS.includes(piece.kind as Kind)
    || !Number.isInteger(piece.x) || !Number.isInteger(piece.y) || !inside(piece as Point))
    throw new Error(`结构化子力第 ${index + 1} 项格式无效。`);
  return { id: piece.id, faction: piece.faction as Faction, kind: piece.kind as Kind, x: piece.x!, y: piece.y! };
}

function parseStructuredMoves(value: unknown, total: number): RawMove[] {
  if (!Array.isArray(value) || value.length !== total)
    throw new Error(`结构化数据声明总步数为 ${total}，实际包含 ${Array.isArray(value) ? value.length : 0} 步。`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`结构化第 ${index + 1} 步格式无效。`);
    const move = entry as Partial<MoveRecord>;
    if (move.number !== index + 1 || !ORDER.includes(move.faction as Faction) || !KINDS.includes(move.kind as Kind)
      || !move.from || !move.to || !inside(move.from) || !inside(move.to) || typeof move.pieceId !== 'string')
      throw new Error(`结构化第 ${index + 1} 步的步号、阵营、棋子或坐标无效。`);
    if (move.turnSlot !== undefined && (!Number.isInteger(move.turnSlot) || move.turnSlot < 0 || move.turnSlot >= TURN_CYCLE.length
      || TURN_CYCLE[move.turnSlot] !== move.faction))
      throw new Error(`结构化第 ${index + 1} 步的轮次位置与行动方不一致。`);
    const captured = move.captured == null ? null : parseStructuredPiece(move.captured, index);
    return {
      number: index + 1,
      faction: move.faction as Faction,
      turnSlot: Number.isInteger(move.turnSlot) && Number(move.turnSlot) >= 0 && Number(move.turnSlot) < TURN_CYCLE.length
        ? move.turnSlot as TurnSlot : undefined,
      kind: move.kind as Kind,
      pieceId: move.pieceId,
      from: { ...move.from },
      to: { ...move.to },
      captured,
      declaredCapture: captured ? { faction: captured.faction, kind: captured.kind } : null,
      eliminated: Array.isArray(move.eliminated) ? move.eliminated.filter((faction): faction is Faction => ORDER.includes(faction as Faction)) : [],
    };
  });
}

function nextTurn(faction: Faction, eliminated: readonly Faction[]): { faction: Faction; turnSlot: 0 | 1 | 2 } | null {
  const current = TURN_CYCLE.indexOf(faction);
  for (let offset = 1; offset <= TURN_CYCLE.length; offset++) {
    const index = (current + offset) % TURN_CYCLE.length;
    if (!eliminated.includes(TURN_CYCLE[index])) return { faction: TURN_CYCLE[index], turnSlot: index as 0 | 1 | 2 };
  }
  return null;
}

function finishIfNeeded(game: Game): void {
  if (game.eliminated.length !== 2) return;
  const winner = ORDER.find(faction => !game.eliminated.includes(faction))!;
  game.results[winner] = 'won';
  game.winner = winner; game.status = 'finished'; game.turn = null; game.turnSlot = null;
}

function applyEliminations(game: Game, factions: readonly Faction[]): Faction[] {
  const applied: Faction[] = [];
  for (const faction of factions) {
    if (game.eliminated.includes(faction)) continue;
    game.eliminated.push(faction);
    game.results[faction] = 'lost';
    game.pieces = game.pieces.filter(piece => piece.faction !== faction);
    applied.push(faction);
  }
  finishIfNeeded(game);
  return applied;
}

function settleInitialTurnAfterEvents(game: Game): void {
  if (game.status !== 'playing' || !game.turn || game.turnSlot === null) return;
  if (!game.eliminated.includes(game.turn)) return;
  const next = nextTurn(game.turn, game.eliminated);
  if (!next) throw new Error('出局事件后没有可继续行棋的存活阵营。');
  game.turn = next.faction; game.turnSlot = next.turnSlot;
}

function replayFrom(
  source: ReplayDocument['source'],
  formatVersion: number | null,
  rulesVersion: string,
  initialPieces: Piece[],
  declaredCounts: Record<Faction, number>,
  rawMoves: RawMove[],
  declaredResult: string,
  declaredWinner: Faction | null,
  declaredFinalPieces: Piece[] | null,
  events: ReplayEvent[],
  structuredFinalState?: { status?: unknown; winner?: unknown; results?: unknown; eliminated?: unknown; turnBeforeEnd?: unknown },
): ReplayDocument {
  validateInitial(initialPieces, declaredCounts, rulesVersion);
  let game: Game = {
    schema: 3, rulesVersion, pieces: clone(initialPieces), turn: 'wei', turnSlot: 0,
    turnBeforeEnd: null, events: [],
    eliminated: [], results: { wei: 'playing', shu: 'playing', wu: 'playing' },
    history: [], lastMove: null, winner: null, status: 'playing',
  };
  const frames = [clone(game)];
  const roundWarnings: string[] = [];
  let roundKnown = true;
  const eliminationEvents = events.filter(event => event.type === 'elimination' || event.type === 'resign');
  for (const event of eliminationEvents.filter(item => item.step === 0)) {
    applyEliminations(game, event.faction ? [event.faction] : event.factions ?? []);
  }
  settleInitialTurnAfterEvents(game);
  frames[0] = clone(game);
  for (const raw of rawMoves) {
    if (game.status !== 'playing') throw new Error(`第 ${raw.number} 步之前对局已经结束。`);
    let movedSlot: TurnSlot;
    if (roundKnown) {
      if (!game.turn || game.turnSlot === null) throw new Error(`第 ${raw.number} 步的待行棋方无法还原。`);
      if (game.turn !== raw.faction) {
        if (source === 'structured')
          throw new Error(`第 ${raw.number} 步记录为${PLAYERS[raw.faction].name}行棋，但按出局和轮次应为${PLAYERS[game.turn].name}行棋。`);
        roundKnown = false;
        roundWarnings.push(`第 ${raw.number} 步记录为${PLAYERS[raw.faction].name}行棋，但旧棋谱未记录此前可能发生的认输或其他非走棋事件，无法继续可靠还原轮次。`);
        movedSlot = ORDER.indexOf(raw.faction) as TurnSlot;
      } else {
        if (raw.turnSlot !== undefined && raw.turnSlot !== game.turnSlot)
          throw new Error(`第 ${raw.number} 步的轮次位置与行动方不一致。`);
        movedSlot = game.turnSlot;
      }
    } else {
      movedSlot = ORDER.indexOf(raw.faction) as TurnSlot;
    }
    const piece = at(game.pieces, raw.from);
    if (!piece) throw new Error(`第 ${raw.number} 步起点没有棋子。`);
    if (piece.faction !== raw.faction) throw new Error(`第 ${raw.number} 步记录为${PLAYERS[raw.faction].name}行棋，但起点棋子属于${PLAYERS[piece.faction].name}。`);
    if (piece.kind !== raw.kind) throw new Error(`第 ${raw.number} 步记录棋子为${pieceName(raw)}, 但起点实际是${pieceName(piece)}。`);
    if (raw.pieceId && raw.pieceId !== piece.id) throw new Error(`第 ${raw.number} 步的棋子编号与起点棋子不一致。`);
    const movementError = moveError(game.pieces, piece, raw.to);
    if (movementError) throw new Error(`第 ${raw.number} 步不合法：${movementError}`);
    const captured = at(game.pieces, raw.to) ?? null;
    if (captured && (!raw.declaredCapture || captured.faction !== raw.declaredCapture.faction || captured.kind !== raw.declaredCapture.kind))
      throw new Error(`第 ${raw.number} 步目标位置有${PLAYERS[captured.faction].nation}方${pieceName(captured)}，但行棋记录未准确标注吃子。`);
    if (!captured && raw.declaredCapture)
      throw new Error(`第 ${raw.number} 步声明吃掉棋子，但目标位置为空。`);

    game.pieces = game.pieces.filter(item => item.id !== captured?.id)
      .map(item => item.id === piece.id ? { ...item, ...raw.to } : item);
    const eliminated = [...raw.eliminated];
    if (captured?.kind === 'king' && !eliminated.includes(captured.faction)) eliminated.push(captured.faction);
    for (const event of eliminationEvents.filter(item => item.step === raw.number)) {
      const factions = event.faction ? [event.faction] : event.factions ?? [];
      for (const faction of factions) if (!eliminated.includes(faction)) eliminated.push(faction);
    }
    const applied = applyEliminations(game, eliminated);
    const record: MoveRecord = {
      number: raw.number, faction: raw.faction, turnSlot: movedSlot,
      pieceId: piece.id, kind: piece.kind, from: { ...raw.from }, to: { ...raw.to },
      captured: captured ? { ...captured } : null, eliminated: applied,
    };
    game.history.push(record); game.lastMove = record;
    if (game.status === 'playing') {
      if (roundKnown) {
        const next = nextTurn(TURN_CYCLE[movedSlot], game.eliminated);
        if (!next) throw new Error(`第 ${raw.number} 步后没有可继续行棋的存活阵营。`);
        game.turn = next.faction; game.turnSlot = next.turnSlot;
      } else {
        game.turn = null; game.turnSlot = null;
      }
    }
    frames.push(clone(game));
  }

  const finalEvent = events.find(event => event.type === 'result');
  const drawEvent = events.find(event => event.type === 'draw');
  const explicitTurnBeforeEnd = ORDER.includes(structuredFinalState?.turnBeforeEnd as Faction)
    ? structuredFinalState!.turnBeforeEnd as Faction
    : structuredFinalState?.turnBeforeEnd === null ? null : undefined;
  const endingTurn = explicitTurnBeforeEnd !== undefined ? explicitTurnBeforeEnd
    : game.status === 'playing' && game.turn ? game.turn : null;
  if (finalEvent) {
    game.results = finalEvent.results ? { ...finalEvent.results } : game.results;
    game.winner = finalEvent.winner ?? null;
    game.turnBeforeEnd = game.winner === null ? endingTurn : null;
    game.status = 'finished'; game.turn = null; game.turnSlot = null;
    frames[frames.length - 1] = clone(game);
  } else if (drawEvent) {
    for (const faction of ORDER.filter(item => !game.eliminated.includes(item))) game.results[faction] = 'draw';
    game.turnBeforeEnd = drawEvent.turnBeforeEnd ?? endingTurn;
    game.winner = null; game.status = 'finished'; game.turn = null; game.turnSlot = null;
    frames[frames.length - 1] = clone(game);
  } else if (source === 'structured' && structuredFinalState?.status === 'finished') {
    if (structuredFinalState.results && typeof structuredFinalState.results === 'object') game.results = { ...(structuredFinalState.results as Game['results']) };
    game.winner = ORDER.includes(structuredFinalState.winner as Faction) ? structuredFinalState.winner as Faction : null;
    game.turnBeforeEnd = game.winner === null ? endingTurn : null;
    game.status = 'finished'; game.turn = null; game.turnSlot = null;
    frames[frames.length - 1] = clone(game);
  }

  const reconstructedCounts = counts(game.pieces);
  const declaredFinalCounts = declaredFinalPieces ? counts(declaredFinalPieces) : null;
  const warnings: ReplayWarning[] = [];
  const finalSignature = (pieces: readonly Piece[]) => pieces.map(piece => `${piece.faction}:${piece.kind}:${piece.x},${piece.y}`).sort().join('|');
  const finalMismatch = !!declaredFinalPieces && finalSignature(game.pieces) !== finalSignature(declaredFinalPieces);
  const declaredFinished = declaredWinner !== null || declaredResult.includes('和棋');
  if (finalMismatch || (declaredFinished && game.status !== 'finished')) {
    warnings.push({
      message: '文件声明的最终结果与逐步还原局面不一致，棋谱可能缺少认输或出局事件。',
      details: [
        `文件记录结果：${declaredResult || '未注明'}`,
        `第 ${rawMoves.length} 步后：${countText(reconstructedCounts)}，${ORDER.filter(faction => game.pieces.some(piece => piece.faction === faction && piece.kind === 'king')).map(faction => PLAYERS[faction].name).join('、')}仍在棋盘上`,
        declaredFinalCounts ? `文件导出时子力：${countText(declaredFinalCounts)}` : '文件未提供可核对的最终子力。',
        '未按声明结果猜测或清空任何棋子。',
        ...roundWarnings,
      ],
    });
  } else if (roundWarnings.length) {
    warnings.push({
      message: '旧棋谱缺少部分非走棋事件，轮次只能还原到记录明确的位置。',
      details: [...roundWarnings, '未根据最后行动方猜测结束或后续待行棋方。'],
    });
  }
  return {
    source, formatVersion, rulesVersion, declaredResult, declaredWinner,
    moves: clone(game.history), frames, events, warnings,
    initialCounts: clone(declaredCounts), reconstructedCounts, declaredFinalCounts,
  };
}

function parseLegacy(markdown: string): ReplayParseResult {
  try {
    const rulesVersion = markdown.match(/规则版本：`([^`]+)`/)?.[1];
    if (!rulesVersion) throw new Error('未找到规则版本。');
    if (!validRuleVersion(rulesVersion)) throw new Error(`暂不支持规则版本“${rulesVersion}”。`);
    const total = Number(markdown.match(/总步数：(\d+)/)?.[1]);
    if (!Number.isInteger(total) || total < 0) throw new Error('总步数缺失或无效。');
    const declaredResult = markdown.match(/本局结果：(.+)/)?.[1]?.trim() ?? '';
    const declaredWinner = declaredResult.includes('曹操胜利') ? 'wei'
      : declaredResult.includes('刘备胜利') ? 'shu' : declaredResult.includes('孙权胜利') ? 'wu' : null;
    const initial = parseInitialRows(section(markdown, '初始子力'));
    const finalRows = parseInitialRows(section(markdown, '导出时子力'));
    const moves = parseLegacyMoveLines(section(markdown, '行棋记录'), total);
    return { ok: true, replay: replayFrom('legacy', null, rulesVersion, initial.pieces, initial.declaredCounts,
      moves, declaredResult, declaredWinner, finalRows.pieces, []) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '棋谱解析失败。' };
  }
}

function parseStructured(markdown: string, source: unknown): ReplayParseResult {
  try {
    if (!source || typeof source !== 'object') throw new Error('结构化棋谱内容不是对象。');
    const data = source as Record<string, unknown>;
    if (data.format !== REPLAY_FORMAT) throw new Error('JSON 不是受支持的三国象棋结构化棋谱。');
    if (data.formatVersion !== REPLAY_FORMAT_VERSION)
      throw new Error(`暂不支持结构化棋谱版本 ${String(data.formatVersion)}。`);
    if (data.coordinateSystem !== 'code-zero-based') throw new Error('结构化棋谱坐标约定不是 code-zero-based。');
    const rulesVersion = typeof data.rulesVersion === 'string' ? data.rulesVersion : '';
    if (!validRuleVersion(rulesVersion)) throw new Error(`暂不支持规则版本“${rulesVersion || '未填写'}”。`);
    if (!Array.isArray(data.initialPieces)) throw new Error('结构化棋谱缺少初始子力。');
    const initialPieces = data.initialPieces.map(parseStructuredPiece);
    const declaredCounts = counts(initialPieces);
    const total = Number(markdown.match(/总步数：(\d+)/)?.[1] ?? (Array.isArray(data.moves) ? data.moves.length : -1));
    const moves = parseStructuredMoves(data.moves, total);
    const finalPieces = Array.isArray(data.finalPieces) ? data.finalPieces.map(parseStructuredPiece) : null;
    const rawEvents = Array.isArray(data.events) ? data.events : [];
    const events: ReplayEvent[] = rawEvents.map((value, index) => {
      if (!value || typeof value !== 'object') throw new Error(`结构化事件第 ${index + 1} 项格式无效。`);
      const event = value as Record<string, unknown>;
      if (!['elimination', 'resign', 'draw', 'result'].includes(String(event.type))) throw new Error(`结构化事件第 ${index + 1} 项类型无效。`);
      const step = Number(event.step);
      if (!Number.isInteger(step) || step < 0 || step > total) throw new Error(`结构化事件第 ${index + 1} 项的步号无效。`);
      if (event.turnBeforeEnd !== undefined && event.turnBeforeEnd !== null && !ORDER.includes(event.turnBeforeEnd as Faction))
        throw new Error(`结构化事件第 ${index + 1} 项的结束前待行棋方无效。`);
      return {
        type: event.type as ReplayEvent['type'],
        step,
        faction: ORDER.includes(event.faction as Faction) ? event.faction as Faction : undefined,
        factions: Array.isArray(event.factions) ? event.factions.filter((faction): faction is Faction => ORDER.includes(faction as Faction)) : undefined,
        winner: ORDER.includes(event.winner as Faction) ? event.winner as Faction : null,
        results: event.results && typeof event.results === 'object' ? event.results as ReplayEvent['results'] : undefined,
        turnBeforeEnd: event.turnBeforeEnd === null ? null : ORDER.includes(event.turnBeforeEnd as Faction)
          ? event.turnBeforeEnd as Faction : undefined,
      };
    });
    const declaredResult = markdown.match(/本局结果：(.+)/)?.[1]?.trim()
      ?? (typeof data.declaredResult === 'string' ? data.declaredResult : '');
    const declaredWinner = ORDER.includes(events.find(event => event.type === 'result')?.winner as Faction)
      ? events.find(event => event.type === 'result')!.winner as Faction
      : declaredResult.includes('曹操胜利') ? 'wei' : declaredResult.includes('刘备胜利') ? 'shu'
        : declaredResult.includes('孙权胜利') ? 'wu' : null;
    const finalState = data.finalState && typeof data.finalState === 'object' ? data.finalState as Record<string, unknown> : undefined;
    return { ok: true, replay: replayFrom('structured', REPLAY_FORMAT_VERSION, rulesVersion, initialPieces, declaredCounts,
      moves, declaredResult, declaredWinner, finalPieces, events, finalState) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '结构化棋谱解析失败。' };
  }
}

export function parseGameRecord(markdown: string): ReplayParseResult {
  if (!markdown.trim()) return { ok: false, error: '文件为空。' };
  const json = markdown.match(/```json\s*([\s\S]*?)```/i);
  if (!json) return parseLegacy(markdown);
  try {
    return parseStructured(markdown, JSON.parse(json[1]));
  } catch (error) {
    return { ok: false, error: `结构化棋谱 JSON 无法解析：${error instanceof Error ? error.message : '格式错误'}` };
  }
}

