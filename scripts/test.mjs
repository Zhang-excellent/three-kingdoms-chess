import { parse, compileScript } from '@vue/compiler-sfc';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'tests/.compiled-app.mts');
const source = readFileSync(resolve(root, 'src/App.vue'), 'utf8');
const { descriptor, errors } = parse(source, { filename: 'App.vue' });
if (errors.length) throw errors[0];
const result = compileScript(descriptor, { id: 'game-ui-tests', inlineTemplate: true });
writeFileSync(output, result.content.replaceAll("'./game.ts'", "'../src/game.ts'"));
let status = 1;
try {
  const run = spawnSync(process.execPath, ['--test', 'tests/game.test.ts', 'tests/ui.test.ts'], { cwd: root, stdio: 'inherit' });
  status = run.status ?? 1;
} finally { unlinkSync(output); }
process.exit(status);
