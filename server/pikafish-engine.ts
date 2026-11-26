import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type PikafishErrorCode = 'UNAVAILABLE' | 'BUSY' | 'TIMEOUT' | 'PROTOCOL' | 'CANCELLED';

export class PikafishError extends Error {
  readonly code: PikafishErrorCode;

  constructor(code: PikafishErrorCode, message: string) {
    super(message);
    this.name = 'PikafishError';
    this.code = code;
  }
}

export interface ChineseEngineRequest {
  initialFen: string;
  moves: string[];
}

export interface ChineseEngineClient {
  readonly configured: boolean;
  bestMove(request: ChineseEngineRequest): Promise<string | null>;
  dispose(): void;
}

export interface PikafishConfig {
  executablePath: string;
  evalFile: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  threads: number;
  hashMb: number;
  moveTimeMs: number;
  searchTimeoutMs: number;
  startupTimeoutMs: number;
  maxQueue: number;
}

interface Waiter {
  predicate: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const boundedInteger = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

export function pikafishConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PikafishConfig {
  return {
    executablePath: env.PIKAFISH_PATH?.trim() ?? '',
    evalFile: env.PIKAFISH_EVAL_FILE?.trim() ?? '',
    threads: boundedInteger(env.PIKAFISH_THREADS, 1, 1, 4),
    hashMb: boundedInteger(env.PIKAFISH_HASH_MB, 64, 16, 1024),
    moveTimeMs: boundedInteger(env.PIKAFISH_MOVE_TIME_MS, 800, 100, 10_000),
    searchTimeoutMs: boundedInteger(env.PIKAFISH_SEARCH_TIMEOUT_MS, 6_000, 200, 30_000),
    startupTimeoutMs: boundedInteger(env.PIKAFISH_STARTUP_TIMEOUT_MS, 8_000, 1_000, 30_000),
    maxQueue: boundedInteger(env.PIKAFISH_MAX_QUEUE, 2, 0, 8),
  };
}

export class PikafishEngineClient implements ChineseEngineClient {
  private readonly config: PikafishConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private waiters: Waiter[] = [];
  private options = new Set<string>();
  private stderrTail = '';
  private queueSize = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(config: PikafishConfig) {
    this.config = {
      ...config,
      executablePath: config.executablePath ? resolve(config.executablePath) : '',
      evalFile: config.evalFile ? resolve(config.evalFile) : '',
    };
  }

  get configured(): boolean {
    return !!this.config.executablePath && existsSync(this.config.executablePath)
      && (!this.config.evalFile || existsSync(this.config.evalFile));
  }

  async bestMove(request: ChineseEngineRequest): Promise<string | null> {
    if (!this.configured)
      throw new PikafishError('UNAVAILABLE', 'Pikafish executable or evaluation file is not configured.');
    if (this.queueSize >= this.config.maxQueue + 1)
      throw new PikafishError('BUSY', 'Pikafish queue is full.');

    this.queueSize++;
    const operation = this.tail.then(() => this.search(request));
    this.tail = operation.then(() => undefined, () => undefined);
    try {
      return await operation;
    } finally {
      this.queueSize--;
    }
  }

  async uciOptions(): Promise<string[]> {
    await this.ensureStarted();
    return Array.from(this.options).sort();
  }

  dispose(): void {
    this.resetProcess(new PikafishError('CANCELLED', 'Pikafish engine was disposed.'));
  }

  private async search(request: ChineseEngineRequest): Promise<string | null> {
    try {
      await this.ensureStarted();
    } catch (error) {
      this.resetProcess(error instanceof Error ? error : new PikafishError('PROTOCOL', 'Pikafish failed to start.'));
      throw error;
    }
    const child = this.child;
    if (!child) throw new PikafishError('UNAVAILABLE', 'Pikafish process is not running.');
    this.writeLine(`position fen ${request.initialFen}${request.moves.length ? ` moves ${request.moves.join(' ')}` : ''}`);
    this.writeLine(`go movetime ${this.config.moveTimeMs}`);
    try {
      const line = await this.waitFor(
        value => value.startsWith('bestmove '),
        this.config.searchTimeoutMs,
        'Pikafish search timed out.',
      );
      const bestMove = line.trim().split(/\s+/)[1] ?? '(none)';
      return bestMove === '(none)' || bestMove === '0000' ? null : bestMove;
    } catch (error) {
      this.resetProcess(error instanceof Error ? error : new PikafishError('PROTOCOL', 'Pikafish failed.'));
      throw error;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (!this.configured)
      throw new PikafishError('UNAVAILABLE', 'Pikafish executable or evaluation file is not configured.');

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.config.executablePath, this.config.args ?? [], {
        cwd: resolve(this.config.executablePath, '..'),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.config.env },
      });
    } catch (error) {
      throw new PikafishError('UNAVAILABLE', `Pikafish could not start: ${String(error)}`);
    }
    this.child = child;
    this.buffer = '';
    this.options.clear();
    this.stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.consume(String(chunk)));
    child.stderr.on('data', chunk => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-4_000);
      if (this.stderrTail.includes('ERROR')) console.error(`[Pikafish] ${this.stderrTail.trim()}`);
    });
    child.on('error', error => {
      if (this.child === child) {
        this.child = null;
        this.rejectAll(new PikafishError('UNAVAILABLE', `Pikafish process error: ${error.message}`));
      }
    });
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.rejectAll(new PikafishError('UNAVAILABLE', 'Pikafish process exited unexpectedly.'));
      }
    });

    await this.waitFor(line => line === 'uciok', this.config.startupTimeoutMs, 'Pikafish UCI handshake timed out.',
      () => this.writeLine('uci'));
    if (this.options.has('threads')) this.writeLine(`setoption name Threads value ${this.config.threads}`);
    if (this.options.has('hash')) this.writeLine(`setoption name Hash value ${this.config.hashMb}`);
    if (this.config.evalFile) {
      if (!this.options.has('evalfile'))
        throw new PikafishError('PROTOCOL', 'Pikafish did not advertise the EvalFile option.');
      this.writeLine(`setoption name EvalFile value ${this.config.evalFile}`);
    }
    await this.waitFor(line => line === 'readyok', this.config.startupTimeoutMs, 'Pikafish isready timed out.',
      () => this.writeLine('isready'));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    const option = /^option name (.+?) type /i.exec(line);
    if (option) this.options.add(option[1].trim().toLowerCase());
    const waiterIndex = this.waiters.findIndex(waiter => waiter.predicate(line));
    if (waiterIndex < 0) return;
    const [waiter] = this.waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(line);
  }

  private waitFor(
    predicate: (line: string) => boolean,
    timeoutMs: number,
    timeoutMessage: string,
    afterRegister?: () => void,
  ): Promise<string> {
    return new Promise((resolveWaiter, rejectWaiter) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex(waiter => waiter.resolve === resolveWaiter);
        if (index >= 0) this.waiters.splice(index, 1);
        rejectWaiter(new PikafishError('TIMEOUT', timeoutMessage));
      }, timeoutMs);
      const waiter = { predicate, resolve: resolveWaiter, reject: rejectWaiter, timer };
      this.waiters.push(waiter);
      try {
        afterRegister?.();
      } catch (error) {
        clearTimeout(timer);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        rejectWaiter(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeLine(line: string): void {
    const child = this.child;
    if (!child || !child.stdin.writable)
      throw new PikafishError('UNAVAILABLE', 'Pikafish process stdin is not available.');
    child.stdin.write(`${line}\n`);
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private resetProcess(error: Error): void {
    const child = this.child;
    this.child = null;
    this.rejectAll(error);
    if (child && !child.killed) child.kill();
  }
}
