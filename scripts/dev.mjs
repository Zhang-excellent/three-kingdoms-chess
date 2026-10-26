import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'server/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
const stop = () => children.forEach(child => child.kill());
for (const child of children) child.on('exit', code => { stop(); if (code) process.exitCode = code; });
process.on('SIGINT', stop); process.on('SIGTERM', stop);
