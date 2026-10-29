import { ORDER, PLAYERS, newGame, pieceName, validGame } from './game.ts';
import type { Faction, Game, Piece } from './game.ts';

const coordinate = (point: { x: number; y: number }) => `(${point.x + 1}, ${point.y + 1})`;
const resultLabel = (game: Game, faction: Faction) =>
  game.results[faction] === 'won' ? '胜利' : game.results[faction] === 'lost' ? '失败'
    : game.results[faction] === 'draw' ? '和棋' : '对局中';
const pieceDescription = (piece: Piece) =>
  `${PLAYERS[piece.faction].nation}方${pieceName(piece)} ${coordinate(piece)}`;

function piecesByFaction(pieces: readonly Piece[]): string {
  return ORDER.map(faction => {
    const own = pieces.filter(piece => piece.faction === faction);
    return `- ${PLAYERS[faction].nation}方（${own.length} 枚）：${own.map(pieceDescription).join('、') || '无'}`;
  }).join('\n');
}

function gameStatus(game: Game): string {
  if (game.status === 'finished' && game.winner) return `${PLAYERS[game.winner].name}获胜`;
  if (game.status === 'finished') return '和棋';
  if (!game.turn) return '对局已结束';
  return `对局进行中，轮到${PLAYERS[game.turn].name}`;
}

export function gameRecordFileName(exportedAt = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${exportedAt.getFullYear()}${pad(exportedAt.getMonth() + 1)}${pad(exportedAt.getDate())}-${pad(exportedAt.getHours())}${pad(exportedAt.getMinutes())}${pad(exportedAt.getSeconds())}`;
  return `三国象棋棋谱-${stamp}.md`;
}

export function buildGameRecord(game: Game, exportedAt = new Date()): string {
  if (!validGame(game)) throw new Error('无法导出无效棋局。');
  const moveLines = game.history.length
    ? game.history.map(record => {
      const extras = [
        record.captured ? `吃掉${PLAYERS[record.captured.faction].nation}方${pieceName(record.captured)}` : '',
        record.eliminated.length ? `${record.eliminated.map(faction => PLAYERS[faction].name).join('、')}出局` : '',
      ].filter(Boolean);
      return `${record.number}. ${PLAYERS[record.faction].name} · ${pieceName(record)} ${coordinate(record.from)} → ${coordinate(record.to)}${extras.length ? `；${extras.join('；')}` : ''}`;
    }).join('\n')
    : '尚无行棋记录。';
  const exported = `${exportedAt.getFullYear()}-${String(exportedAt.getMonth() + 1).padStart(2, '0')}-${String(exportedAt.getDate()).padStart(2, '0')} ${String(exportedAt.getHours()).padStart(2, '0')}:${String(exportedAt.getMinutes()).padStart(2, '0')}:${String(exportedAt.getSeconds()).padStart(2, '0')}`;
  return [
    '# 三国象棋棋谱',
    '',
    `- 规则版本：\`${game.rulesVersion}\``,
    `- 导出时间：${exported}`,
    `- 对局状态：${gameStatus(game)}`,
    `- 总步数：${game.history.length}`,
    `- 本局结果：${ORDER.map(faction => `${PLAYERS[faction].name}${resultLabel(game, faction)}`).join('；')}`,
    '',
    '## 行棋记录',
    '',
    moveLines,
    '',
    '## 初始子力',
    '',
    piecesByFaction(newGame().pieces),
    '',
    '## 导出时子力',
    '',
    piecesByFaction(game.pieces),
    '',
    '坐标均采用页面显示的 `(路, 线)`，即代码坐标加一。',
    '',
  ].join('\n');
}
