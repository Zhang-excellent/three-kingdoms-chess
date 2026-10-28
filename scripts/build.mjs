import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Script } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const executable of ['node_modules/vue-tsc/bin/vue-tsc.js', 'node_modules/vite/bin/vite.js']) {
  const args = executable.includes('vue-tsc') ? ['--noEmit'] : ['build'];
  const result = spawnSync(process.execPath, [executable, ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const dir = resolve(root, 'dist/assets'), files = readdirSync(dir);
const js = files.filter(f => f.endsWith('.js')).map(f => readFileSync(resolve(dir, f), 'utf8')).join('\n');
const css = files.filter(f => f.endsWith('.css')).map(f => readFileSync(resolve(dir, f), 'utf8')).join('\n');
if (files.filter(f => f.endsWith('.js')).length !== 1) throw new Error('Offline preview requires one application bundle.');
let html = readFileSync(resolve(root, 'dist/index.html'), 'utf8');
html = html.replace(/<script\b[^>]*src="[^"]+"[^>]*><\/script>/g, '')
  .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, '')
  // Callback replacements keep `$&`, `$\`` and similar sequences in the
  // generated bundles literal instead of treating them as replacement tokens.
  .replace('</head>', () => `<style>${css}</style></head>`)
  .replace('</body>', () => `<script type="module">${js.replaceAll('</script', '<\\/script')}</script></body>`);
const inlineModule = html.match(/<script type="module">([\s\S]*)<\/script><\/body>/)?.[1];
if (!inlineModule) throw new Error('Offline preview is missing its inline application bundle.');
new Script(inlineModule, { filename: 'preview/试玩.html' });
if ((html.match(/<!doctype html>/gi) ?? []).length !== 1) throw new Error('Offline preview unexpectedly contains nested HTML.');
mkdirSync(resolve(root, 'preview'), { recursive: true });
writeFileSync(resolve(root, 'preview/试玩.html'), html);
const music = resolve(root, 'public/audio/background.mp3');
if (existsSync(music)) {
  mkdirSync(resolve(root, 'preview/audio'), { recursive: true });
  copyFileSync(music, resolve(root, 'preview/audio/background.mp3'));
}
console.log('已生成 preview/试玩.html，可直接用浏览器打开。');
