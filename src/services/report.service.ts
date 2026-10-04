import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { round2 } from '../utils/tx.js';

export interface PnlCategoryRow {
  category: string;
  total_amount: number;
  count: number;
}

export interface PnlReport {
  period: string;
  pendapatan: number;
  hpp: number;
  laba_kotor: number;
  beban_operasional: PnlCategoryRow[];
  total_beban_operasional: number;
  /** Pendapatan lain: uang yang dikembalikan distributor atas retur barang rusak (UC-B). */
  refund_distributor: number;
  laba_bersih: number;
  laba_netto: number;
  ppn_diterima: number;
  total_refund: number;
  jml_transaksi: number;
  piutang_berjalan: number;
  note: string;
}

export interface DashboardReport {
  today: { pendapatan: number; hpp: number; laba_kotor: number; jml_transaksi: number };
  piutang_berjalan: number;
  low_stock_count: number;
  expiring_count: number;
  open_cash_sessions: number;
  top_products: Array<{ product_id: number; name: string; qty: number; revenue: number }>;
}

/**
 * Laporan Laba-Rugi periode bulanan (basis akrual: penjualan COMPLETED di bulan tsb).
 * Data uji dikecualikan secara default dari SELURUH laporan: `sales.is_test`,
 * `operational_expenses.is_test` (T6) dan `supplier_returns.is_test` (T9). OWNER bisa
 * melihat semuanya sekaligus dengan `?include_test=true` (padanan `GET /expenses`).
 * laba_kotor = pendapatan - HPP;
 * laba_bersih = laba_kotor + refund_distributor - beban operasional;
 * laba_netto = laba_bersih (pajak belum dimodelkan).
 *
 * `refund_distributor` = uang yang dikembalikan distributor untuk barang rusak yang sudah
 * diretur (supplier_returns status REFUNDED, dihitung per bulan `refunded_at`). Sifatnya
 * PENDAPATAN LAIN (barang sebelumnya sudah jadi beban HPP saat terjual), jadi menambah laba
 * - bukan mengurangi beban. Retur yang ditolak distributor tidak muncul di sini: opex
 * BARANG_RUSAK-nya otomatis tercatat di `operational_expenses`.
 */
export async function pnlReport(month: string, opts: { includeTest?: boolean } = {}): Promise<PnlReport> {
  // Default = laporan produksi murni (semua flag is_test dikecualikan).
  // includeTest=true -> query yang sama tanpa filter is_test (padanan GET /expenses?include_test).
  const includeTest = opts.includeTest === true;
  const gate = (col: string) => (includeTest ? 'true' : `${col} = false`);

  const res = await pool.query<{ revenue: string | null; hpp: string | null; trx: string | null; ppn: string | null }>(
    `SELECT SUM(s.total_amount) AS revenue,
            SUM(si.hpp) AS hpp,
            SUM(s.tax_amount) AS ppn,
            COUNT(DISTINCT s.id) AS trx
       FROM sales s
       JOIN (SELECT sale_id, SUM(unit_cost * qty) AS hpp FROM sale_items GROUP BY sale_id) si
         ON si.sale_id = s.id
      WHERE s.status = 'COMPLETED' AND ${gate('s.is_test')}
        AND to_char(s.sale_date AT TIME ZONE $2, 'YYYY-MM') = $1`,
    [month, env.businessTz],
  );

  const refunds = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(r.amount), 0) AS total
       FROM refunds r JOIN sales s ON s.id = r.sale_id
      WHERE ${gate('s.is_test')}
        AND to_char(r.refunded_at AT TIME ZONE $2, 'YYYY-MM') = $1`,
    [month, env.businessTz],
  );

  const opex = await pool.query<PnlCategoryRow>(
    `SELECT category, SUM(amount)::numeric(14,2) AS total_amount, COUNT(*)::int AS count
       FROM operational_expenses
      WHERE ${gate('is_test')}
        AND to_char(expense_date, 'YYYY-MM') = $1
      GROUP BY category ORDER BY SUM(amount) DESC`,
    [month],
  );

  // Pendapatan lain: retur barang rusak ke distributor yang dibayar balik (settle REFUNDED).
  // Dihitung per `refunded_at` (bukan created_at) supaya uang masuk diakui pada periode dibayar.
  // T9: retur uji (supplier_returns.is_test) dikecualikan; `?include_test=true` menampilkannya.
  const refundDistributor = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(refunded_amount), 0) AS total
       FROM supplier_returns
      WHERE status = 'REFUNDED' AND refunded_at IS NOT NULL AND ${gate('is_test')}
        AND to_char(refunded_at AT TIME ZONE $2, 'YYYY-MM') = $1`,
    [month, env.businessTz],
  );

  const piutang = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(total_amount - COALESCE(paid.paid, 0)), 0) AS total
       FROM sales s
       LEFT JOIN (SELECT sale_id, SUM(amount) AS paid FROM payments GROUP BY sale_id) paid ON paid.sale_id = s.id
      WHERE s.status = 'COMPLETED' AND ${gate('s.is_test')}
        AND s.payment_status IN ('UNPAID', 'PARTIAL')`,
  );

  const revenue = Number(res.rows[0]?.revenue ?? 0);
  const hpp = Number(res.rows[0]?.hpp ?? 0);
  const totalOpex = opex.rows.reduce((acc, r) => acc + Number(r.total_amount), 0);
  const refundDistributorTotal = Number(refundDistributor.rows[0]?.total ?? 0);
  const labaKotor = revenue - hpp;
  const labaBersih = round2(labaKotor + refundDistributorTotal - totalOpex);

  return {
    period: month,
    pendapatan: revenue,
    hpp,
    laba_kotor: labaKotor,
    beban_operasional: opex.rows.map((r) => ({ ...r, total_amount: Number(r.total_amount) })),
    total_beban_operasional: totalOpex,
    refund_distributor: refundDistributorTotal,
    laba_bersih: labaBersih,
    laba_netto: labaBersih,
    ppn_diterima: Number(res.rows[0]?.ppn ?? 0),
    total_refund: Number(refunds.rows[0]?.total ?? 0),
    jml_transaksi: Number(res.rows[0]?.trx ?? 0),
    piutang_berjalan: Number(piutang.rows[0]?.total ?? 0),
    note:
      'Basis akrual (penjualan COMPLETED periode tsb, data uji dikecualikan: sales/opex/retur distributor is_test). ' +
      'laba_bersih = laba_kotor + refund_distributor - beban_operasional; ' +
      'laba_netto = laba_bersih; pajak/beban non-operasional belum dimodelkan (MVP).' +
      (includeTest ? ' Mode include_test=true: data uji ikut dihitung.' : ''),
  };
}

/** Dashboard owner: ringkasan hari ini (TZ bisnis) + indikator stok & kas. */
export async function dashboard(): Promise<DashboardReport> {
  const today = await pool.query<{ revenue: string | null; hpp: string | null; trx: string | null }>(
    `SELECT SUM(s.total_amount) AS revenue,
            SUM(si.hpp) AS hpp,
            COUNT(DISTINCT s.id) AS trx
       FROM sales s
       JOIN (SELECT sale_id, SUM(unit_cost * qty) AS hpp FROM sale_items GROUP BY sale_id) si ON si.sale_id = s.id
      WHERE s.status = 'COMPLETED' AND s.is_test = false
        AND (s.sale_date AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [env.businessTz],
  );

  const piutang = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(total_amount - COALESCE(paid.paid, 0)), 0) AS total
       FROM sales s
       LEFT JOIN (SELECT sale_id, SUM(amount) AS paid FROM payments GROUP BY sale_id) paid ON paid.sale_id = s.id
      WHERE s.status = 'COMPLETED' AND s.is_test = false AND s.payment_status IN ('UNPAID', 'PARTIAL')`,
  );

  const lowStock = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM product p
       LEFT JOIN stock_batches b ON b.product_id = p.id
      WHERE p.is_active AND p.min_stock > 0
      GROUP BY p.id, p.min_stock
     HAVING COALESCE(SUM(b.qty_remaining), 0) < p.min_stock`,
  );
  const lowStockCount = lowStock.rows.reduce((acc, r) => acc + 1, 0);

  const expiring = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM stock_batches
      WHERE qty_remaining > 0 AND expired_date IS NOT NULL
        AND expired_date <= CURRENT_DATE + 30`,
  );

  const openSessions = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM cash_sessions WHERE status = 'OPEN'`);

  const top = await pool.query<{ product_id: number; name: string; qty: string | null; revenue: string | null }>(
    `SELECT si.product_id, p.name, SUM(si.qty) AS qty, SUM(si.subtotal) AS revenue
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN product p ON p.id = si.product_id
      WHERE s.status = 'COMPLETED' AND s.is_test = false
        AND to_char(s.sale_date AT TIME ZONE $1, 'YYYY-MM') = to_char(now() AT TIME ZONE $1, 'YYYY-MM')
      GROUP BY si.product_id, p.name ORDER BY SUM(si.subtotal) DESC LIMIT 5`,
    [env.businessTz],
  );

  return {
    today: {
      pendapatan: Number(today.rows[0]?.revenue ?? 0),
      hpp: Number(today.rows[0]?.hpp ?? 0),
      laba_kotor: Number(today.rows[0]?.revenue ?? 0) - Number(today.rows[0]?.hpp ?? 0),
      jml_transaksi: Number(today.rows[0]?.trx ?? 0),
    },
    piutang_berjalan: Number(piutang.rows[0]?.total ?? 0),
    low_stock_count: lowStockCount,
    expiring_count: Number(expiring.rows[0]?.count ?? 0),
    open_cash_sessions: Number(openSessions.rows[0]?.count ?? 0),
    top_products: top.rows.map((r) => ({ ...r, qty: Number(r.qty ?? 0), revenue: Number(r.revenue ?? 0) })),
  };
}

/** Alert stok: di bawah minimum & batch mendekati expired (<= 30 hari). */
export async function alerts(): Promise<{
  low_stock: Array<{ product_id: number; sku: string | null; name: string; qty_on_hand: number; min_stock: number }>;
  expiring: Array<{ batch_id: number; batch_code: string; product_name: string; qty_remaining: number; expired_date: string; days_left: number }>;
  damaged_stock: Array<{ batch_id: number; batch_code: string; product_name: string; qty_damaged: number; value: number }>;
  damaged_stock_total: { qty: number; value: number; pending_returns: number };
}> {
  const low = await pool.query<{
    product_id: number;
    sku: string | null;
    name: string;
    qty_on_hand: string;
    min_stock: string;
  }>(
    `SELECT p.id AS product_id, p.sku, p.name, COALESCE(SUM(b.qty_remaining), 0)::numeric(14,3) AS qty_on_hand, p.min_stock
       FROM product p LEFT JOIN stock_batches b ON b.product_id = p.id
      WHERE p.is_active AND p.min_stock > 0
      GROUP BY p.id, p.sku, p.name, p.min_stock
     HAVING COALESCE(SUM(b.qty_remaining), 0) < p.min_stock
      ORDER BY p.name`,
  );

  const exp = await pool.query<{
    batch_id: number;
    batch_code: string;
    product_name: string;
    qty_remaining: string;
    expired_date: string;
    days_left: number;
  }>(
    `SELECT b.id AS batch_id, b.batch_code, p.name AS product_name, b.qty_remaining, b.expired_date,
            (b.expired_date - CURRENT_DATE) AS days_left
       FROM stock_batches b JOIN product p ON p.id = b.product_id
      WHERE b.qty_remaining > 0 AND b.expired_date IS NOT NULL AND b.expired_date <= CURRENT_DATE + 30
      ORDER BY b.expired_date ASC`,
  );

  const damaged = await pool.query<{
    batch_id: number;
    batch_code: string;
    product_name: string;
    qty_damaged: string;
    value: string;
  }>(
    `SELECT b.id AS batch_id, b.batch_code, p.name AS product_name, b.qty_damaged,
            (b.qty_damaged * b.unit_cost)::numeric(14,2) AS value
       FROM stock_batches b JOIN product p ON p.id = b.product_id
      WHERE b.qty_damaged > 0
      ORDER BY value DESC`,
  );

  const damagedPending = await pool.query<{ qty: string; value: string; pending: number }>(
    `SELECT COALESCE(sum(b.qty_damaged), 0)::numeric(14,3) AS qty,
            COALESCE(sum(b.qty_damaged * b.unit_cost), 0)::numeric(14,2) AS value,
            (SELECT count(*)::int FROM supplier_returns WHERE status = 'PENDING') AS pending
       FROM stock_batches b WHERE b.qty_damaged > 0`,
  );

  return {
    low_stock: low.rows.map((r) => ({
      product_id: r.product_id,
      sku: r.sku,
      name: r.name,
      qty_on_hand: Number(r.qty_on_hand),
      min_stock: Number(r.min_stock),
    })),
    expiring: exp.rows.map((r) => ({
      batch_id: r.batch_id,
      batch_code: r.batch_code,
      product_name: r.product_name,
      qty_remaining: Number(r.qty_remaining),
      expired_date: r.expired_date,
      days_left: Number(r.days_left),
    })),
    damaged_stock: damaged.rows.map((r) => ({
      batch_id: r.batch_id,
      batch_code: r.batch_code,
      product_name: r.product_name,
      qty_damaged: Number(r.qty_damaged),
      value: Number(r.value),
    })),
    damaged_stock_total: {
      qty: Number(damagedPending.rows[0]?.qty ?? 0),
      value: Number(damagedPending.rows[0]?.value ?? 0),
      pending_returns: Number(damagedPending.rows[0]?.pending ?? 0),
    },
  };
}

/* ================== laporan analisa opname bulanan (UC-D) ================== */

export interface OpnameReport {
  period: string;
  total: {
    opname_count: number;
    item_count: number;
    selisih_qty: number;
    selisih_qty_damaged: number;
    nilai_selisih: number;
    nilai_rugi: number;
    nilai_lebih: number;
  };
  per_cause: Array<{
    cause: string;
    item_count: number;
    selisih_qty: number;
    selisih_qty_damaged: number;
    nilai_selisih: number;
    nilai_selisih_damaged: number;
  }>;
  per_kategori: Array<{
    category_id: number | null;
    category: string;
    selisih_qty: number;
    selisih_qty_damaged: number;
    nilai_selisih: number;
  }>;
  top_produk: Array<{
    product_id: number;
    name: string;
    selisih_qty: number;
    selisih_qty_damaged: number;
    nilai_selisih: number;
  }>;
  tren_6_bulan: Array<{ month: string; opname_count: number; selisih_qty: number; nilai_selisih: number }>;
  stok_rusak_belum_diretur: {
    qty: number;
    nilai: number;
    batch_count: number;
    pending_return_count: number;
    pending_return_value: number;
  };
  note: string;
}

/**
 * Laporan analisa opname bulanan untuk OWNER (UC-D).
 * Semua angka dihitung ulang dari `stock_opname_items` (snapshot saat opname), bukan dari
 * `stock_batches` sekarang - supaya laporan bulan lalu tidak berubah karena penjualan
 * yang terjadi sesudahnya. Nilai rupiah memakai unit_cost acuan yang sama dengan
 * detail opname (batch, fallback rata-rata tertimbang produk).
 */
export async function opnameReport(month: string): Promise<OpnameReport> {
  // Akar nilai selisih: selisih qty (GOOD + RUSAK) × unit_cost acuan.
  const unitCostExpr = `
    COALESCE(
      (SELECT b.unit_cost FROM stock_batches b WHERE b.id = i.batch_id),
      (SELECT COALESCE(sum(b2.unit_cost * b2.qty_remaining) / NULLIF(sum(b2.qty_remaining), 0), 0)
         FROM stock_batches b2 WHERE b2.product_id = i.product_id),
      0
    )
  `;

  const summary = await pool.query<{
    opname_count: string;
    item_count: string;
    diff_qty: string;
    diff_qty_damaged: string;
    nilai: string;
  }>(
    `SELECT count(DISTINCT o.id)::text AS opname_count,
            count(i.id)::text AS item_count,
            COALESCE(sum(i.difference), 0)::numeric(14,3) AS diff_qty,
            COALESCE(sum(i.damaged_difference), 0)::numeric(14,3) AS diff_qty_damaged,
            COALESCE(sum((i.difference + i.damaged_difference) * (${unitCostExpr})), 0)::numeric(14,2) AS nilai
       FROM stock_opnames o
       JOIN stock_opname_items i ON i.opname_id = o.id
      WHERE to_char(o.opname_date, 'YYYY-MM') = $1`,
    [month],
  );

  const cause = await pool.query<{ cause: string; items: string; qty: string; dmg: string; nilai: string; nilai_dmg: string }>(
    `SELECT i.cause, count(*)::text AS items,
            COALESCE(sum(i.difference), 0)::numeric(14,3) AS qty,
            COALESCE(sum(i.damaged_difference), 0)::numeric(14,3) AS dmg,
            COALESCE(sum((i.difference + i.damaged_difference) * (${unitCostExpr})), 0)::numeric(14,2) AS nilai,
            COALESCE(sum(i.damaged_difference * (${unitCostExpr})), 0)::numeric(14,2) AS nilai_dmg
       FROM stock_opnames o
       JOIN stock_opname_items i ON i.opname_id = o.id
      WHERE to_char(o.opname_date, 'YYYY-MM') = $1 AND i.cause IS NOT NULL
      GROUP BY i.cause
      ORDER BY abs(COALESCE(sum((i.difference + i.damaged_difference) * (${unitCostExpr})), 0)) DESC`,
    [month],
  );

  const kategori = await pool.query<{
    category_id: number | null;
    category: string;
    qty: string;
    dmg: string;
    nilai: string;
  }>(
    `SELECT p.category_id, COALESCE(pc.name, '(tanpa kategori)') AS category,
            COALESCE(sum(i.difference), 0)::numeric(14,3) AS qty,
            COALESCE(sum(i.damaged_difference), 0)::numeric(14,3) AS dmg,
            COALESCE(sum((i.difference + i.damaged_difference) * (${unitCostExpr})), 0)::numeric(14,2) AS nilai
       FROM stock_opnames o
       JOIN stock_opname_items i ON i.opname_id = o.id
       JOIN product p ON p.id = i.product_id
       LEFT JOIN product_category pc ON pc.id = p.category_id
      WHERE to_char(o.opname_date, 'YYYY-MM') = $1
      GROUP BY p.category_id, COALESCE(pc.name, '(tanpa kategori)')
      ORDER BY abs(COALESCE(sum((i.difference + i.damaged_difference) * (${unitCostExpr})), 0)) DESC`,
    [month],
  );

  const top = await pool.query<{
    product_id: number;
    name: string;
    qty: string;
    dmg: string;
    nilai: string;
  }>(
    `SELECT p.id AS product_id, p.name,
            COALESCE(sum(i.difference), 0)::numeric(14,3) AS qty,
            COALESCE(sum(i.damaged_difference), 0)::numeric(14,3) AS dmg,
            COALESCE(sum((i.difference + i.damaged_difference) * (${unitCostExpr})), 0)::numeric(14,2) AS nilai
       FROM stock_opnames o
       JOIN stock_opname_items i ON i.opname_id = o.id
       JOIN product p ON p.id = i.product_id
      WHERE to_char(o.opname_date, 'YYYY-MM') = $1
      GROUP BY p.id, p.name
      ORDER BY abs(COALESCE(sum((i.difference + i.damaged_difference) * (${unitCostExpr})), 0)) DESC
      LIMIT 10`,
    [month],
  );

  // Tren 6 bulan terakhir (termasuk bulan yang diminta) memakai generate_series supaya
  // bulan tanpa opname tetap muncul sebagai 0 (grafik tidak bolong).
  const tren = await pool.query<{ month: string; opname_count: string; qty: string; nilai: string }>(
    `SELECT to_char(m.period, 'YYYY-MM') AS month,
            count(DISTINCT o.id)::text AS opname_count,
            COALESCE(sum(i.difference + i.damaged_difference), 0)::numeric(14,3) AS qty,
            COALESCE(sum((i.difference + i.damaged_difference) * (${unitCostExpr})), 0)::numeric(14,2) AS nilai
       FROM generate_series(
              date_trunc('month', to_date($1, 'YYYY-MM'))::date - interval '5 months',
              date_trunc('month', to_date($1, 'YYYY-MM'))::date,
              interval '1 month') AS m(period)
       LEFT JOIN stock_opnames o
              ON o.opname_date >= m.period::date
             AND o.opname_date < (m.period + interval '1 month')::date
       LEFT JOIN stock_opname_items i ON i.opname_id = o.id
      GROUP BY m.period ORDER BY m.period ASC`,
    [month],
  );

  const rusak = await pool.query<{ qty: string; nilai: string; batches: number }>(
    `SELECT COALESCE(sum(b.qty_damaged), 0)::numeric(14,3) AS qty,
            COALESCE(sum(b.qty_damaged * b.unit_cost), 0)::numeric(14,2) AS nilai,
            count(*)::int AS batches
       FROM stock_batches b WHERE b.qty_damaged > 0`,
  );

  const pending = await pool.query<{ n: number; nilai: string }>(
    `SELECT count(*)::int AS n, COALESCE(sum(total_cost), 0)::numeric(14,2) AS nilai
       FROM supplier_returns WHERE status = 'PENDING'`,
  );

  const s = summary.rows[0];
  const nilai = Number(s?.nilai ?? 0);
  return {
    period: month,
    total: {
      opname_count: Number(s?.opname_count ?? 0),
      item_count: Number(s?.item_count ?? 0),
      selisih_qty: Number(s?.diff_qty ?? 0),
      selisih_qty_damaged: Number(s?.diff_qty_damaged ?? 0),
      nilai_selisih: nilai,
      nilai_rugi: nilai < 0 ? round2(Math.abs(nilai)) : 0,
      nilai_lebih: nilai > 0 ? round2(nilai) : 0,
    },
    per_cause: cause.rows.map((r) => ({
      cause: r.cause,
      item_count: Number(r.items),
      selisih_qty: Number(r.qty),
      selisih_qty_damaged: Number(r.dmg),
      nilai_selisih: Number(r.nilai),
      nilai_selisih_damaged: Number(r.nilai_dmg),
    })),
    per_kategori: kategori.rows.map((r) => ({
      category_id: r.category_id,
      category: r.category,
      selisih_qty: Number(r.qty),
      selisih_qty_damaged: Number(r.dmg),
      nilai_selisih: Number(r.nilai),
    })),
    top_produk: top.rows.map((r) => ({
      product_id: r.product_id,
      name: r.name,
      selisih_qty: Number(r.qty),
      selisih_qty_damaged: Number(r.dmg),
      nilai_selisih: Number(r.nilai),
    })),
    tren_6_bulan: tren.rows.map((r) => ({
      month: r.month,
      opname_count: Number(r.opname_count),
      selisih_qty: Number(r.qty),
      nilai_selisih: Number(r.nilai),
    })),
    stok_rusak_belum_diretur: {
      qty: Number(rusak.rows[0]?.qty ?? 0),
      nilai: Number(rusak.rows[0]?.nilai ?? 0),
      batch_count: Number(rusak.rows[0]?.batches ?? 0),
      pending_return_count: Number(pending.rows[0]?.n ?? 0),
      pending_return_value: Number(pending.rows[0]?.nilai ?? 0),
    },
    note:
      'Selisih = (physical - system) untuk barang GOOD + RUSAK. Nilai rupiah memakai unit_cost batch ' +
      'atau rata-rata tertimbang produk sebagai fallback; angka memakai snapshot saat opname, bukan stok saat ini.',
  };
}
