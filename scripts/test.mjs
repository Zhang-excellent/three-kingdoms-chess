import { parse, compileScript } from '@vue/compiler-sfc';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'tests/.compiled-app.mts');
const componentOutputs = [];
for (const name of ['HomePage', 'LobbyPage', 'InvitePage', 'RoomWaiting', 'AuthDialog', 'OtherGamesPage', 'FiveSoldiersPage', 'HorseChessPage', 'ChineseChessPage']) {
  const sourcePath = resolve(root, 'src/components', `${name}.vue`);
  const componentSource = readFileSync(sourcePath, 'utf8');
  const component = parse(componentSource, { filename: `${name}.vue` });
  if (component.errors.length) throw component.errors[0];
  const compiledComponent = compileScript(component.descriptor, { id: `game-${name}`, inlineTemplate: true });
  const componentOutput = resolve(root, 'tests', `.compiled-${name}.mts`);
  writeFileSync(componentOutput, compiledComponent.content
    .replaceAll("'../auth.ts'", "'../src/auth.ts'")
    .replaceAll("'../five-soldiers.ts'", "'../src/five-soldiers.ts'")
    .replaceAll("'../horse-chess.ts'", "'../src/horse-chess.ts'")
    .replaceAll("'../chinese-chess.ts'", "'../src/chinese-chess.ts'")
    .replaceAll("'../game-history.ts'", "'../src/game-history.ts'")
    .replaceAll("'../game.ts'", "'../src/game.ts'")
    .replaceAll("'../navigation.ts'", "'../src/navigation.ts'")
    .replaceAll("'../online.ts'", "'../src/online.ts'"));
  componentOutputs.push(componentOutput);
}
const source = readFileSync(resolve(root, 'src/App.vue'), 'utf8');
const { descriptor, errors } = parse(source, { filename: 'App.vue' });
if (errors.length) throw errors[0];
const result = compileScript(descriptor, { id: 'game-ui-tests', inlineTemplate: true });
writeFileSync(output, result.content
  .replaceAll("'./components/HomePage.vue'", "'./.compiled-HomePage.mts'")
  .replaceAll("'./components/LobbyPage.vue'", "'./.compiled-LobbyPage.mts'")
  .replaceAll("'./components/InvitePage.vue'", "'./.compiled-InvitePage.mts'")
  .replaceAll("'./components/RoomWaiting.vue'", "'./.compiled-RoomWaiting.mts'")
  .replaceAll("'./components/AuthDialog.vue'", "'./.compiled-AuthDialog.mts'")
  .replaceAll("'./components/OtherGamesPage.vue'", "'./.compiled-OtherGamesPage.mts'")
  .replaceAll("'./components/FiveSoldiersPage.vue'", "'./.compiled-FiveSoldiersPage.mts'")
  .replaceAll("'./components/HorseChessPage.vue'", "'./.compiled-HorseChessPage.mts'")
  .replaceAll("'./components/ChineseChessPage.vue'", "'./.compiled-ChineseChessPage.mts'")
  .replaceAll("'./game.ts'", "'../src/game.ts'")
  .replaceAll("'./game-history.ts'", "'../src/game-history.ts'")
  .replaceAll("'./board-view.ts'", "'../src/board-view.ts'")
  .replaceAll("'./audio.ts'", "'../src/audio.ts'")
  .replaceAll("'./music-catalog.ts'", "'../src/music-catalog.ts'")
  .replaceAll("'./game-record.ts'", "'../src/game-record.ts'")
  .replaceAll("'./game-replay.ts'", "'../src/game-replay.ts'")
  .replaceAll("'./navigation.ts'", "'../src/navigation.ts'")
  .replaceAll("'./useAuth.ts'", "'../src/useAuth.ts'")
  .replaceAll("'./useOnlineRoom.ts'", "'../src/useOnlineRoom.ts'"));
let status = 1;
try {
  const run = spawnSync(process.execPath, ['--test', 'tests/audio.test.ts', 'tests/auth.test.ts', 'tests/board-view.test.ts', 'tests/chinese-chess.test.ts', 'tests/chinese-chess-service.test.ts', 'tests/chinese-chess-socket.test.ts', 'tests/chinese-chess-ui.test.ts', 'tests/five-soldiers.test.ts', 'tests/five-soldiers-service.test.ts', 'tests/five-soldiers-socket.test.ts', 'tests/five-soldiers-ui.test.ts', 'tests/game.test.ts', 'tests/game-history.test.ts', 'tests/game-record.test.ts', 'tests/game-replay.test.ts', 'tests/horse-chess.test.ts', 'tests/horse-chess-service.test.ts', 'tests/horse-chess-socket.test.ts', 'tests/horse-chess-ui.test.ts', 'tests/navigation.test.ts', 'tests/online-client.test.ts', 'tests/online-ui.test.ts', 'tests/replay-ui.test.ts', 'tests/three-kingdoms-sim.test.ts', 'tests/ui.test.ts', 'tests/room-service.test.ts', 'tests/socket.test.ts'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' },
  });
  status = run.status ?? 1;
} finally {
  unlinkSync(output);
  for (const componentOutput of componentOutputs) unlinkSync(componentOutput);
}
process.exit(status);
