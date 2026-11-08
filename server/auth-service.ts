import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  REMEMBER_SESSION_SECONDS,
  SHORT_SESSION_SECONDS,
  passwordError,
  recoveryCodeError,
  recoveryCodeKey,
  usernameError,
  usernameKey,
  normalizeUsername,
} from '../src/auth.ts';
import type { AuthUser } from '../src/auth.ts';
import { FixedWindowRateLimiter } from './rate-limit.ts';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const RATE_WINDOW_MS = 15 * 60 * 1000;

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

export interface AuthSuccess {
  ok: true;
  user: AuthUser;
  sessionToken?: string;
  expiresAt?: number;
  remember?: boolean;
  recoveryCode?: string;
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
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeRecoveryCode(value: string): string {
  const raw = recoveryCodeKey(value);
  return raw.match(/.{1,4}/g)?.join('-') ?? raw;
}

function generateRecoveryCode(): string {
  return `TK-${normalizeRecoveryCode(randomBytes(20).toString('hex').toUpperCase())}`;
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

const recoveryHash = (value: string): string => createHash('sha256').update(recoveryCodeKey(value)).digest('hex');
const recoveryHashMatches = (value: string, stored: string): boolean => {
  const actual = Buffer.from(recoveryHash(value), 'hex'), expected = Buffer.from(stored, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const publicUser = (row: UserRow): AuthUser => ({ id: row.id, username: row.username });
const failure = (status: number, code: string, error: string, retryAfterSeconds?: number): AuthFailure =>
  ({ ok: false, status, code, error, retryAfterSeconds });

export class AuthService {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly limiter: FixedWindowRateLimiter;

  constructor(databasePath: string, options: AuthServiceOptions = {}) {
    this.databasePath = databasePath;
    this.now = options.now ?? Date.now;
    this.limiter = options.limiter ?? new FixedWindowRateLimiter(this.now);
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
      PRAGMA user_version = 1;
    `);
    this.pruneExpired();
  }

  close(): void {
    this.db.close();
  }

  rateLimit(key: string, limit: number): AuthFailure | null {
    const result = this.limiter.hit(key, limit, RATE_WINDOW_MS);
    return result.ok ? null : failure(429, 'RATE_LIMITED', '操作过于频繁，请稍后再试。', result.retryAfterSeconds);
  }

  async register(usernameValue: unknown, passwordValue: unknown, remember: boolean, ip: string): Promise<AuthResult> {
    const limited = this.rateLimit(`register:${ip}`, 6);
    if (limited) return limited;
    const invalidUsername = usernameError(usernameValue);
    if (invalidUsername) return failure(400, 'INVALID_USERNAME', invalidUsername);
    const invalidPassword = passwordError(passwordValue);
    if (invalidPassword) return failure(400, 'INVALID_PASSWORD', invalidPassword);
    const username = normalizeUsername(usernameValue);
    const key = usernameKey(username);
    const password = passwordValue as string;
    if (this.findByUsernameKey(key)) return failure(409, 'USERNAME_TAKEN', '这个昵称已经有人使用，请换一个');
    const id = randomUUID(), passwordDigest = await passwordHash(password), recoveryCode = generateRecoveryCode();
    const timestamp = this.now();
    try {
      this.db.prepare(`INSERT INTO auth_users
        (id, username, username_key, password_hash, recovery_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, username, key, passwordDigest, recoveryHash(recoveryCode), timestamp, timestamp);
    } catch (error) {
      if (String(error).includes('UNIQUE')) return failure(409, 'USERNAME_TAKEN', '这个昵称已经有人使用，请换一个');
      throw error;
    }
    this.limiter.reset(`register:${ip}`);
    const user = { id, username }, session = this.createSession(id, remember);
    return { ok: true, user, ...session, recoveryCode };
  }

  async login(usernameValue: unknown, passwordValue: unknown, remember: boolean, ip: string): Promise<AuthResult> {
    const key = usernameKey(usernameValue);
    const limited = this.rateLimit(`login:${ip}:${key || '-'}`, 10);
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
    const limited = this.rateLimit(`password:${user.id}`, 8);
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

  async regenerateRecovery(user: AuthUser, passwordValue: unknown): Promise<AuthResult> {
    const limited = this.rateLimit(`recovery:${user.id}`, 5);
    if (limited) return limited;
    const row = this.findByUserId(user.id);
    if (!row || typeof passwordValue !== 'string' || !await passwordMatches(passwordValue, row.password_hash))
      return failure(401, 'INVALID_CURRENT_PASSWORD', '当前密码不正确。');
    const recoveryCode = generateRecoveryCode();
    this.db.prepare('UPDATE auth_users SET recovery_hash = ?, updated_at = ? WHERE id = ?')
      .run(recoveryHash(recoveryCode), this.now(), user.id);
    this.limiter.reset(`recovery:${user.id}`);
    return { ok: true, user: publicUser(row), recoveryCode };
  }

  async resetWithRecovery(usernameValue: unknown, recoveryValue: unknown, newPasswordValue: unknown,
    remember: boolean, ip: string): Promise<AuthResult> {
    const key = usernameKey(usernameValue);
    const limited = this.rateLimit(`reset:${ip}:${key || '-'}`, 5);
    if (limited) return limited;
    const invalidPassword = passwordError(newPasswordValue);
    if (invalidPassword) return failure(400, 'INVALID_PASSWORD', invalidPassword);
    const invalidRecovery = recoveryCodeError(recoveryValue);
    if (invalidRecovery) return failure(400, 'INVALID_RECOVERY_CODE', invalidRecovery);
    const row = key ? this.findByUsernameKey(key) : undefined;
    if (!row || !recoveryHashMatches(recoveryValue as string, row.recovery_hash))
      return failure(401, 'INVALID_RECOVERY', '昵称或恢复码不正确。');
    const nextPassword = await passwordHash(newPasswordValue as string), recoveryCode = generateRecoveryCode();
    const timestamp = this.now(), sessionToken = randomBytes(32).toString('base64url');
    const session = { sessionToken, expiresAt: timestamp + (remember ? REMEMBER_SESSION_SECONDS : SHORT_SESSION_SECONDS) * 1000, remember };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.db.prepare(`UPDATE auth_users
        SET password_hash = ?, recovery_hash = ?, updated_at = ?
        WHERE id = ? AND recovery_hash = ?`)
        .run(nextPassword, recoveryHash(recoveryCode), timestamp, row.id, row.recovery_hash);
      if (updated.changes !== 1) {
        this.db.exec('ROLLBACK');
        return failure(401, 'INVALID_RECOVERY', '昵称或恢复码不正确。');
      }
      this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(row.id);
      this.db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(hashToken(sessionToken), row.id, timestamp, session.expiresAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.limiter.reset(`reset:${ip}:${key}`);
    return { ok: true, user: publicUser(row), ...session, recoveryCode };
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
