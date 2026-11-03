import { parse, compileScript } from '@vue/compiler-sfc';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'tests/.compiled-app.mts');
const componentOutputs = [];
for (const name of ['HomePage', 'LobbyPage', 'InvitePage', 'RoomWaiting']) {
  const sourcePath = resolve(root, 'src/components', `${name}.vue`);
  const componentSource = readFileSync(sourcePath, 'utf8');
  const component = parse(componentSource, { filename: `${name}.vue` });
  if (component.errors.length) throw component.errors[0];
  const compiledComponent = compileScript(component.descriptor, { id: `game-${name}`, inlineTemplate: true });
  const componentOutput = resolve(root, 'tests', `.compiled-${name}.mts`);
  writeFileSync(componentOutput, compiledComponent.content
    .replaceAll("'../game.ts'", "'../src/game.ts'")
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
  .replaceAll("'./game.ts'", "'../src/game.ts'")
  .replaceAll("'./board-view.ts'", "'../src/board-view.ts'")
  .replaceAll("'./audio.ts'", "'../src/audio.ts'")
  .replaceAll("'./music-catalog.ts'", "'../src/music-catalog.ts'")
  .replaceAll("'./game-record.ts'", "'../src/game-record.ts'")
  .replaceAll("'./game-replay.ts'", "'../src/game-replay.ts'")
  .replaceAll("'./navigation.ts'", "'../src/navigation.ts'")
  .replaceAll("'./useOnlineRoom.ts'", "'../src/useOnlineRoom.ts'"));
let status = 1;
try {
  const run = spawnSync(process.execPath, ['--test', 'tests/audio.test.ts', 'tests/board-view.test.ts', 'tests/game.test.ts', 'tests/game-record.test.ts', 'tests/game-replay.test.ts', 'tests/navigation.test.ts', 'tests/online-client.test.ts', 'tests/online-ui.test.ts', 'tests/replay-ui.test.ts', 'tests/ui.test.ts', 'tests/room-service.test.ts', 'tests/socket.test.ts'], { cwd: root, stdio: 'inherit' });
  status = run.status ?? 1;
} finally {
  unlinkSync(output);
  for (const componentOutput of componentOutputs) unlinkSync(componentOutput);
}
process.exit(status);
