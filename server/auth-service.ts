import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  REMEMBER_SESSION_SECONDS,
  SHORT_SESSION_SECONDS,
  passwordError,
  usernameError,
  usernameKey,
  normalizeUsername,
} from '../src/auth.ts';
import type { AuthUser } from '../src/auth.ts';
import type { ArchivedGameRecord, GameEndReason, RecentGameSummary } from '../src/game-history.ts';
import { FixedWindowRateLimiter } from './rate-limit.ts';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const DISABLED_RECOVERY_HASH = 'disabled';

interface UserRow {
  id: string;
  username: string;
  username_key: string;
  password_hash: string;
  recovery_hash: string;
}

interface SessionRow {
  token_hash: string;
  user_id: string;
  expires_at: number;
}

interface SessionUserRow extends UserRow {
  expires_at: number;
}

interface GameRow {
  id: string;
  room_code: string;
  room_round: number;
  started_at: number;
  ended_at: number;
  rules_version: string;
  initial_json: string;
  participants_json: string;
  moves_json: string;
  events_json: string;
  final_state_json: string;
  final_pieces_json: string;
  end_reason: GameEndReason;
  move_count: number;
}

export interface AuthRateLimits {
  registerAttempts: number;
  registerWindowMs: number;
  loginAttempts: number;
  loginWindowMs: number;
  passwordAttempts: number;
  passwordWindowMs: number;
}

const DEFAULT_RATE_LIMITS: AuthRateLimits = {
  registerAttempts: 20,
  registerWindowMs: 60 * 60 * 1000,
  loginAttempts: 10,
  loginWindowMs: 15 * 60 * 1000,
  passwordAttempts: 8,
  passwordWindowMs: 15 * 60 * 1000,
};

export interface AuthSuccess {
  ok: true;
  user: AuthUser;
  sessionToken?: string;
  expiresAt?: number;
  remember?: boolean;
}

export interface AuthFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
  retryAfterSeconds?: number;
}

export type AuthResult = AuthSuccess | AuthFailure;

export interface AuthServiceOptions {
  now?: () => number;
  limiter?: FixedWindowRateLimiter;
  rateLimits?: Partial<AuthRateLimits>;
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltValue, hashValue] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, 'base64url');
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const publicUser = (row: UserRow): AuthUser => ({ id: row.id, username: row.username });
const failure = (status: number, code: string, error: string, retryAfterSeconds?: number): AuthFailure =>
  ({ ok: false, status, code, error, retryAfterSeconds });

export class AuthService {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly limiter: FixedWindowRateLimiter;
  private readonly rateLimits: AuthRateLimits;

  constructor(databasePath: string, options: AuthServiceOptions = {}) {
    this.databasePath = databasePath;
    this.now = options.now ?? Date.now;
    this.limiter = options.limiter ?? new FixedWindowRateLimiter(this.now);
    this.rateLimits = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
    if (databasePath !== ':memory:') {
      const directory = dirname(databasePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { chmodSync(directory, 0o700); } catch { /* Windows may not support POSIX modes. */ }
    }
    this.db = new DatabaseSync(databasePath);
    if (databasePath !== ':memory:') {
      try { chmodSync(databasePath, 0o600); } catch { /* Windows may not support POSIX modes. */ }
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (databasePath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
    this.pruneExpired();
  }

  private migrate(): void {
    const versionRow = this.db.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    const version = Number(versionRow?.user_version ?? 0);
    if (version > 3) throw new Error(`账号数据库版本 ${version} 高于当前服务支持版本 3。`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        recovery_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS game_records (
        id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL,
        room_round INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        rules_version TEXT NOT NULL,
        initial_json TEXT NOT NULL,
        participants_json TEXT NOT NULL,
        moves_json TEXT NOT NULL,
        events_json TEXT NOT NULL,
        final_state_json TEXT NOT NULL,
        final_pieces_json TEXT NOT NULL,
        end_reason TEXT NOT NULL,
        move_count INTEGER NOT NULL,
        winner TEXT,
        UNIQUE(room_code, room_round)
      );
      CREATE INDEX IF NOT EXISTS game_records_ended ON game_records(ended_at DESC);
      CREATE TABLE IF NOT EXISTS game_participants (
        game_id TEXT NOT NULL REFERENCES game_records(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES auth_users(id) ON DELETE SET NULL,
        player_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        faction TEXT NOT NULL,
        result TEXT NOT NULL,
        eliminated INTEGER NOT NULL,
        PRIMARY KEY(game_id, player_id),
        UNIQUE(game_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS game_participants_user ON game_participants(user_id, game_id);
      PRAGMA user_version = 3;
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  rateLimit(key: string, limit: number, windowMs: number): AuthFailure | null {
    const result = this.limiter.hit(key, limit, windowMs);
    return result.ok ? null : failure(429, 'RATE_LIMITED', '操作过于频繁，请稍后再试。', result.retryAfterSeconds);
  }

  async register(usernameValue: unknown, passwordValue: unknown, remember: boolean, ip: string): Promise<AuthResult> {
    const limited = this.rateLimit(`register:${ip}`, this.rateLimits.registerAttempts, this.rateLimits.registerWindowMs);
    if (limited) return limited;
    const invalidUsername = usernameError(usernameValue);
    if (invalidUsername) return failure(400, 'INVALID_USERNAME', invalidUsername);
    const invalidPassword = passwordError(passwordValue);
    if (invalidPassword) return failure(400, 'INVALID_PASSWORD', invalidPassword);
    const username = normalizeUsername(usernameValue);
    const key = usernameKey(username);
    const password = passwordValue as string;
    if (this.findByUsernameKey(key)) return failure(409, 'USERNAME_TAKEN', '这个昵称已经有人使用，请换一个');
    const id = randomUUID(), passwordDigest = await passwordHash(password);
    const timestamp = this.now();
    try {
      this.db.prepare(`INSERT INTO auth_users
        (id, username, username_key, password_hash, recovery_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, username, key, passwordDigest, DISABLED_RECOVERY_HASH, timestamp, timestamp);
    } catch (error) {
      if (String(error).includes('UNIQUE')) return failure(409, 'USERNAME_TAKEN', '这个昵称已经有人使用，请换一个');
      throw error;
    }
    const user = { id, username }, session = this.createSession(id, remember);
    return { ok: true, user, ...session };
  }

  async login(usernameValue: unknown, passwordValue: unknown, remember: boolean, ip: string): Promise<AuthResult> {
    const key = usernameKey(usernameValue);
    const limited = this.rateLimit(`login:${ip}:${key || '-'}`, this.rateLimits.loginAttempts, this.rateLimits.loginWindowMs);
    if (limited) return limited;
    if (typeof passwordValue !== 'string') return failure(401, 'INVALID_CREDENTIALS', '昵称或密码不正确。');
    const row = key ? this.findByUsernameKey(key) : undefined;
    if (!row || !await passwordMatches(passwordValue, row.password_hash))
      return failure(401, 'INVALID_CREDENTIALS', '昵称或密码不正确。');
    this.limiter.reset(`login:${ip}:${key}`);
    return { ok: true, user: publicUser(row), ...this.createSession(row.id, remember) };
  }

  authenticate(token: string | null | undefined): AuthUser | null {
    if (!token) return null;
    const row = this.db.prepare(`SELECT u.*, s.expires_at
      FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
      WHERE s.token_hash = ?`).get(hashToken(token)) as unknown as SessionUserRow | undefined;
    if (!row) return null;
    if (row.expires_at <= this.now()) {
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
      return null;
    }
    return publicUser(row);
  }

  logout(token: string | null | undefined): void {
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  async changePassword(user: AuthUser, currentPasswordValue: unknown, newPasswordValue: unknown, remember: boolean): Promise<AuthResult> {
    const limited = this.rateLimit(`password:${user.id}`, this.rateLimits.passwordAttempts, this.rateLimits.passwordWindowMs);
    if (limited) return limited;
    const invalidPassword = passwordError(newPasswordValue);
    if (invalidPassword) return failure(400, 'INVALID_PASSWORD', invalidPassword);
    const row = this.findByUserId(user.id);
    if (!row || typeof currentPasswordValue !== 'string' || !await passwordMatches(currentPasswordValue, row.password_hash))
      return failure(401, 'INVALID_CURRENT_PASSWORD', '当前密码不正确。');
    const nextHash = await passwordHash(newPasswordValue as string), timestamp = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(nextHash, timestamp, user.id);
      this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.limiter.reset(`password:${user.id}`);
    return { ok: true, user: publicUser(row), ...this.createSession(user.id, remember) };
  }

  saveCompletedGame(record: ArchivedGameRecord): void {
    if (record.finalState.status !== 'finished' || record.endedAt < record.startedAt)
      throw new Error('只能保存已经结束且时间有效的历史对局。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT OR IGNORE INTO game_records
        (id, room_code, room_round, started_at, ended_at, rules_version, initial_json, participants_json,
         moves_json, events_json, final_state_json, final_pieces_json, end_reason, move_count, winner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(record.id, record.roomCode, record.round, record.startedAt, record.endedAt, record.rulesVersion,
          JSON.stringify(record.initialPieces), JSON.stringify(record.participants), JSON.stringify(record.moves),
          JSON.stringify(record.events), JSON.stringify(record.finalState), JSON.stringify(record.finalPieces),
          record.endReason, record.moveCount,
          record.finalState.winner);
      const stored = this.db.prepare('SELECT id FROM game_records WHERE room_code = ? AND room_round = ?')
        .get(record.roomCode, record.round) as unknown as { id: string } | undefined;
      if (!stored) throw new Error('历史对局唯一记录写入失败。');
      const insertParticipant = this.db.prepare(`INSERT OR IGNORE INTO game_participants
        (game_id, user_id, player_id, nickname, faction, result, eliminated) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const participant of record.participants) {
        insertParticipant.run(stored.id, participant.userId, participant.playerId, participant.nickname,
          participant.faction, participant.result, participant.eliminated ? 1 : 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recentGames(userId: string, limit = 5): RecentGameSummary[] {
    const rows = this.db.prepare(`SELECT g.*, p.faction AS self_faction, p.result AS self_result
      FROM game_records g JOIN game_participants p ON p.game_id = g.id
      WHERE p.user_id = ?
      ORDER BY g.ended_at DESC, g.id DESC
      LIMIT ?`).all(userId, Math.max(1, Math.min(5, limit))) as unknown as Array<GameRow & {
        self_faction: string;
        self_result: string;
      }>;
    return rows.map(row => {
      const participants = JSON.parse(row.participants_json) as ArchivedGameRecord['participants'];
      return {
        id: row.id,
        roomCode: row.room_code,
        endedAt: Number(row.ended_at),
        faction: row.self_faction as RecentGameSummary['faction'],
        result: row.self_result as RecentGameSummary['result'],
        opponents: participants.filter(participant => participant.faction !== row.self_faction)
          .map(participant => participant.nickname),
        moveCount: Number(row.move_count),
        endReason: row.end_reason,
      };
    });
  }

  gameForUser(userId: string, gameId: string): ArchivedGameRecord | null {
    const row = this.db.prepare(`SELECT g.* FROM game_records g
      JOIN game_participants p ON p.game_id = g.id
      WHERE g.id = ? AND p.user_id = ?`).get(gameId, userId) as unknown as GameRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      roomCode: row.room_code,
      round: Number(row.room_round),
      startedAt: Number(row.started_at),
      endedAt: Number(row.ended_at),
      rulesVersion: row.rules_version,
      initialPieces: JSON.parse(row.initial_json),
      participants: JSON.parse(row.participants_json),
      moves: JSON.parse(row.moves_json),
      events: JSON.parse(row.events_json),
      finalPieces: JSON.parse(row.final_pieces_json),
      finalState: JSON.parse(row.final_state_json),
      endReason: row.end_reason,
      moveCount: Number(row.move_count),
    };
  }

  revokeExpired(): void {
    this.pruneExpired();
  }

  private findByUsernameKey(key: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM auth_users WHERE username_key = ?').get(key) as unknown as UserRow | undefined;
  }

  private findByUserId(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM auth_users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  }

  private createSession(userId: string, remember: boolean): { sessionToken: string; expiresAt: number; remember: boolean } {
    const sessionToken = randomBytes(32).toString('base64url'), timestamp = this.now();
    const duration = remember ? REMEMBER_SESSION_SECONDS : SHORT_SESSION_SECONDS;
    const expiresAt = timestamp + duration * 1000;
    this.db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(sessionToken), userId, timestamp, expiresAt);
    return { sessionToken, expiresAt, remember };
  }

  private pruneExpired(): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(this.now());
    this.limiter.prune();
  }
}
