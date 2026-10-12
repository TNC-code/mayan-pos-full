import { QueryTypes } from 'sequelize';
import type { Migration } from '../db/migrator.js';

/**
 * HARDENING ORDER BOOK (MP-9.2) — satu penjualan hanya boleh menutup SATU order book.
 *
 * Latar (backlog MP-7 yang ditutup di sini): `POST /order-books/{id}/convert`
 * hanya memeriksa status order yang memanggil, jadi dua order book berbeda bisa
 * menunjuk `sale_id` yang sama (terbukti di DB dev: ORD-...-003 dan ORD-...-004
 * sama-sama DONE ke INV-...-194). Efeknya satu penjualan terhitung memenuhi dua
 * order, jadi rekap order book thruai.
 *
 * Dua lapis penjaga (additive, tidak mengubah bentuk response):
 *   1. migration ini — UNIQUE PARTIAL di DB, penjaga terakhir & anti-race;
 *   2. guard app-layer di `order-book.service.convertOrderBook` — 409
 *      `ORDER_ALREADY_DONE` dengan pesan jelas (bukan 500 dari error unique).
 *
 * Index PARTIAL (bukan unique penuh) karena sebagian besar baris `sale_id IS NULL`
 * (order yang belum di-convert) dan NULL memang boleh berulang di PostgreSQL.
 *
 * `idx_order_books_sale` (index biasa pada kolom yang sama) jadi mubazir setelah
 * ini -> di-drop; `down()` mengembalikannya.
 */

const INDEX_NAME = 'uq_order_books_sale_id';

/**
 * Data warisan: satu `sale_id` yang dipakai lebih dari satu order book (sisa smoke
 * MP-7 sebelum migration ini). Baris paling lama (id terkecil) tetap ter-link;
 * sisanya dilepas link-nya dan — kalau tadinya DONE — dikembalikan ke PROCESSING
 * supaya invariant "order DONE selalu punya sale_id" tetap berlaku. Baris TIDAK
 * dihapus: hanya `sale_id` yang dilepas, dan jejaknya ditulis ke `note`.
 */
const DEDUPE_SQL = `
WITH dupes AS (
    SELECT sale_id, MIN(id) AS keep_id
      FROM public.order_books
     WHERE sale_id IS NOT NULL
     GROUP BY sale_id
    HAVING COUNT(*) > 1
), detached AS (
    UPDATE public.order_books ob
       SET sale_id    = NULL,
           status     = CASE WHEN ob.status = 'DONE' THEN 'PROCESSING' ELSE ob.status END,
           note       = COALESCE(ob.note, '') || ' | [MP-9] sale_id #' || ob.sale_id || ' dilepas: sudah dipakai order book lain (uniq sale_id)',
           updated_at = now()
      FROM dupes d
     WHERE ob.sale_id = d.sale_id
       AND ob.id <> d.keep_id
    RETURNING ob.id, ob.order_no, ob.status
)
SELECT * FROM detached ORDER BY id`;

export const up: Migration['up'] = async ({ context }) => {
  await context.transaction(async (transaction) => {
    const detached = (await context.query(DEDUPE_SQL, {
      type: QueryTypes.SELECT,
      transaction,
    })) as unknown as Array<{ id: string; order_no: string; status: string }>;

    for (const row of detached) {
      console.log(
        `[migrate 202610120001] order book #${row.id} (${row.order_no}) -> ${row.status}, sale_id dilepas (duplikat warisan)`,
      );
    }

    await context.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME} ON public.order_books (sale_id) WHERE sale_id IS NOT NULL`,
      { transaction },
    );
    // Index lama kolom yang sama -> mubazir (pencarian `sale_id = X` tetap memakai yang partial unique).
    await context.query('DROP INDEX IF EXISTS public.idx_order_books_sale', { transaction });
  });
};

export const down: Migration['down'] = async ({ context }) => {
  await context.transaction(async (transaction) => {
    await context.query(`DROP INDEX IF EXISTS public.${INDEX_NAME}`, { transaction });
    // Kembalikan index non-unique seperti pada baseline.
    await context.query('CREATE INDEX IF NOT EXISTS idx_order_books_sale ON public.order_books (sale_id)', {
      transaction,
    });
  });
};