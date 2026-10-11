import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { col, fn, literal, where } from 'sequelize';
import { roleOf } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { signToken, type AuthUser } from '../middleware/auth.js';
import { RefreshToken, UserAccount, sequelize, type UserRole } from '../models/index.js';

/**
 * Auth di atas Sequelize (MP-1).
 *
 * Perilaku & pesan error DISAMAKAN PERSIS dengan versi raw SQL lama
 * (`git show HEAD:src/services/auth.service.ts`), supaya `fe/` tidak melihat
 * perbedaan apa pun:
 *  - user tidak ada / password salah -> pesan sama ("Username atau password salah")
 *    + bcrypt dummy dijalankan agar waktu respons tidak membocorkan keberadaan user;
 *  - akun nonaktif -> "Akun nonaktif, hubungi owner";
 *  - refresh token dicabut/kedaluwarsa -> "Refresh token tidak valid, kedaluwarsa,
 *    atau sudah logout";
 *  - logout tanpa token aktif -> "Refresh token tidak ditemukan / sudah dicabut".
 *
 * Perbedaan yang disengaja (rotasi refresh token, tasklist MP-1.5): setiap
 * `POST /auth/refresh` mencabut token lama dan menerbitkan yang baru. Field baru
 * `refresh_token` pada response bersifat additive dan sudah didukung FE
 * (`fe/lib/api/auth_api.dart`: memakai `refresh_token` baru kalau ada).
 */

export interface LoginResult {
  token: string;
  refresh_token: string;
  role: UserRole;
  user: { id: number; username: string; full_name: string; role: UserRole };
}

export interface RefreshResult {
  token: string;
  refresh_token: string;
  user: { id: number; username: string; full_name: string; role: UserRole };
}

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7);

/** Password hash user dipakai per-akun (bcrypt dummy hanya untuk user tak ada). */
const DUMMY_BCRYPT_HASH = '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function toAuthUser(user: UserAccount): AuthUser {
  return {
    id: user.id,
    username: user.username ?? '',
    full_name: user.full_name ?? user.username ?? '',
    role: user.role === 'OWNER' || user.role === 'KASIR' ? user.role : roleOf(user.username ?? ''),
  };
}

function toPublicUser(user: AuthUser): { id: number; username: string; full_name: string; role: UserRole } {
  return { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
}

async function findByUsername(username: string): Promise<UserAccount | null> {
  // Sama dengan SQL lama: `WHERE lower(username) = lower($1) ORDER BY id LIMIT 1`.
  return UserAccount.findOne({
    where: where(fn('lower', col('username')), username.trim().toLowerCase()),
    order: [['id', 'ASC']],
  });
}

/**
 * Terbitkan refresh token baru (7 hari). `expires_at` dihitung oleh PostgreSQL
 * (`now()`) supaya jam server tetap sumber kebenaran waktu absolut (fase.md).
 */
async function issueRefreshToken(userId: number): Promise<string> {
  const token = crypto.randomBytes(48).toString('hex');
  await RefreshToken.create({
    token_hash: hashToken(token),
    user_id: userId,
    expires_at: literal(`now() + interval '${REFRESH_TTL_DAYS} days'`) as unknown as Date,
  });
  return token;
}

/** Password user_account disimpan sebagai hash bcrypt. Role dibaca dari kolom DB (fallback .env). */
export async function login(username: string, password: string): Promise<LoginResult> {
  const user = await findByUsername(username);

  // Pesan sengaja sama untuk user tidak ada / password salah (anti user enumeration).
  const invalid = new ApiError('UNAUTHORIZED', 'Username atau password salah');

  if (!user) {
    // Tetap habiskan waktu dengan bcrypt dummy supaya respons tidak membocorkan keberadaan user.
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
    throw invalid;
  }
  if (user.is_active === false) {
    throw new ApiError('UNAUTHORIZED', 'Akun nonaktif, hubungi owner');
  }
  if (!(await user.verifyPassword(password))) throw invalid;

  const authUser = toAuthUser(user);
  const refreshToken = await issueRefreshToken(user.id);

  return {
    token: signToken(authUser),
    refresh_token: refreshToken,
    role: authUser.role,
    user: toPublicUser(authUser),
  };
}

/* ==================== refresh token (rotasi) ==================== */

/**
 * Tukar refresh token -> JWT baru + refresh token baru (rotasi).
 * Token yang dicabut/kedaluwarsa ditolak dengan 401.
 */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  const stored = await RefreshToken.findByPk(hashToken(refreshToken), {
    include: [{ model: UserAccount, as: 'user' }],
  });

  const user = stored?.user;
  if (!stored || !user || !stored.isUsable) {
    throw new ApiError('UNAUTHORIZED', 'Refresh token tidak valid, kedaluwarsa, atau sudah logout');
  }

  const authUser = toAuthUser(user as UserAccount);
  const nextRefreshToken = await sequelize.transaction(async (transaction) => {
    // Rotasi: cabut token lama DULU, baru terbitkan yang baru (anti pemakaian ulang).
    const [revoked] = await RefreshToken.update({ revoked_at: new Date() }, {
      where: { token_hash: stored.token_hash, revoked_at: null },
      transaction,
    });
    if (revoked !== 1) {
      throw new ApiError('UNAUTHORIZED', 'Refresh token tidak valid, kedaluwarsa, atau sudah logout');
    }
    const token = crypto.randomBytes(48).toString('hex');
    await RefreshToken.create(
      {
        token_hash: hashToken(token),
        user_id: authUser.id,
        expires_at: literal(`now() + interval '${REFRESH_TTL_DAYS} days'`) as unknown as Date,
      },
      { transaction },
    );
    return token;
  });

  return {
    token: signToken(authUser),
    refresh_token: nextRefreshToken,
    user: toPublicUser(authUser),
  };
}

/** Logout: cabut refresh token (JWT tetap valid sampai expiry pendeknya). */
export async function logout(refreshToken: string): Promise<void> {
  const [revoked] = await RefreshToken.update(
    { revoked_at: new Date() },
    { where: { token_hash: hashToken(refreshToken), revoked_at: null } },
  );
  if (revoked === 0) {
    throw new ApiError('UNAUTHORIZED', 'Refresh token tidak ditemukan / sudah dicabut');
  }
}

export async function me(userId: number): Promise<{
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
} | null> {
  const user = await UserAccount.findByPk(userId);
  if (!user) return null;
  return toPublicUser(toAuthUser(user));
}