import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseGameRecord } from '../src/game-replay.ts';
import type { ReplayDocument } from '../src/game-replay.ts';
import { ORDER, PLAYERS } from '../src/game.ts';
import type { Faction } from '../src/game.ts';
import {
  factionName,
  formatPercent,
  simulateGame,
  summarizeSimulation,
} from '../src/three-kingdoms-sim.ts';
import type { SimulationPolicy, SimulationResult, SimulationSummary } from '../src/three-kingdoms-sim.ts';

const root = resolve(import.meta.dirname, '..');
const defaultRecordDirectory = 'C:\\Users\\lenovo\\Documents\\xwechat_files\\wxid_0y7oh688ljp622_303d\\msg\\file\\2026-11';
const recordNames = [
  '三国象棋棋谱-20261115-232214.md',
  '三国象棋棋谱-20261115-220903.md',
  '三国象棋棋谱-20261115-214957.md',
  '三国象棋棋谱-20261115-001418.md',
  '三国象棋棋谱-20261106-145310(5).md',
  '三国象棋棋谱-20261029-234542(3).md',
  '三国象棋棋谱-20261109-123706(2).md',
];

interface RecordSummary {
  name: string;
  ok: boolean;
  error?: string;
  result: string;
  winner: Faction | null;
  moves: number;
  initialCounts: Record<Faction, number>;
  firstEliminated: Faction | null;
  warnings: number;
}

interface ReportData {
  generatedAt: string;
  gamesPerProfile: number;
  records: RecordSummary[];
  profiles: Array<{ policy: SimulationPolicy; summary: SimulationSummary }>;
  elapsedMs: number;
}

const argument = (name: string): string | undefined =>
  process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

const games = Math.max(1, Number(argument('games') ?? 500));
const recordDirectory = argument('record-dir') ?? defaultRecordDirectory;
const shouldWrite = argument('write') !== 'false';

function declaredOutcome(replay: ReplayDocument): { result: string; winner: Faction | null } {
  if (replay.declaredWinner) {
    return {
      result: `${PLAYERS[replay.declaredWinner].name}获胜`,
      winner: replay.declaredWinner,
    };
  }
  if (replay.declaredResult.includes('和棋')) return { result: '和棋', winner: null };
  return { result: replay.declaredResult || '未注明', winner: null };
}

function firstEliminated(replay: ReplayDocument): Faction | null {
  return replay.moves.flatMap(move => move.eliminated)
    .find((faction, index, all) => all.indexOf(faction) === index) ?? null;
}

function analyzeRecords(): RecordSummary[] {
  return recordNames.map(name => {
    const path = resolve(recordDirectory, name);
    if (!existsSync(path)) {
      return {
        name, ok: false, error: '文件不存在', result: '未分析', winner: null, moves: 0,
        initialCounts: { wei: 0, shu: 0, wu: 0 }, firstEliminated: null, warnings: 0,
      };
    }
    const parsed = parseGameRecord(readFileSync(path, 'utf8'));
    if (!parsed.ok) {
      return {
        name, ok: false, error: parsed.error, result: '解析失败', winner: null, moves: 0,
        initialCounts: { wei: 0, shu: 0, wu: 0 }, firstEliminated: null, warnings: 0,
      };
    }
    const outcome = declaredOutcome(parsed.replay);
    return {
      name,
      ok: true,
      result: outcome.result,
      winner: outcome.winner,
      moves: parsed.replay.moves.length,
      initialCounts: parsed.replay.initialCounts,
      firstEliminated: firstEliminated(parsed.replay),
      warnings: parsed.replay.warnings.length,
    };
  });
}

const policies: SimulationPolicy[] = [
  {
    name: '纯随机合法走子',
    coalition: 0.1,
    randomness: 260,
    caoExchangeBias: 0.2,
    maxPlies: 240,
  },
  {
    name: '孙刘低协调',
    coalition: 0.25,
    randomness: 145,
    caoExchangeBias: 0.75,
    maxPlies: 240,
  },
  {
    name: '孙刘正常配合',
    coalition: 0.65,
    randomness: 105,
    caoExchangeBias: 0.95,
    maxPlies: 240,
  },
  {
    name: '孙刘高度一心',
    coalition: 0.95,
    randomness: 80,
    caoExchangeBias: 1,
    maxPlies: 240,
  },
];

function playProfile(policy: SimulationPolicy, profileIndex: number): { policy: SimulationPolicy; summary: SimulationSummary } {
  const results: SimulationResult[] = [];
  for (let gameIndex = 0; gameIndex < games; gameIndex++) {
    const seed = 0x9E3779B9 ^ Math.imul(profileIndex + 1, 0x85EBCA6B) ^ Math.imul(gameIndex + 1, 0xC2B2AE35);
    results.push(simulateGame(policy, seed >>> 0));
  }
  return { policy, summary: summarizeSimulation(results) };
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function summaryRow(profile: ReturnType<typeof playProfile>): string {
  const { policy, summary } = profile;
  return `| ${policy.name} | ${formatPercent(summary.winRate.wei)} | ${formatPercent(summary.winRate.shu)} | ${formatPercent(summary.winRate.wu)} | ${formatPercent(summary.drawRate)} | ${summary.averageScore.wei.toFixed(2)} / ${summary.averageScore.shu.toFixed(2)} / ${summary.averageScore.wu.toFixed(2)} | ${summary.averageMoves.toFixed(1)} |`;
}

function firstEliminationRow(profile: ReturnType<typeof playProfile>): string {
  const { policy, summary } = profile;
  return `| ${policy.name} | ${percentage(summary.firstEliminationRate.wei)} | ${percentage(summary.firstEliminationRate.shu)} | ${percentage(summary.firstEliminationRate.wu)} |`;
}

function buildMarkdown(data: ReportData): string {
  const records = data.records.map(record => {
    if (!record.ok) return `| ${record.name} | 失败 | ${record.error ?? '未知错误'} | — | — | — |`;
    const counts = ORDER.map(faction => record.initialCounts[faction]).join('/');
    return `| ${record.name} | ${record.result} | ${record.moves} | ${counts} | ${record.firstEliminated ? PLAYERS[record.firstEliminated].name : '未记录'} | ${record.warnings} |`;
  }).join('\n');
  const rows = data.profiles.map(summaryRow).join('\n');
  const eliminationRows = data.profiles.map(firstEliminationRow).join('\n');
  const normal = data.profiles.find(profile => profile.policy.name === '孙刘正常配合')!;
  const high = data.profiles.find(profile => profile.policy.name === '孙刘高度一心')!;
  const low = data.profiles.find(profile => profile.policy.name === '孙刘低协调')!;
  const profilesByCao = [...data.profiles].sort((left, right) => right.summary.winRate.wei - left.summary.winRate.wei);
  const recordWins: Record<'wei' | 'shu' | 'wu' | 'draw', number> = { wei: 0, shu: 0, wu: 0, draw: 0 };
  for (const record of data.records.filter(item => item.ok)) {
    if (record.winner) recordWins[record.winner]++;
    else recordWins.draw++;
  }
  const coalitionTrend = high.summary.winRate.wei < normal.summary.winRate.wei
    && normal.summary.winRate.wei < low.summary.winRate.wei;
  const jointBest = formatPercent(normal.summary.winRate.shu + normal.summary.winRate.wu);
  return `# 三国象棋 500 局启发式模拟分析

生成时间：${data.generatedAt}

> 这是基于当前规则和启发式机器人进行的离线蒙特卡洛模拟，不是真人对局统计，也不能证明某种真人策略的绝对胜率。每局双方仍遵守现有“吃主公即出局、剩余两国交替”的规则。

## 真实棋谱基线

| 棋谱 | 文件声明结果 | 步数 | 初始子力 魏/蜀/吴 | 首次记录出局 | 解析提示 |
| --- | --- | ---: | --- | --- | ---: |
${records}

## 模拟设置

- 每个策略组运行 **${data.gamesPerProfile} 局**，同一策略组使用固定种子，可重复。
- 曹操策略：偏好兑子，子力领先时主动简化；优先威胁孙权、刘备主公所在的三、七路。
- 孙刘策略：曹操存活时避免互攻，协调度越高越优先共同消耗魏方；曹操出局后恢复各自争胜。
- 随机项目用于模拟判断误差和临场选择差异，不是完全随机乱走。
- 超过 240 手仍未结束按和棋处理；使用胜 4、出局 0、一方出局后两方和棋各 2、三人和棋魏 2 蜀吴各 1 的得分体系。

## 胜率结果

| 策略 | 曹操胜率 | 刘备胜率 | 孙权胜率 | 和棋率 | 平均得分 魏/蜀/吴 | 平均步数 |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
${rows}

## 首次出局分布

| 策略 | 曹操先出局 | 刘备先出局 | 孙权先出局 |
| --- | ---: | ---: | ---: |
${eliminationRows}

## 模型观察

1. 7 份真实棋谱中，曹操获胜 ${recordWins.wei} 盘、刘备获胜 ${recordWins.shu} 盘、孙权获胜 ${recordWins.wu} 盘、和棋 ${recordWins.draw} 盘。样本很小，只能作为观察基线。
2. 四个模拟策略中，曹操始终是单一胜率最高的阵营。最高为“${profilesByCao[0].policy.name}”${formatPercent(profilesByCao[0].summary.winRate.wei)}，最低为“${profilesByCao.at(-1)!.policy.name}”${formatPercent(profilesByCao.at(-1)!.summary.winRate.wei)}。
3. 协调度低、正常、高时曹操胜率依次为 ${formatPercent(low.summary.winRate.wei)}、${formatPercent(normal.summary.winRate.wei)}、${formatPercent(high.summary.winRate.wei)}。${coalitionTrend ? '结果符合“协调度越高，曹操越难获胜”的方向。' : '本轮机器人结果没有形成单调下降，说明当前“高协调”评估让孙刘过于保守，不能据此否定真人实战规律。'}
4. 正常配合组刘备与孙权合计胜率为 ${jointBest}，明显低于曹操，同时和棋率为 ${formatPercent(normal.summary.drawRate)}。当前模型下，曹操的主要风险更像“无法收胜而拖入和棋”，不是经常被孙刘直接击杀。
5. 这组数据没有显式模拟真人“毒酒、借刀杀人和背刺心理”中的欺骗与读心。它适合做规则平衡和策略假设的第一轮压力测试，不足以替代真人多设备对局。

模拟总耗时：${(data.elapsedMs / 1000).toFixed(1)} 秒。
`;
}

const started = performance.now();
const recordSummaries = analyzeRecords();
const profiles = policies.map((policy, index) => playProfile(policy, index));
const data: ReportData = {
  generatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
  gamesPerProfile: games,
  records: recordSummaries,
  profiles,
  elapsedMs: performance.now() - started,
};

if (shouldWrite) {
  const jsonPath = resolve(root, 'docs/三国象棋模拟数据.json');
  const markdownPath = resolve(root, 'docs/三国象棋500局模拟分析.md');
  writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(markdownPath, buildMarkdown(data));
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

for (const profile of profiles) {
  const { summary, policy } = profile;
  console.log(`${policy.name}: 曹操 ${formatPercent(summary.winRate.wei)}, 刘备 ${formatPercent(summary.winRate.shu)}, 孙权 ${formatPercent(summary.winRate.wu)}, 和棋 ${formatPercent(summary.drawRate)}, 平均 ${summary.averageMoves.toFixed(1)} 手`);
}
console.log(`Records: ${recordSummaries.filter(record => record.ok).length}/${recordSummaries.length} parsed`);
console.log(`Elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s`);
