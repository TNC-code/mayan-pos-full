import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize, closeSequelize } from '../src/db/sequelize.js';

/**
 * helper SQL untuk skrip di `scripts/` (MP-9, retirement raw SQL).
 *
 * Sebelumnya skrip-skrip ini memakai `pg.Pool` dari `src/config/db.ts` yang sudah
 * dihapus. Pool itu sekarang dibangun di atas instance Sequelize yang sama dengan
 * aplikasi (`src/db/sequelize.ts`) — jadi kredensial, SSL, `statement_timeout`, dan
 * parser angka (numeric/int8 -> number) identik dengan jalur API.
 *
 * Bentuk API sengaja dipertahankan `{ rows }` supaya bodies skrip yang sudah
 * teruji (SQL-nya tidak berubah) tidak perlu ditulis ulang.
 */
export interface QueryResultLike<T> {
  rows: T[];
  /** Jumlah baris terpengaruh; `null` bila tidak dilaporkan driver. */
  rowCount: number | null;
}

/** `true` untuk statement yang mengembalikan baris (SELECT/WITH/TABLE). */
const RETURNS_ROWS = /^\s*(select|with|table)\b/i;

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  options: { transaction?: Transaction } = {},
): Promise<QueryResultLike<T>> {
  if (!RETURNS_ROWS.test(text)) {
    const [result, meta] = await sequelize.query(text, { bind: params, ...options });
    const rowCount = typeof result === 'number' ? result : ((meta as { rowCount?: number } | null)?.rowCount ?? null);
    return { rows: [], rowCount };
  }
  const rows = (await sequelize.query(text, {
    bind: params,
    type: QueryTypes.SELECT,
    ...options,
  })) as unknown as T[];
  return { rows, rowCount: rows.length };
}

/** Tutup koneksi (pengganti `closePool` lama). */
export const closeDb = closeSequelize;