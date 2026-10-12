import { closeDb, query as sql } from './db.js';
import { env } from '../src/config/env.js';

/**
 * P0: tandai data uji (e2e/concurrency/UC) agar TIDAK mencemari laporan produksi.
 *
 * Aturan sale (T9): sale yang item-nya memakai produk nonaktif / sku berprefiks uji
 * (`TEST-%` dari e2e & skrip UC, `UJI%` dari concurrency, `TST-%` dari skrip UC-B T3,
 * `HTTPR%` dari uji HTTP) dianggap uji, KECUALI sale di daftar keep (transaksi nyata).
 * Prefiks `TST-%`/`HTTPR%` ditambahkan di T9 karena produknya dibuat skrip T3/T4 dan tidak
 * pernah dinonaktifkan, sehingga sale-nya dulu lolos dari predikat lama.
 *
 * Retur distributor (baru, migration 0008): `supplier_returns.is_test`, dibaca `pnlReport`
 * (kolom `refund_distributor` dikecualikan default, `?include_test=true` untuk melihat).
 * Tiga predikat digabung (OR) - masing-masing menutup celah yang lain:
 *  1. `supplier_name ILIKE 'TEST%'`          -> retur uji e2e UC-B.
 *  2. punya opex write-off yang sudah `is_test` -> retur uji T3/T4 yang statusnya WRITTEN_OFF.
 *  3. item-nya memakai produk uji             -> satu-satunya Predicate yang menutup retur uji
 *     berstatus PENDING/REFUNDED milik T3/T4 (supplier_name 'DISTRIBUTOR UJI'/'DIST HTTP',
 *     tidak punya opex sama sekali). Tanpa ini `refund_distributor` tetap tercemar.
 *
 * Opex (migration 0007): `operational_expenses.is_test`, dibaca `listExpenses` (default
 * disembunyikan, `?include_test=true`) dan `pnlReport`. Dua sumber opex uji:
 *  1. opex manual dari skrip uji - `POST /expenses` tidak menerima `is_test` (field itu hanya
 *     untuk harness internal), jadi tidak ada di sini.
 *  2. opex otomatis write-off retur distributor (`source='SUPPLIER_RETURN'`, ter-link ke
 *     `supplier_returns`). Di-flag lewat produk uji di balik item retur; kalau tidak ada yang
 *     terdeteksi, jatuh ke fallback konservatif: seluruh opex write-off yang dibuat hari ini
 *     (TZ bisnis) ikut ditandai.
 */
const KEEP_SALE_IDS = (process.env.KEEP_SALE_IDS ?? '1,149')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

/** Aturan produk uji untuk pemrosesan sale (T9: + TST-%, HTTPR%). */
const SALE_TEST_PREDICATE = `(p.is_active = false OR p.sku ILIKE 'TEST-%' OR p.sku ILIKE 'UJI%' OR p.sku ILIKE 'TST-%' OR p.sku ILIKE 'HTTPR%')`;

/** Produk uji yang lebih luas, hanya untuk penelusuran opex write-off retur distributor. */
const SUPPLIER_RETURN_TEST_PREDICATE = `(p.is_active = false OR p.sku ILIKE 'TEST-%' OR p.sku ILIKE 'UJI%' OR p.sku ILIKE 'TST-%' OR p.sku ILIKE 'HTTPR%')`;

/**
 * Retur distributor uji. Tiga predikat OR (lihat catatan di atas).
 * Dilaporkan per return_no supaya hasilnya bisa diaudit.
 */
async function markSupplierReturns(): Promise<number> {
  const res = await sql<{ id: number; return_no: string; supplier_name: string; status: string; amount: string | null }>(
    `UPDATE supplier_returns r SET is_test = true
      WHERE r.is_test = false
        AND (
             r.supplier_name ILIKE 'TEST%'
          OR r.id IN (SELECT supplier_return_id FROM operational_expenses WHERE is_test = true)
          OR EXISTS (
            SELECT 1
              FROM supplier_return_items i
              JOIN product p ON p.id = i.product_id
             WHERE i.return_id = r.id AND ${SUPPLIER_RETURN_TEST_PREDICATE}
          )
        )
      RETURNING r.id, r.return_no, r.supplier_name, r.status, r.refunded_amount`,
  );
  for (const row of res.rows) {
    console.log(
      `  - retur #${row.id} ${row.return_no} "${row.supplier_name}" ${row.status}` +
        (row.amount ? ` Rp${row.amount}` : ''),
    );
  }
  return res.rowCount ?? 0;
}

/** Opex write-off uji yang terdeteksi lewat produk uji di balik retur distributor. */
async function markOpexFromTestSupplierReturns(): Promise<number> {
  const res = await sql<{ id: number; amount: string; return_no: string }>(
    `UPDATE operational_expenses e SET is_test = true
      WHERE e.is_test = false
        AND e.source = 'SUPPLIER_RETURN'
        AND e.supplier_return_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM supplier_returns r
            JOIN supplier_return_items i ON i.return_id = r.id
            JOIN product p ON p.id = i.product_id
           WHERE r.id = e.supplier_return_id AND ${SUPPLIER_RETURN_TEST_PREDICATE}
        )
      RETURNING e.id, e.amount,
        (SELECT r2.return_no FROM supplier_returns r2 WHERE r2.id = e.supplier_return_id) AS return_no`,
  );
  for (const row of res.rows) {
    console.log(`  - opex #${row.id} Rp${row.amount} dari retur ${row.return_no}`);
  }
  return res.rowCount ?? 0;
}

/** Fallback konservatif: opex write-off yang dibuat hari ini (tidak ada jejak produk uji). */
async function markOpexWriteOffToday(): Promise<number> {
  const res = await sql<{ id: number; amount: string; created_at: string }>(
    `UPDATE operational_expenses e SET is_test = true
      WHERE e.is_test = false
        AND e.source = 'SUPPLIER_RETURN'
        AND e.category = 'BARANG_RUSAK'
        AND (e.created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
      RETURNING e.id, e.amount, e.created_at`,
    [env.businessTz],
  );
  for (const row of res.rows) {
    console.log(`  - opex #${row.id} Rp${row.amount} (write-off ${String(row.created_at).slice(0, 19).replace('T', ' ')})`);
  }
  return res.rowCount ?? 0;
}

/**
 * Opex manual yang sengaja dibuat skrip uji dengan kategori berprefiks `TEST`
 * (skenario RBAC `POST /expenses` di e2e.sh). Kategori opex produksi tidak pernah
 * diawali TEST, jadi aturannya sempit dan deterministik.
 */
async function markManualTestExpenses(): Promise<number> {
  const res = await sql<{ id: number; amount: string; category: string }>(
    `UPDATE operational_expenses e SET is_test = true
      WHERE e.is_test = false
        AND e.source = 'MANUAL'
        AND e.category ILIKE 'TEST%'
      RETURNING e.id, e.amount, e.category`,
  );
  for (const row of res.rows) {
    console.log(`  - opex #${row.id} Rp${row.amount} (kategori ${row.category})`);
  }
  return res.rowCount ?? 0;
}

async function main(): Promise<void> {
  const res = await sql(
    `UPDATE sales SET is_test = true
      WHERE is_test = false
        AND id <> ALL($1::int[])
        AND EXISTS (
          SELECT 1 FROM sale_items si
            JOIN product p ON p.id = si.product_id
           WHERE si.sale_id = sales.id
             AND ${SALE_TEST_PREDICATE}
        )`,
    [KEEP_SALE_IDS],
  );
  console.log(`[mark-test-data] ${res.rowCount} sale ditandai is_test=true (keep: ${KEEP_SALE_IDS.join(', ')})`);

  const nReturn = await markSupplierReturns();
  console.log(`[mark-test-data] ${nReturn} supplier_returns ditandai is_test=true (predikat supplier/opex/produk uji)`);

  const nLinked = await markOpexFromTestSupplierReturns();
  console.log(`[mark-test-data] ${nLinked} opex write-off ditandai is_test=true (retur uji via produk uji)`);

  const nToday = await markOpexWriteOffToday();
  console.log(`[mark-test-data] ${nToday} opex write-off ditandai is_test=true (fallback: write-off hari ini)`);

  const nManual = await markManualTestExpenses();
  console.log(`[mark-test-data] ${nManual} opex manual ditandai is_test=true (kategori berprefiks TEST)`);

  const remaining = await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM sales WHERE is_test = false`);
  console.log(`[mark-test-data] sale produksi tersisa: ${remaining.rows[0]?.n ?? 0}`);

  const opexLeft = await sql<{ n: number; total: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::numeric(14,2) AS total
       FROM operational_expenses WHERE is_test = false`,
  );
  console.log(
    `[mark-test-data] opex produksi tersisa: ${opexLeft.rows[0]?.n ?? 0} baris (Rp${opexLeft.rows[0]?.total ?? 0})`,
  );

  const returLeft = await sql<{ n: number; total: string | null }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(refunded_amount), 0)::numeric(14,2) AS total
       FROM supplier_returns WHERE is_test = false`,
  );
  console.log(
    `[mark-test-data] retur produksi tersisa: ${returLeft.rows[0]?.n ?? 0} dokumen (Rp${returLeft.rows[0]?.total ?? 0} refund)`,
  );
}

main()
  .catch((err) => {
    console.error('[mark-test-data] GAGAL:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
