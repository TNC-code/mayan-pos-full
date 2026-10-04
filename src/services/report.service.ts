import { pool } from '../config/db.js';
import { env } from '../config/env.js';

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
 * Data uji (is_test) dikecualikan. laba_kotor = pendapatan - HPP;
 * laba_bersih = laba_kotor - beban operasional; laba_netto = laba_bersih (pajak belum dimodelkan).
 */
export async function pnlReport(month: string): Promise<PnlReport> {
  const res = await pool.query<{ revenue: string | null; hpp: string | null; trx: string | null; ppn: string | null }>(
    `SELECT SUM(s.total_amount) AS revenue,
            SUM(si.hpp) AS hpp,
            SUM(s.tax_amount) AS ppn,
            COUNT(DISTINCT s.id) AS trx
       FROM sales s
       JOIN (SELECT sale_id, SUM(unit_cost * qty) AS hpp FROM sale_items GROUP BY sale_id) si
         ON si.sale_id = s.id
      WHERE s.status = 'COMPLETED' AND s.is_test = false
        AND to_char(s.sale_date AT TIME ZONE $2, 'YYYY-MM') = $1`,
    [month, env.businessTz],
  );

  const refunds = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(r.amount), 0) AS total
       FROM refunds r JOIN sales s ON s.id = r.sale_id
      WHERE s.is_test = false
        AND to_char(r.refunded_at AT TIME ZONE $2, 'YYYY-MM') = $1`,
    [month, env.businessTz],
  );

  const opex = await pool.query<PnlCategoryRow>(
    `SELECT category, SUM(amount)::numeric(14,2) AS total_amount, COUNT(*)::int AS count
       FROM operational_expenses
      WHERE to_char(expense_date, 'YYYY-MM') = $1
      GROUP BY category ORDER BY SUM(amount) DESC`,
    [month],
  );

  const piutang = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(total_amount - COALESCE(paid.paid, 0)), 0) AS total
       FROM sales s
       LEFT JOIN (SELECT sale_id, SUM(amount) AS paid FROM payments GROUP BY sale_id) paid ON paid.sale_id = s.id
      WHERE s.status = 'COMPLETED' AND s.is_test = false AND s.payment_status IN ('UNPAID', 'PARTIAL')`,
  );

  const revenue = Number(res.rows[0]?.revenue ?? 0);
  const hpp = Number(res.rows[0]?.hpp ?? 0);
  const totalOpex = opex.rows.reduce((acc, r) => acc + Number(r.total_amount), 0);
  const labaKotor = revenue - hpp;
  const labaBersih = labaKotor - totalOpex;

  return {
    period: month,
    pendapatan: revenue,
    hpp,
    laba_kotor: labaKotor,
    beban_operasional: opex.rows.map((r) => ({ ...r, total_amount: Number(r.total_amount) })),
    total_beban_operasional: totalOpex,
    laba_bersih: labaBersih,
    laba_netto: labaBersih,
    ppn_diterima: Number(res.rows[0]?.ppn ?? 0),
    total_refund: Number(refunds.rows[0]?.total ?? 0),
    jml_transaksi: Number(res.rows[0]?.trx ?? 0),
    piutang_berjalan: Number(piutang.rows[0]?.total ?? 0),
    note:
      'Basis akrual (penjualan COMPLETED periode tsb, data uji dikecualikan). laba_netto = laba_bersih; pajak/beban non-operasional belum dimodelkan (MVP).',
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
  };
}
