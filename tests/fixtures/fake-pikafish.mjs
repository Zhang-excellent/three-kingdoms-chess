import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const raw of input) {
  const line = raw.trim();
  if (line === 'uci') {
    process.stdout.write('id name Fake Pikafish\n');
    process.stdout.write('option name Threads type spin default 1 min 1 max 1024\n');
    process.stdout.write('option name Hash type spin default 16 min 1 max 33554432\n');
    process.stdout.write('option name EvalFile type string default pikafish.nnue\n');
    process.stdout.write('uciok\n');
  } else if (line === 'isready') {
    process.stdout.write('readyok\n');
  } else if (line.startsWith('go ')) {
    if (process.env.FAKE_PIKAFISH_HANG === '1') continue;
    process.stdout.write(`info depth 1 score cp 20 pv ${process.env.FAKE_PIKAFISH_MOVE || 'h2e2'}\n`);
    process.stdout.write(`bestmove ${process.env.FAKE_PIKAFISH_MOVE || 'h2e2'}\n`);
  } else if (line === 'quit') {
    process.exit(0);
  }
}
