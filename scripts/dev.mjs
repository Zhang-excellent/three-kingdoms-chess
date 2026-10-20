import { spawn } from 'node:child_process';

const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(command, ['run', 'dev:server'], { stdio: 'inherit' }),
  spawn(command, ['run', 'dev:web'], { stdio: 'inherit' }),
];
const stop = () => children.forEach(child => child.kill());
for (const child of children) child.on('exit', code => { stop(); if (code) process.exitCode = code; });
process.on('SIGINT', stop); process.on('SIGTERM', stop);
