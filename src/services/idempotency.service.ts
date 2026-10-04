import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../config/db.js';
import { ApiError } from '../utils/errors.js';
import { withRetry } from '../utils/tx.js';

export interface IdempotentResult<T> {
  replayed: boolean;
  status: number;
  body: T;
}

interface StoredResponse<T> {
  scope: string;
  status: number;
  body: T;
}

/**
 * Anti double-submit multi POS (fase.md "Aturan wajib aplikasi" #2).
 *
 * Mekanisme (satu transaksi DB):
 *  1. `INSERT ... ON CONFLICT (key) DO NOTHING` sebagai "claim" idempotency key.
 *     - Row yang di-insert = kita yang/request pertama yang menjalankan logic.
 *     - Konflik = key sudah dipakai -> PostgreSQL menunggu transaksi Dareu selesai,
 *       sehingga response yang tersimpan pasti SUDAH COMMITTED (tidak ada race).
 *  2. Jalankan business logic (sales/payments) di transaksi yang sama.
 *  3. Simpan response sukses ke idempotency_keys, lalu COMMIT.
 *
 * Kalau business logic gagal (stok kurang, overpay, ...) seluruh transaksi
 * ROLLBACK termasuk key-nya -> client boleh retry dengan key yang sama setelah
 * memperbaiki request. Kalau sukses, retry dengan key sama = replay response.
 */
export async function runIdempotent<T>(
  scope: string,
  key: string,
  work: (client: PoolClient) => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  return withRetry(
    () =>
      withTransaction(async (client) => {
        const claim = await client.query<{ key: string }>(
          `INSERT INTO public.idempotency_keys (key, response)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO NOTHING
           RETURNING key`,
          [key, JSON.stringify({ scope, state: 'in_progress' })],
        );

        if (claim.rowCount === 0) {
          // Key sudah dipakai request sebelumnya -> cukup kembalikan response tersimpan.
          await client.query('ROLLBACK');
          return { replayed: true, ...(await readStored<T>(scope, key)) };
        }

        const result = await work(client);

        await client.query(`UPDATE public.idempotency_keys SET response = $2::jsonb WHERE key = $1`, [
          key,
          JSON.stringify({ scope, state: 'done', status: result.status, body: result.body }),
        ]);

        return { replayed: false, status: result.status, body: result.body };
      }),
    `idempotent:${scope}`,
  );
}

async function readStored<T>(scope: string, key: string): Promise<{ status: number; body: T }> {
  const res = await pool.query<{ response: StoredResponse<T> & { state?: string } }>(
    `SELECT response FROM public.idempotency_keys WHERE key = $1`,
    [key],
  );

  const stored = res.rows[0]?.response;
  if (!stored || stored.state !== 'done') {
    throw new ApiError('CONCURRENT_CONFLICT', 'Permintaan dengan Idempotency-Key yang sama sedang diproses, coba lagi');
  }
  if (stored.scope !== scope) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Idempotency-Key sudah dipakai pada endpoint ${stored.scope}, gunakan key baru untuk ${scope}`,
    );
  }

  return { status: stored.status, body: stored.body };
}

/** Housekeeping: hapus key lama (mis. > 24 jam) agar tabel tidak tumbuh. */
export async function purgeIdempotencyKeys(olderThanHours = 24): Promise<number> {
  const res = await pool.query(
    `DELETE FROM public.idempotency_keys WHERE created_at < now() - ($1 || ' hours')::interval`,
    [olderThanHours],
  );
  return res.rowCount ?? 0;
}
