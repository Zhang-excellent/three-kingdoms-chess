import {
  PikafishEngineClient,
  pikafishConfigFromEnv,
} from '../server/pikafish-engine.ts';
import { initialChineseFen } from '../src/chinese-chess-uci.ts';

const config = pikafishConfigFromEnv();
if (!config.executablePath) {
  console.error('PIKAFISH_PATH is not configured.');
  process.exitCode = 1;
} else {
  const engine = new PikafishEngineClient(config);
  try {
    if (!engine.configured) throw new Error('Pikafish executable or PIKAFISH_EVAL_FILE does not exist.');
    const options = await engine.uciOptions();
    const bestMove = await engine.bestMove({ initialFen: initialChineseFen(), moves: [] });
    console.log(JSON.stringify({
      executable: config.executablePath,
      evalFile: config.evalFile || null,
      threads: config.threads,
      hashMb: config.hashMb,
      moveTimeMs: config.moveTimeMs,
      options,
      bestMove,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    engine.dispose();
  }
}
