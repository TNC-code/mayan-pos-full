import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { round2, round3, withTx } from '../utils/tx.js';
import { nextDocNo } from './docno.js';
import { runIdempotent } from './idempotency.service.js';

/* ============================== types ============================== */

/** Kondisi barang saat kembali ke gudang: GOOD (bisa dijual lagi) / RUSAK (karantina). */
export type StockCondition = 'GOOD' | 'RUSAK';

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

/** Detail refund per item (v2: refund bisa parsial + berlabel GOOD/RUSAK). */
export interface RefundItemRow {
  id: number;
  refund_id: number;
  sale_item_id: number;
  qty: number;
  condition: StockCondition;
  unit_price: number;
  subtotal: number;
}

export interface SaleDetail extends SaleRow {
  items: SaleItemRow[];
  payments: PaymentRow[];
  refunds: RefundRow[];
  refund_items: RefundItemRow[];
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

/** Item void (UC-C): tanpa qty - void selalu mengembalikan seluruh item tersebut. */
export interface VoidItemInput {
  sale_item_id: number;
  condition?: StockCondition;
}

/** Item refund (UC-A): qty boleh sebagian dari qty jual. */
export interface RefundItemInput extends VoidItemInput {
  qty: number;
}

export interface RefundInput {
  reason: string;
  /** Boleh override; default = metode pembayaran terakhir. */
  method_id?: number | null;
  /** Tanpa items = refund penuh semua item sisa, semua GOOD. */
  items?: RefundItemInput[];
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

const SELECT_REFUND_ITEM = `
  SELECT ri.id, ri.refund_id, ri.sale_item_id, ri.qty, ri.condition, ri.unit_price, ri.subtotal
    FROM refund_items ri
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

  const [items, payments, paid, refundedSum, refundRows, refundItemRows] = await Promise.all([
    runner(`${SELECT_ITEM} WHERE si.sale_id = $1 ORDER BY si.id ASC`, [id]),
    runner(`${SELECT_PAYMENT} WHERE p.sale_id = $1 ORDER BY p.id ASC`, [id]),
    runner(`SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS paid FROM payments WHERE sale_id = $1`, [id]),
    runner(`SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS refunded FROM refunds WHERE sale_id = $1`, [id]),
    runner(`${SELECT_REFUND} WHERE r.sale_id = $1 ORDER BY r.id ASC`, [id]),
    runner(
      `${SELECT_REFUND_ITEM} WHERE ri.refund_id IN (SELECT id FROM refunds WHERE sale_id = $1) ORDER BY ri.id ASC`,
      [id],
    ),
  ]);

  const paidAmount = Number(paid.rows[0]?.paid ?? 0);
  const refundedAmount = Number(refundedSum.rows[0]?.refunded ?? 0);
  const dueAmount = sale.status === 'COMPLETED' ? round2(sale.total_amount - paidAmount) : 0;

  return {
    ...sale,
    items: items.rows as SaleItemRow[],
    payments: payments.rows as PaymentRow[],
    refunds: refundRows.rows as RefundRow[],
    refund_items: refundItemRows.rows as RefundItemRow[],
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

/* ============ void / retur: stok balik per item + kondisi (FASE 5) ============ */

/**
 * Sejak 0005 trigger fn_sales_void_apply TIDAK lagi membuat movement IN otomatis.
 * Stok balik (void/retur/refund) sekarang ditulis di service ini sebagai SATU PENULIS,
 * per item dan BERKONDISI:
 *   GOOD -> movement IN -> trigger menambah qty_remaining (barang bisa dijual lagi)
 *   RUSAK -> movement IN -> trigger menambah qty_damaged (karantina, tidak ikut terjual)
 * Dengan begitu barang rusak punya jejak ledger tersendiri dan tidak terhitung dua kali.
 * fn_sales_void (validasi transisi status) tetap penjaga di DB. Tidak ada endpoint
 * DELETE untuk sale/item - ledger immutable.
 */

/** sale_items + sisa qty yang belum direfund (dasar validasi refund parsial). */
interface ReturnableItem {
  id: number;
  product_id: number;
  batch_id: number;
  qty: number;
  unit_price: number;
  unit_cost: number;
  refunded_qty: number;
}

/** Satu baris movement IN untuk pengembalian barang. */
interface ReturnLine {
  product_id: number;
  batch_id: number;
  qty: number;
  unit_cost: number;
  condition: StockCondition;
}

/** Baris refund parsial: ReturnLine + data uang (harga jual di snapshot sale_items). */
interface RefundLine extends ReturnLine {
  sale_item_id: number;
  unit_price: number;
  subtotal: number;
}

async function loadReturnableItems(client: PoolClient, saleId: number): Promise<Map<number, ReturnableItem>> {
  const res = await client.query<ReturnableItem>(
    `SELECT si.id, si.product_id, si.batch_id, si.qty, si.unit_price, si.unit_cost,
            COALESCE((SELECT sum(ri.qty) FROM refund_items ri WHERE ri.sale_item_id = si.id), 0)::numeric(14,3) AS refunded_qty
       FROM sale_items si
      WHERE si.sale_id = $1
      ORDER BY si.id`,
    [saleId],
  );
  return new Map(res.rows.map((r) => [Number(r.id), r]));
}

/**
 * Tulis movement IN untuk barang yang kembali ke gudang. Konvensi kolom mengikuti
 * trigger lama (fn_sales_void_apply): reference_type VOID/RETURN, reference_id = sale,
 * unit_cost = snapshot unit_cost sale_items, created_by = kasir yang membatalkan.
 * `condition` adalah kolom ledger baru (migration 0005) yang menentukan kolom mana
 * di stock_batches yang berubah (qty_remaining atau qty_damaged).
 */
async function insertReturnMovements(
  client: PoolClient,
  opts: {
    saleId: number;
    lines: ReturnLine[];
    referenceType: 'VOID' | 'RETURN';
    noteGood: string;
    noteDamaged: string;
    userId: number;
  },
): Promise<void> {
  for (const line of opts.lines) {
    await client.query(
      `INSERT INTO stock_movements
         (product_id, batch_id, movement_type, qty_change, unit_cost, reference_type, reference_id, note, created_by, condition)
       VALUES ($1, $2, 'IN', $3, $4, $5, $6, $7, $8, $9)`,
      [
        line.product_id,
        line.batch_id,
        line.qty,
        line.unit_cost,
        opts.referenceType,
        opts.saleId,
        line.condition === 'RUSAK' ? opts.noteDamaged : opts.noteGood,
        opts.userId,
        line.condition,
      ],
    );
  }
}

/**
 * Susun daftar barang yang kembali ke gudang saat void (UC-C).
 * Tanpa `items` -> seluruh item sale kembali, semua GOOD (perilaku lama, kompatibel FE).
 * Dengan `items` -> hanya item yang disebut, kondisi bisa GOOD atau RUSAK.
 * Catatan: void bersifat utuh untuk HEADER sale, jadi idealnya `items` berisi semua
 * item - item yang tidak disebut tidak gotten stok baliknya.
 * PrahASIL (state machine) tetap diperiksa di aplikasi: trigger DB hanya memvalidasi
 * saat `status` benar-benar BERUBAH, sehingga void kedua pada sale yang sudah VOIDED
 * akan lolos bila tidak dicegah di sini.
 */
function planVoidReturn(saleId: number, items: Map<number, ReturnableItem>, requested: VoidItemInput[] | null): ReturnLine[] {
  if (!requested || requested.length === 0) {
    return [...items.values()].map((it) => ({
      product_id: it.product_id,
      batch_id: it.batch_id,
      qty: it.qty,
      unit_cost: it.unit_cost,
      condition: 'GOOD' as StockCondition,
    }));
  }

  const seen = new Set<number>();
  return requested.map((r) => {
    if (seen.has(r.sale_item_id)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `sale_item_id=${r.sale_item_id} muncul lebih dari sekali pada void yang sama`,
      );
    }
    seen.add(r.sale_item_id);

    const it = items.get(r.sale_item_id);
    if (!it) {
      throw new ApiError('VOID_ITEM_MISMATCH', `sale_item_id=${r.sale_item_id} bukan item dari penjualan #${saleId}`);
    }
    // Void = pembatalan utuh, jadi qty balik mengikuti qty jual item tersebut.
    return {
      product_id: it.product_id,
      batch_id: it.batch_id,
      qty: it.qty,
      unit_cost: it.unit_cost,
      condition: (r.condition ?? 'GOOD') as StockCondition,
    };
  });
}

/** POST /sales/{id}/void - hanya untuk penjualan yang belum dibayar. */
export async function voidSale(
  saleId: number,
  reason: string,
  userId: number,
  requested?: VoidItemInput[] | null,
): Promise<SaleDetail> {
  return withTx(async (client) => {
    const current = await client.query<{ status: string; payment_status: string }>(
      `SELECT status, payment_status FROM sales WHERE id = $1 FOR UPDATE`,
      [saleId],
    );
    if (!current.rows[0]) {
      throw new ApiError('NOT_FOUND', `Penjualan id=${saleId} tidak ditemukan`);
    }

    const { status, payment_status } = current.rows[0];
    if (status !== 'COMPLETED') {
      throw new ApiError('TRANSITION_NOT_ALLOWED', `Penjualan sudah berstatus ${status}, tidak bisa di-void lagi`);
    }
    // VOIDED hanya untuk yang belum dibayar; yang sudah dibayar wajib lewat refund.
    if (payment_status !== 'UNPAID') {
      throw new ApiError('VOID_NOT_ALLOWED', 'Tidak dapat void penjualan yang sudah dibayar; gunakan retur/refund');
    }

    const items = await loadReturnableItems(client, saleId);
    const lines = planVoidReturn(saleId, items, requested ?? null);

    await client.query(`UPDATE sales SET status = 'VOIDED', voided_by = $2, void_reason = $3 WHERE id = $1`, [
      saleId,
      userId,
      reason,
    ]);

    await insertReturnMovements(client, {
      saleId,
      lines,
      referenceType: 'VOID',
      noteGood: 'Void penjualan',
      noteDamaged: 'Void penjualan - rusak',
      userId,
    });

    return fetchDetail(client, saleId);
  }, 'void');
}

/* ====================== refund / retur (P1 + parsial) ====================== */

/**
 * Susun rencana refund parsial (UC-A).
 *  - tanpa `items` -> seluruh sisa item, semua GOOD (perilaku lama, kompatibel FE)
 *  - dengan `items` -> qty sebagian, kondisi GOOD/RUSAK per item (bisa campur)
 * Mengembalikan juga `full` = true bila semua item jadi habis direfund (sale -> RETURNED).
 */
function planRefund(
  saleId: number,
  items: Map<number, ReturnableItem>,
  requested: RefundItemInput[] | null | undefined,
): { lines: RefundLine[]; total: number; full: boolean } {
  // Gabungkan input per sale_item_id + kondisi: 1 item boleh direfund sebagian
  // GOOD dan sebagian RUSAK sekaligus.
  const wanted = new Map<number, Record<StockCondition, number>>();

  if (requested && requested.length > 0) {
    for (const r of requested) {
      const it = items.get(r.sale_item_id);
      if (!it) {
        throw new ApiError('VOID_ITEM_MISMATCH', `sale_item_id=${r.sale_item_id} bukan item dari penjualan #${saleId}`);
      }
      if (typeof r.qty !== 'number' || !Number.isFinite(r.qty)) {
        throw new ApiError('VALIDATION_ERROR', `qty refund untuk sale_item_id=${r.sale_item_id} wajib diisi`);
      }
      if (r.qty <= 0) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `qty refund untuk sale_item_id=${r.sale_item_id} harus lebih besar dari 0`,
        );
      }
      const condition: StockCondition = r.condition === 'RUSAK' ? 'RUSAK' : 'GOOD';
      const bucket = wanted.get(r.sale_item_id) ?? { GOOD: 0, RUSAK: 0 };
      bucket[condition] += r.qty;
      wanted.set(r.sale_item_id, bucket);
    }
  } else {
    // Refund penuh: semua sisa item, semua GOOD.
    for (const it of items.values()) {
      const remaining = round3(it.qty - it.refunded_qty);
      if (remaining > 0) {
        wanted.set(it.id, { GOOD: remaining, RUSAK: 0 });
      }
    }
  }

  const lines: RefundLine[] = [];
  const askedQty = new Map<number, number>();

  for (const [saleItemId, bucket] of wanted) {
    const it = items.get(saleItemId)!;
    const totalQty = round3(bucket.GOOD + bucket.RUSAK);
    if (totalQty <= 0) continue;

    const remaining = round3(it.qty - it.refunded_qty);
    if (totalQty > remaining) {
      throw new ApiError(
        'REFUND_QTY_EXCEEDED',
        `Qty refund melebihi sisa item: sale_item_id=${saleItemId}, terjual ${it.qty}, ` +
          `sudah direfund ${it.refunded_qty}, diminta ${totalQty}`,
      );
    }
    askedQty.set(saleItemId, totalQty);

    for (const condition of ['GOOD', 'RUSAK'] as const) {
      const qty = round3(bucket[condition]);
      if (qty <= 0) continue;
      lines.push({
        sale_item_id: saleItemId,
        product_id: it.product_id,
        batch_id: it.batch_id,
        qty,
        unit_cost: it.unit_cost,
        condition,
        unit_price: it.unit_price,
        subtotal: round2(qty * it.unit_price),
      });
    }
  }

  if (lines.length === 0) {
    throw new ApiError('VALIDATION_ERROR', `Tidak ada item yang bisa direfund pada penjualan #${saleId}`);
  }

  const total = round2(lines.reduce((sum, l) => sum + l.subtotal, 0));
  // Semua item habis direfund -> penjualan ditutup sebagai RETURNED.
  const full = [...items.values()].every(
    (it) => round3(it.refunded_qty + (askedQty.get(it.id) ?? 0)) >= round3(it.qty),
  );

  return { lines, total, full };
}

/**
 * Retur + refund penjualan yang sudah dibayar (UC-A, refund parsial + barang rusak):
 *  1. Kunci sale (harus COMPLETED dan sudah ada pembayarannya; UNPAID -> pakai void).
 *  2. Susun rencana per item dari `refund_items` (sisa qty) - tanpa items = refund penuh.
 *  3. Validasi qty per item dan total uang (<= paid - refunded).
 *  4. Catat 1 baris `refunds` + `refund_items` + movement IN per item bercondition.
 *  5. Status: parsial tetap COMPLETED; semua item habis -> 'RETURNED' (trigger validasi).
 * Di bungkus Idempotency-Key agar retry tidak dobel refund.
 */
export async function refundSale(
  saleId: number,
  input: RefundInput,
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
    if (current.rows[0].payment_status === 'UNPAID') {
      throw new ApiError('REFUND_NOT_ALLOWED', 'Penjualan belum dibayar; gunakan void untuk membatalkan penjualan');
    }

    const items = await loadReturnableItems(client, saleId);
    const plan = planRefund(saleId, items, input.items);

    const money = await client.query<{ paid: number; refunded: number; method_id: number | null }>(
      `SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS paid,
              (SELECT COALESCE(sum(amount), 0)::numeric(14,2) FROM refunds WHERE sale_id = $1) AS refunded,
              (SELECT method_id FROM payments WHERE sale_id = $1 ORDER BY id DESC LIMIT 1) AS method_id
         FROM payments WHERE sale_id = $1`,
      [saleId],
    );
    const paidAmount = Number(money.rows[0]?.paid ?? 0);
    const refundedAmount = Number(money.rows[0]?.refunded ?? 0);
    const refundable = round2(paidAmount - refundedAmount);

    if (plan.total > refundable) {
      throw new ApiError(
        'REFUND_AMOUNT_EXCEEDED',
        `Total refund ${plan.total} melebihi sisa uang yang bisa dikembalikan ${refundable} ` +
          `(dibayar ${paidAmount}, sudah direfund ${refundedAmount})`,
      );
    }
    if (plan.total <= 0) {
      throw new ApiError('VALIDATION_ERROR', 'Total refund harus lebih besar dari 0');
    }

    // Metode refund: boleh override, default = metode pembayaran terakhir.
    const methodId = input.method_id ?? money.rows[0]?.method_id ?? null;
    if (methodId !== null) {
      await assertMethodUsable(client, methodId);
    }

    const refundIns = await client.query<{ id: number }>(
      `INSERT INTO refunds (sale_id, method_id, amount, reason, refunded_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [saleId, methodId, plan.total, input.reason, userId],
    );
    const refundId = refundIns.rows[0]!.id;

    for (const line of plan.lines) {
      await client.query(
        `INSERT INTO refund_items (refund_id, sale_item_id, qty, condition, unit_price, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [refundId, line.sale_item_id, line.qty, line.condition, line.unit_price, line.subtotal],
      );
    }

    await insertReturnMovements(client, {
      saleId,
      lines: plan.lines,
      referenceType: 'RETURN',
      noteGood: 'Retur customer',
      noteDamaged: 'Retur customer - rusak',
      userId,
    });

    // Refund penuh (semua item habis) -> tutup penjualan sebagai RETURNED.
    // Trigger fn_sales_void tetap memvalidasi transisi COMPLETED -> RETURNED.
    if (plan.full) {
      await client.query(`UPDATE sales SET status = 'RETURNED', voided_by = $2, void_reason = $3 WHERE id = $1`, [
        saleId,
        userId,
        `REFUND: ${input.reason}`,
      ]);
    }

    const detail = await fetchDetail(client, saleId);
    return { status: 200, body: detail };
  });

  return { sale: result.body, replayed: result.replayed };
}
