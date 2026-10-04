import { closePool, pool } from '../src/config/db.js';

/**
 * P0: tandai data uji (e2e/concurrency) agar TIDAK mencemari laporan produksi.
 * Aturan: sale yang item-nya memakai produk nonaktif / sku TEST-* / UJI* dianggap uji,
 * KECUALI sale di daftar keep (transaksi nyata).
 * Endpoint list/report otomatis mengecualikan is_test=true (param include_test=true untuk melihat).
 */
const KEEP_SALE_IDS = (process.env.KEEP_SALE_IDS ?? '1,149')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

async function main(): Promise<void> {
  const res = await pool.query(
    `UPDATE sales SET is_test = true
      WHERE is_test = false
        AND id <> ALL($1::int[])
        AND EXISTS (
          SELECT 1 FROM sale_items si
            JOIN product p ON p.id = si.product_id
           WHERE si.sale_id = sales.id
             AND (p.is_active = false OR p.sku ILIKE 'TEST-%' OR p.sku ILIKE 'UJI%')
        )`,
    [KEEP_SALE_IDS],
  );
  console.log(`[mark-test-data] ${res.rowCount} sale ditandai is_test=true (keep: ${KEEP_SALE_IDS.join(', ')})`);

  const remaining = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM sales WHERE is_test = false`,
  );
  console.log(`[mark-test-data] sale produksi tersisa: ${remaining.rows[0]?.n ?? 0}`);
}

main()
  .catch((err) => {
    console.error('[mark-test-data] GAGAL:', err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
