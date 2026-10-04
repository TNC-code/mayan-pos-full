import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { pool } from '../config/db.js';
import { roleOf } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { signToken, type AuthUser } from '../middleware/auth.js';

export interface LoginResult {
  token: string;
  refresh_token: string;
  role: 'OWNER' | 'KASIR';
  user: { id: number; username: string; full_name: string; role: 'OWNER' | 'KASIR' };
}

/** Password user_account disimpan sebagai hash bcrypt. Role dibaca dari kolom DB (fallback .env). */
export async function login(username: string, password: string): Promise<LoginResult> {
  const res = await pool.query<{
    id: number;
    username: string;
    password: string;
    full_name: string | null;
    is_active: boolean | null;
    role: string | null;
  }>(
    `SELECT id, username, password, full_name, is_active, role
       FROM user_account
      WHERE lower(username) = lower($1)
      LIMIT 1`,
    [username],
  );

  const row = res.rows[0];
  // Pesan sengaja sama untuk user tidak ada / password salah (anti user enumeration).
  const invalid = new ApiError('UNAUTHORIZED', 'Username atau password salah');

  if (!row) {
    // Tetap habiskan waktu dengan bcrypt dummy supaya respons tidak membocorkan keberadaan user.
    await bcrypt.compare(password, '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    throw invalid;
  }
  if (row.is_active === false) {
    throw new ApiError('UNAUTHORIZED', 'Akun nonaktif, hubungi owner');
  }

  const ok = await bcrypt.compare(password, row.password ?? '');
  if (!ok) throw invalid;

  const user: AuthUser = {
    id: row.id,
    username: row.username,
    full_name: row.full_name ?? row.username,
    role: row.role === 'OWNER' || row.role === 'KASIR' ? row.role : roleOf(row.username),
  };

  const refreshToken = await issueRefreshToken(user.id);

  return {
    token: signToken(user),
    refresh_token: refreshToken,
    role: user.role,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
  };
}

/* ==================== refresh token (P1) ==================== */

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7);

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueRefreshToken(userId: number): Promise<string> {
  const token = crypto.randomBytes(48).toString('hex');
  await pool.query(
    `INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [hashToken(token), userId, REFRESH_TTL_DAYS],
  );
  return token;
}

/** Tukar refresh token -> JWT baru. Token yang dicabut/kedaluwarsa ditolak. */
export async function refreshAccessToken(refreshToken: string): Promise<{ token: string; user: AuthUser }> {
  const res = await pool.query<{
    rt_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    id: number;
    username: string;
    full_name: string | null;
    role: string | null;
  }>(
    `SELECT rt.token_hash AS rt_id, rt.expires_at, rt.revoked_at,
            u.id, u.username, u.full_name, u.role, u.is_active
       FROM refresh_tokens rt
       JOIN user_account u ON u.id = rt.user_id
      WHERE rt.token_hash = $1`,
    [hashToken(refreshToken)],
  );

  const row = res.rows[0];
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
    throw new ApiError('UNAUTHORIZED', 'Refresh token tidak valid, kedaluwarsa, atau sudah logout');
  }

  const user: AuthUser = {
    id: row.id,
    username: row.username,
    full_name: row.full_name ?? row.username,
    role: row.role === 'OWNER' || row.role === 'KASIR' ? row.role : roleOf(row.username),
  };
  return { token: signToken(user), user };
}

/** Logout: cabut refresh token (JWT tetap valid sampai expiry pendeknya). */
export async function logout(refreshToken: string): Promise<void> {
  const res = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(refreshToken)],
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new ApiError('UNAUTHORIZED', 'Refresh token tidak ditemukan / sudah dicabut');
  }
}

export async function me(userId: number): Promise<{ id: number; username: string; full_name: string; role: string } | null> {
  const res = await pool.query<{ id: number; username: string; full_name: string | null; role: string | null }>(
    `SELECT id, username, full_name, role FROM user_account WHERE id = $1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name ?? row.username,
    role: row.role === 'OWNER' || row.role === 'KASIR' ? row.role : roleOf(row.username),
  };
}
