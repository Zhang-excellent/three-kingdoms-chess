import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Script } from 'node:vm';
import { DEFAULT_PLAYLIST_ID, MUSIC_PLAYLISTS, MUSIC_TRACKS } from '../src/music-catalog.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const playlistIds = new Set(MUSIC_PLAYLISTS.map(playlist => playlist.id));
if (!playlistIds.has(DEFAULT_PLAYLIST_ID) || playlistIds.size !== MUSIC_PLAYLISTS.length)
  throw new Error('Music playlist IDs must be unique and include the default playlist.');
const trackIds = new Set();
for (const track of MUSIC_TRACKS) {
  if (trackIds.has(track.id) || !playlistIds.has(track.playlistId ?? DEFAULT_PLAYLIST_ID) || !/^[a-z0-9-]+\.mp3$/.test(track.file))
    throw new Error(`Invalid music catalogue entry: ${track.id}`);
  trackIds.add(track.id);
  const file = resolve(root, 'public/audio', track.file);
  if (!existsSync(file)) throw new Error(`Missing music file: ${track.file}`);
  const version = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
  if (version !== track.cacheVersion) throw new Error(`Update cacheVersion for ${track.id} to ${version}`);
}
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
const audio = resolve(root, 'public/audio');
if (existsSync(audio)) {
  const previewAudio = resolve(root, 'preview/audio');
  mkdirSync(previewAudio, { recursive: true });
  const names = readdirSync(audio).filter(name => name.endsWith('.mp3'));
  for (const name of readdirSync(previewAudio).filter(name => name.endsWith('.mp3') && !names.includes(name)))
    unlinkSync(resolve(previewAudio, name));
  for (const name of names) {
    const destination = resolve(root, 'preview/audio', name);
    if (existsSync(destination)) chmodSync(destination, 0o666); // supplied files may carry Windows read-only attributes
    copyFileSync(resolve(audio, name), destination);
  }
}
console.log('已生成 preview/试玩.html，可直接用浏览器打开。');
