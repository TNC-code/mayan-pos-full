import type { Transaction } from 'sequelize';
import { ApiError } from './errors.js';
import { isRetryableDbError } from './db-errors.js';
import { sequelize } from '../db/sequelize.js';

const MAX_ATTEMPTS = 3;

/**
 * Retry policy (fase.md): HANYA retry untuk error koneksi/serialisasi.
 * Error business (stok kurang, harga < beli, overpay) TIDAK di-retry.
 * Aman untuk endpoint idempotent karena percobaan yang gagal selalu ROLLBACK.
 */
export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbError(err)) throw err;
      if (attempt === MAX_ATTEMPTS) break;
      const backoff = 25 * attempt;
      console.warn(`[retry] ${label} percobaan ${attempt} gagal (${(err as Error).message}), ulangi dalam ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/**
 * Transaksi Sequelize + retry policy (MP-3; satu-satunya pembungkus transaksi
 * sejak MP-9 — `withTx` versi `pg.Pool` beserta `config/db.ts` sudah dihapus).
 *
 * `READ COMMITTED` (default PostgreSQL) + `lock: t.LOCK.UPDATE` saat transaksi
 * memang butuh baris terkunci — kebenaran tetap datang dari row lock, bukan
 * dari menaikkan isolation level (plan §D5). Retry hanya untuk error
 * serialisasi/deadlock/koneksi (`isRetryableDbError`), jadi percobaan ulang
 * selalu punya transaksi baru (tidak ada "continued after rollback").
 */
export function withOrmTx<T>(fn: (transaction: Transaction) => Promise<T>, label = 'tx'): Promise<T> {
  return withRetry(() => sequelize.transaction(fn), label);
}

/** Pembulatan uang ke 2 desimal (half-up) agar konsisten dengan numeric(14,2). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Pembulatan qty ke 3 desimal (numeric(14,3)). */
export function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

export function asInt(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError('VALIDATION_ERROR', `Path parameter ${name} harus bilangan bulat positif`);
  }
  return n;
}
