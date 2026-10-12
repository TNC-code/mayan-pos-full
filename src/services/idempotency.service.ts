import type { Transaction } from 'sequelize';
import { pool } from '../config/db.js';
import { ApiError } from '../utils/errors.js';
import { withOrmTx, withRetry } from '../utils/tx.js';
import { IdempotencyKey } from '../models/index.js';

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
 *
 * CATATAN MP-6: service yang masih raw SQL tinggal `order-book.service.ts`
 * (MP-7), dan path raw itu sudah DIHAPUS (MP-6 memindahkan supplier-return ke
 * ORM) — dari MP-7 seterusnya semua idempotency lewat `runOrmIdempotent` di
 * bawah. Format payload `idempotency_keys.response` & nama tabelnya SAMA, jadi
 * key yang dibuat versi lama (`{scope, state, status, body}`) tetap bisa
 * di-replay tanpa migrasi data.
 */

/**
 * Idempotency untuk service di atas Sequelize (dipakai sejak MP-4) — payload,
 * tabel, dan retry policy identik dengan jalur raw SQL yang dulu ada di sini:
 *
 *  1. Klaim key via `IdempotencyKey.findCreateFind({ where: { key }, defaults })`.
 *     Di dialect postgres Sequelize memakai `INSERT ... ON CONFLICT DO NOTHING
 *     RETURNING *` untuk langkah INSERT-nya: kalau key sudah dipakai transaksi
 *     lain, PostgreSQL menunggu transaksi itu commit sebelum balasan INSERT
 *     keluar — jadi response yang dibaca di bawah sudah pasti committed (tidak
 *     ada race "replay dapat body setengah jadi"). Row `created: false` = key sudah
 *     dipakai request lain.
 *  2. `work(transaction)` — logic bisnis dalam transaksi yang sama, jadi
 *     key ikut ROLLBACK saat logic gagal (retry dengan key sama diizinkan).
 *  3. Simpan response sukses ke `idempotency_keys.response` sebelum COMMIT.
 *
 * Retry policy (`withRetry`): hanya error koneksi/serialisasi/deadlock.
 */
export async function runOrmIdempotent<T>(
  scope: string,
  key: string,
  work: (transaction: Transaction) => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  return withRetry(
    () =>
      withOrmTx(async (transaction) => {
        const [claimed, created] = await IdempotencyKey.findCreateFind({
          where: { key },
          defaults: { key, response: { scope, state: 'in_progress' } },
          transaction,
        });

        if (!created) {
          // Key sudah dipakai request sebelumnya -> kembalikan response tersimpan.
          return { replayed: true, ...(await readStoredOrm<T>(transaction, scope, key)) };
        }

        const result = await work(transaction);

        await claimed.update(
          { response: { scope, state: 'done', status: result.status, body: result.body } },
          { transaction },
        );

        return { replayed: false, status: result.status, body: result.body };
      }),
    `idempotent:${scope}`,
  );
}

/** Baca response tersimpan di dalam transaksi (baris claimant sudah committed). */
async function readStoredOrm<T>(
  transaction: Transaction,
  scope: string,
  key: string,
): Promise<{ status: number; body: T }> {
  const row = await IdempotencyKey.findByPk(key, { transaction });
  const stored = row?.response as (StoredResponse<T> & { state?: string }) | undefined;
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

/**
 * Housekeeping: hapus key lama (mis. > 24 jam) agar tabel tidak tumbuh.
 * Masih jalur pool (dipanggil dari luar transaksi bisnis, tidak butuh ORM).
 */
export async function purgeIdempotencyKeys(olderThanHours = 24): Promise<number> {
  const res = await pool.query(
    `DELETE FROM public.idempotency_keys WHERE created_at < now() - ($1 || ' hours')::interval`,
    [olderThanHours],
  );
  return res.rowCount ?? 0;
}
