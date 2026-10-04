import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { round2, withTx } from '../utils/tx.js';
import { nextDocNo } from './docno.js';
import { runIdempotent } from './idempotency.service.js';

/* ============================== types ============================== */

export interface SaleRow {
  id: number;
  sale_no: string;
  customer_id: number | null;
  customer_name: string | null;
  total_amount: number;
  tax_amount: number;
  status: string;
  payment_status: string;
  sale_date: string;
  note: string | null;
  created_by: number | null;
  created_by_name: string | null;
  voided_at: string | null;
  voided_by: number | null;
  void_reason: string | null;
  is_test: boolean;
  paid_amount?: number;
  due_amount?: number;
  refunded_amount?: number;
}

export interface SaleItemRow {
  id: number;
  sale_id: number;
  product_id: number;
  product_name: string | null;
  unit: string | null;
  batch_id: number;
  batch_code: string | null;
  qty: number;
  unit_price: number;
  unit_cost: number;
  subtotal: number;
  note: string | null;
}

export interface PaymentRow {
  id: number;
  sale_id: number;
  method_id: number;
  method_code: string;
  method_name: string;
  amount: number;
  tendered_amount: number | null;
  change_amount: number | null;
  reference_no: string | null;
  paid_at: string;
  received_by: number | null;
  received_by_name: string | null;
  notes: string | null;
}

export interface RefundRow {
  id: number;
  sale_id: number;
  method_id: number | null;
  method_code: string | null;
  amount: number;
  reason: string;
  refunded_at: string;
  refunded_by: number | null;
  refunded_by_name: string | null;
}

export interface SaleDetail extends SaleRow {
  items: SaleItemRow[];
  payments: PaymentRow[];
  refunds: RefundRow[];
}

export interface SaleInputItem {
  product_id: number;
  batch_id?: number | null;
  qty: number;
  unit_price: number;
  unit?: string | null;
  note?: string | null;
}

export interface SalePaymentInput {
  method_id: number;
  amount: number;
  tendered_amount?: number | null;
  reference_no?: string | null;
  notes?: string | null;
}

export interface SaleInput {
  customer_id?: number | null;
  note?: string | null;
  items: SaleInputItem[];
  payment?: SalePaymentInput | null;
  tax_percent?: number | null;
}

/* ============================ selectors ============================ */

const SELECT_SALE = `
  SELECT s.id, s.sale_no, s.customer_id, c.name AS customer_name, s.total_amount, s.tax_amount, s.status,
         s.payment_status, s.sale_date, s.note, s.created_by, u.username AS created_by_name,
         s.voided_at, s.voided_by, s.void_reason, s.is_test
    FROM sales s
    LEFT JOIN customer c ON c.id = s.customer_id
    LEFT JOIN user_account u ON u.id = s.created_by
`;

const SELECT_REFUND = `
  SELECT r.id, r.sale_id, r.method_id, m.code AS method_code, r.amount, r.reason,
         r.refunded_at, r.refunded_by, u.username AS refunded_by_name
    FROM refunds r
    LEFT JOIN payment_methods m ON m.id = r.method_id
    LEFT JOIN user_account u ON u.id = r.refunded_by
`;

const SELECT_PAYMENT = `
  SELECT p.id, p.sale_id, p.method_id, m.code AS method_code, m.name AS method_name,
         p.amount, p.tendered_amount, p.change_amount, p.reference_no, p.paid_at,
         p.received_by, u.username AS received_by_name, p.notes
    FROM payments p
    JOIN payment_methods m ON m.id = p.method_id
    LEFT JOIN user_account u ON u.id = p.received_by
`;

const SELECT_ITEM = `
  SELECT si.id, si.sale_id, si.product_id, pr.name AS product_name, pr.unit, si.batch_id,
         b.batch_code, si.qty, si.unit_price, si.unit_cost, si.subtotal, si.note
    FROM sale_items si
    JOIN product pr ON pr.id = si.product_id
    LEFT JOIN stock_batches b ON b.id = si.batch_id
`;

export async function listSales(params: {
  date_from?: string;
  date_to?: string;
  payment_status?: string;
  status?: string;
  customer_id?: number;
  q?: string;
  include_test?: boolean;
  limit: number;
  offset: number;
}): Promise<SaleRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];
  const tz = env.businessTz;

  // Default: data uji TIDAK ikut laporan/daftar produksi (P0 marking).
  if (!params.include_test) {
    where.push('s.is_test = false');
  }

  // Filter tanggal memakai zona waktu bisnis; jam absolut tetap milik DB.
  if (params.date_from) {
    args.push(tz);
    const tzIdx = args.length;
    args.push(params.date_from);
    where.push(`(s.sale_date AT TIME ZONE $${tzIdx})::date >= $${args.length}::date`);
  }
  if (params.date_to) {
    args.push(tz);
    const tzIdx = args.length;
    args.push(params.date_to);
    where.push(`(s.sale_date AT TIME ZONE $${tzIdx})::date <= $${args.length}::date`);
  }
  if (params.payment_status) {
    args.push(params.payment_status);
    where.push(`s.payment_status = $${args.length}`);
  }
  if (params.status) {
    args.push(params.status);
    where.push(`s.status = $${args.length}`);
  }
  if (params.customer_id !== undefined) {
    args.push(params.customer_id);
    where.push(`s.customer_id = $${args.length}`);
  }
  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`s.sale_no ILIKE $${args.length}`);
  }

  args.push(params.limit, params.offset);
  const res = await pool.query<SaleRow>(
    `${SELECT_SALE} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY s.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args as never[],
  );
  return res.rows;
}

async function fetchDetail(client: PoolClient | null, id: number): Promise<SaleDetail> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);

  const saleRes = await runner(`${SELECT_SALE} WHERE s.id = $1`, [id]);
  const sale = saleRes.rows[0] as SaleRow | undefined;
  if (!sale) {
    throw new ApiError('NOT_FOUND', `Penjualan id=${id} tidak ditemukan`);
  }

  const [items, payments, paid, refundedSum, refundRows] = await Promise.all([
    runner(`${SELECT_ITEM} WHERE si.sale_id = $1 ORDER BY si.id ASC`, [id]),
    runner(`${SELECT_PAYMENT} WHERE p.sale_id = $1 ORDER BY p.id ASC`, [id]),
    runner(`SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS paid FROM payments WHERE sale_id = $1`, [id]),
    runner(`SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS refunded FROM refunds WHERE sale_id = $1`, [id]),
    runner(`${SELECT_REFUND} WHERE r.sale_id = $1 ORDER BY r.id ASC`, [id]),
  ]);

  const paidAmount = Number(paid.rows[0]?.paid ?? 0);
  const refundedAmount = Number(refundedSum.rows[0]?.refunded ?? 0);
  const dueAmount = sale.status === 'COMPLETED' ? round2(sale.total_amount - paidAmount) : 0;

  return {
    ...sale,
    items: items.rows as SaleItemRow[],
    payments: payments.rows as PaymentRow[],
    refunds: refundRows.rows as RefundRow[],
    paid_amount: paidAmount,
    refunded_amount: refundedAmount,
    due_amount: dueAmount < 0 ? 0 : dueAmount,
  };
}

export async function getSale(id: number): Promise<SaleDetail> {
  return fetchDetail(null, id);
}

/* ====================== pemilihan batch (auto FIFO) ====================== */

/**
 * Batch eksplisit dari kasir, atau auto-FIFO:
 * batch aktif dengan qty_remaining > 0, diurutkan expired_date NULLS LAST lalu id.
 * Pengecekan qty/harga TIDAK diulang di sini - trigger fn_sale_item_validate yang
 * mengunci baris (SELECT ... FOR UPDATE) dan menolaknya.
 */
async function resolveBatchId(client: PoolClient, item: SaleInputItem): Promise<number> {
  if (item.batch_id) return item.batch_id;

  const res = await client.query<{ id: number }>(
    `SELECT id
       FROM stock_batches
      WHERE product_id = $1 AND qty_remaining > 0
      ORDER BY expired_date ASC NULLS LAST, id ASC
      LIMIT 1`,
    [item.product_id],
  );

  if (!res.rows[0]) {
    throw new ApiError(
      'INSUFFICIENT_STOCK',
      `Stok tidak cukup untuk produk id=${item.product_id}: tidak ada batch aktif dengan stok tersisa`,
    );
  }
  return res.rows[0].id;
}

/* ====================== validasi method (level API) ====================== */

/**
 * Side API untuk aturan yang juga dijaga trigger fn_payments_validate, supaya kasir
 * dapat pesan yang jelas sebelum DB menolak. DB tetap penjaga terakhirnya.
 */
async function assertMethodUsable(client: PoolClient, methodId: number, referenceNo?: string | null): Promise<{ code: string; requires_reference: boolean }> {
  const res = await client.query<{ code: string; is_active: boolean; requires_reference: boolean }>(
    `SELECT code, is_active, requires_reference FROM payment_methods WHERE id = $1`,
    [methodId],
  );
  const m = res.rows[0];
  if (!m) throw new ApiError('PAYMENT_METHOD_NOT_FOUND', `Metode pembayaran id=${methodId} tidak ditemukan`);
  if (!m.is_active) throw new ApiError('PAYMENT_METHOD_INACTIVE', 'Metode pembayaran tidak aktif');
  if (m.requires_reference && (referenceNo === undefined || referenceNo === null || referenceNo.trim() === '')) {
    throw new ApiError('REFERENCE_NO_REQUIRED', 'reference_no wajib untuk metode ini');
  }
  return { code: m.code, requires_reference: m.requires_reference };
}

async function insertPayment(
  client: PoolClient,
  saleId: number,
  payment: SalePaymentInput,
  receivedBy: number | null,
): Promise<PaymentRow> {
  await assertMethodUsable(client, payment.method_id, payment.reference_no);

  // CASH: uang diterima boleh lebih besar (kembalian = generated column change_amount).
  // Metode non-CASH: nominal yang diterima = amount.
  const tendered =
    payment.tendered_amount !== undefined && payment.tendered_amount !== null ? payment.tendered_amount : null;

  if (tendered !== null && tendered < payment.amount) {
    throw new ApiError('VALIDATION_ERROR', 'tendered_amount tidak boleh lebih kecil dari amount');
  }

  const res = await client.query<{ id: number }>(
    `INSERT INTO payments (sale_id, method_id, amount, tendered_amount, reference_no, notes, received_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [saleId, payment.method_id, payment.amount, tendered, payment.reference_no ?? null, payment.notes ?? null, receivedBy],
  );

  const pay = await client.query(`${SELECT_PAYMENT} WHERE p.id = $1`, [res.rows[0]!.id]);
  return pay.rows[0] as PaymentRow;
}

/* ====================== konversi satuan jual (P2) ====================== */

/**
 * Item boleh dijual dalam satuan alternatif (mis. "pak" = 5 pcs).
 * Rasio dibaca dari product.unit_conversions JSONB -> qty dikonversi ke satuan dasar
 * dan unit_price diskalakan per satuan dasar (harga input = harga per satuan ALT).
 */
async function resolveQtyPriceNote(
  client: PoolClient,
  item: SaleInputItem,
): Promise<{ qty: number; unitPrice: number; note: string | null }> {
  if (!item.unit) return { qty: item.qty, unitPrice: item.unit_price, note: item.note ?? null };

  const res = await client.query<{ unit: string; unit_conversions: Record<string, number> | null }>(
    `SELECT unit, unit_conversions FROM product WHERE id = $1`,
    [item.product_id],
  );
  const p = res.rows[0];
  if (!p) throw new ApiError('NOT_FOUND', `Produk id=${item.product_id} tidak ditemukan`);
  if (item.unit === p.unit) return { qty: item.qty, unitPrice: item.unit_price, note: item.note ?? null };

  const ratio = p.unit_conversions?.[item.unit];
  if (!ratio || ratio <= 0) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Unit '${item.unit}' tidak terdaftar di konversi produk id=${item.product_id} (tersedia: ${Object.keys(p.unit_conversions ?? {}).join(', ') || '-'})`,
    );
  }
  const note = [item.note ?? null, `1 ${item.unit} = ${ratio} ${p.unit}`].filter(Boolean).join(' | ');
  return {
    qty: item.qty * ratio,
    unitPrice: round2(item.unit_price / ratio),
    note,
  };
}

/* ====================== POST /sales (FASE 3) ====================== */

/**
 * POS checkout = SATU transaksi DB:
 *   BEGIN -> INSERT sales (sale_no dari sequence)
 *          -> INSERT sale_items per item (trigger: validasi harga/stok + auto-deduct movement OUT)
 *          -> INSERT payments (opsional; trigger: overpay reject + sync payment_status)
 *          -> COMMIT
 * Gagal di tengah = ROLLBACK total (tidak ada sales yatim, stok tidak berkurang).
 * Dilingkupi Idempotency-Key agar retry multi-POS tidak menghasilkan 2 transaksi.
 */
export async function createSale(input: SaleInput, userId: number, idempotencyKey: string): Promise<{ sale: SaleDetail; replayed: boolean }> {
  const result = await runIdempotent<SaleDetail>('POST /sales', idempotencyKey, async (client) => {
    if (input.customer_id !== undefined && input.customer_id !== null) {
      const c = await client.query(`SELECT 1 FROM customer WHERE id = $1`, [input.customer_id]);
      if (c.rowCount === 0) {
        throw new ApiError('VALIDATION_ERROR', `Customer id=${input.customer_id} tidak ditemukan`);
      }
    }

    // Total dihitung dari request (bukan dari stok), lalu dikoreksi ke subtotal
    // stored generated column DB sebelum commit.
    const estimatedTotal = round2(input.items.reduce((sum, it) => sum + it.qty * it.unit_price, 0));

    const saleNo = await nextDocNo(client, 'sale', env.businessTz);
    const saleIns = await client.query<{ id: number }>(
      `INSERT INTO sales (sale_no, customer_id, total_amount, note, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [saleNo, input.customer_id ?? null, estimatedTotal, input.note ?? null, userId],
    );
    const saleId = saleIns.rows[0]!.id;

    for (const item of input.items) {
      const batchId = await resolveBatchId(client, item);
      const { qty, unitPrice, note } = await resolveQtyPriceNote(client, item);
      // unit_cost diisi 0, ditimpa trigger dengan snapshot harga beli batch.
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, batch_id, qty, unit_price, unit_cost, note)
         VALUES ($1, $2, $3, $4, $5, 0, $6)`,
        [saleId, item.product_id, batchId, qty, unitPrice, note],
      );
    }

    // Samakan total dengan subtotal tersimpan di DB (NUMERIC presisi penuh)
    // lalu tambahkan PPN (P2) bila diisi.
    const total = await client.query<{ total: number }>(
      `SELECT COALESCE(sum(subtotal), 0)::numeric(14,2) AS total FROM sale_items WHERE sale_id = $1`,
      [saleId],
    );
    const subtotal = Number(total.rows[0]?.total ?? 0);
    const taxPercent = input.tax_percent ?? 0;
    const taxAmount = round2((subtotal * taxPercent) / 100);
    await client.query(`UPDATE sales SET total_amount = $2, tax_amount = $3 WHERE id = $1`, [
      saleId,
      round2(subtotal + taxAmount),
      taxAmount,
    ]);

    if (input.payment) {
      await insertPayment(client, saleId, input.payment, userId);
    }

    const detail = await fetchDetail(client, saleId);
    return { status: 201, body: detail };
  });

  return { sale: result.body, replayed: result.replayed };
}

/* ====================== POST /sales/{id}/payments (FASE 4) ====================== */

export async function addPayment(
  saleId: number,
  payment: SalePaymentInput,
  userId: number,
  idempotencyKey: string,
): Promise<{ payment: PaymentRow; sale: SaleDetail; replayed: boolean }> {
  const result = await runIdempotent<{ payment: PaymentRow; sale: SaleDetail }>(
    'POST /sales/{id}/payments',
    idempotencyKey,
    async (client) => {
      const sale = await client.query<{ id: number; status: string; total_amount: number }>(
        `SELECT id, status, total_amount FROM sales WHERE id = $1 FOR UPDATE`,
        [saleId],
      );
      if (!sale.rows[0]) {
        throw new ApiError('NOT_FOUND', `Penjualan id=${saleId} tidak ditemukan`);
      }

      const pay = await insertPayment(client, saleId, payment, userId);
      const detail = await fetchDetail(client, saleId);
      return { status: 201, body: { payment: pay, sale: detail } };
    },
  );

  return { ...result.body, replayed: result.replayed };
}

export async function listPayments(saleId: number): Promise<PaymentRow[]> {
  const exists = await pool.query(`SELECT 1 FROM sales WHERE id = $1`, [saleId]);
  if (exists.rowCount === 0) throw new ApiError('NOT_FOUND', `Penjualan id=${saleId} tidak ditemukan`);
  const res = await pool.query<PaymentRow>(`${SELECT_PAYMENT} WHERE p.sale_id = $1 ORDER BY p.id ASC`, [saleId]);
  return res.rows;
}

/* ====================== POST /sales/{id}/void (FASE 5) ====================== */

/**
 * Void = UPDATE sales.status -> 'VOIDED'.
 * Trigger fn_sales_void memvalidasi voided_by / void_reason / payment_status dan
 * trigger fn_sales_void_apply mengembalikan stok lewat movement IN.
 * Tidak ada endpoint DELETE untuk sale/item - ledger immutable.
 *
 * PrahASIL (state machine) tetap diperiksa di aplikasi: trigger DB hanya memvalidasi
 * saat `status` benar-benar BERUBAH, sehingga void kedua pada sale yang sudah VOIDED
 * akan lolos bila tidak dicegah di sini.
 */
async function transitionSaleStatus(
  saleId: number,
  target: 'VOIDED' | 'RETURNED',
  reason: string,
  userId: number,
): Promise<SaleDetail> {
  return withTx(async (client) => {
    const current = await client.query<{ status: string; payment_status: string; total_amount: number }>(
      `SELECT status, payment_status, total_amount FROM sales WHERE id = $1 FOR UPDATE`,
      [saleId],
    );
    if (!current.rows[0]) {
      throw new ApiError('NOT_FOUND', `Penjualan id=${saleId} tidak ditemukan`);
    }

    const { status, payment_status } = current.rows[0];
    if (status !== 'COMPLETED') {
      throw new ApiError('TRANSITION_NOT_ALLOWED', `Penjualan sudah berstatus ${status}, tidak bisa ${target === 'VOIDED' ? 'di-void' : 'diretur'} lagi`);
    }
    // VOIDED hanya untuk yang belum dibayar; yang sudah dibayar wajib lewat refund.
    if (target === 'VOIDED' && payment_status !== 'UNPAID') {
      throw new ApiError('VOID_NOT_ALLOWED', 'Tidak dapat void penjualan yang sudah dibayar; gunakan retur/refund');
    }

    await client.query(`UPDATE sales SET status = $2, voided_by = $3, void_reason = $4 WHERE id = $1`, [
      saleId,
      target,
      userId,
      reason,
    ]);

    return fetchDetail(client, saleId);
  }, target === 'VOIDED' ? 'void' : 'return');
}

export async function voidSale(saleId: number, reason: string, userId: number): Promise<SaleDetail> {
  return transitionSaleStatus(saleId, 'VOIDED', reason, userId);
}

/* ====================== refund / retur (P1) ====================== */

/**
 * Retur + refund penjualan yang sudah dibayar:
 *  1. Kunci sale (harus COMPLETED).
 *  2. Hitung total sudah dibayar -> catat 1 baris `refunds` (metode = pembayaran terakhir).
 *  3. UPDATE status -> 'RETURNED' (trigger fn_sales_void DIIZINKAN walau sudah dibayar;
 *     fn_sales_void_apply mengembalikan stok lewat movement IN).
 * Belum dibayar sama sekali -> cukup retur tanpa baris refund.
 * Di bungkus Idempotency-Key agar retry tidak dobel refund.
 */
export async function refundSale(
  saleId: number,
  reason: string,
  userId: number,
  idempotencyKey: string,
): Promise<{ sale: SaleDetail; replayed: boolean }> {
  const result = await runIdempotent<SaleDetail>('POST /sales/{id}/refund', idempotencyKey, async (client) => {
    const current = await client.query<{ status: string; payment_status: string }>(
      `SELECT status, payment_status FROM sales WHERE id = $1 FOR UPDATE`,
      [saleId],
    );
    if (!current.rows[0]) throw new ApiError('NOT_FOUND', `Penjualan id=${saleId} tidak ditemukan`);
    if (current.rows[0].status !== 'COMPLETED') {
      throw new ApiError('TRANSITION_NOT_ALLOWED', `Penjualan sudah berstatus ${current.rows[0].status}, tidak bisa diretur lagi`);
    }

    const paid = await client.query<{ total: number; method_id: number | null }>(
      `SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS total,
              (SELECT method_id FROM payments WHERE sale_id = $1 ORDER BY id DESC LIMIT 1) AS method_id
         FROM payments WHERE sale_id = $1`,
      [saleId],
    );
    const paidAmount = Number(paid.rows[0]?.total ?? 0);

    if (paidAmount > 0) {
      await client.query(
        `INSERT INTO refunds (sale_id, method_id, amount, reason, refunded_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [saleId, paid.rows[0]?.method_id ?? null, paidAmount, reason, userId],
      );
    }

    await client.query(`UPDATE sales SET status = 'RETURNED', voided_by = $2, void_reason = $3 WHERE id = $1`, [
      saleId,
      userId,
      `REFUND: ${reason}`,
    ]);

    const detail = await fetchDetail(client, saleId);
    return { status: 200, body: detail };
  });

  return { sale: result.body, replayed: result.replayed };
}
