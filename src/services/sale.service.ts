import { Op, QueryTypes, Sequelize, type Includeable, type Transaction } from 'sequelize';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { round2, round3, withOrmTx } from '../utils/tx.js';
import { mapOrmError } from '../utils/orm-errors.js';
import {
  Customer,
  Payment,
  PaymentMethod,
  Product,
  Refund,
  RefundItem,
  Sale,
  SaleItem,
  StockBatch,
  StockMovement,
  UserAccount,
  sequelize,
} from '../models/index.js';
import { nextDocNo } from './docno.js';
import { runOrmIdempotent } from './idempotency.service.js';

/**
 * Penjualan di atas Sequelize (MP-4) — paritas penuh dengan versi raw SQL lama
 * (`git show e33b3b5:src/services/sale.service.ts`, dipindahkan tanpa mengubah
 * bentuk response).
 *
 * Yang TETAP milik trigger DB (tidak digandakan di sini, plan §D3):
 *  - `trg_sale_item_validate`: batch wajib + lock `FOR UPDATE`, `unit_price >=
 *    unit_cost`, `qty_remaining >= qty`, dan **menimpa `unit_cost` dengan harga
 *    beli batch** (snapshot HPP);
 *  - `trg_sale_item_apply_movement`: movement `OUT` per item (stok turun via
 *    `trg_stock_movement_apply` — aplikasi tidak pernah menghitung stok);
 *  - `trg_payments_validate` / `trg_payments_sync_status`: metode aktif,
 *    `reference_no`, anti-overpay, dan penulisan `payment_status`;
 *  - `trg_sales_void`: transisi status + metadata void; `fn_sales_void_apply`
 *    sengaja PASIF — stok balik ditulis SATU PENULIS di service ini
 *    (`insertReturnMovements`, movement `IN` berlabel GOOD/RUSAK).
 *
 * Yang DITAMBAHkan lapisan aplikasi (validasi ramah ber-`ApiError`, kode error
 * sama dengan yang akan muncul dari trigger):
 *  - alokasi batch: eksplisit dari kasir ATAU auto-FIFO (expired ASC NULLS LAST,
 *    id ASC) dengan `FOR UPDATE` — menutup race 2 kasir sebelum trigger bekerja;
 *  - `PRICE_BELOW_COST` / `INSUFFICIENT_STOCK` / `PAYMENT_OVER_TOTAL` checked
 *    sebelum INSERT, jadi kasir dapat pesan jelas (bukan 500 dari trigger);
 *  - `PAYMENT_METHOD_INACTIVE` / `PAYMENT_METHOD_NOT_FOUND` /
 *    `REFERENCE_NO_REQUIRED` untuk metode pembayaran.
 */

export type StockCondition = 'GOOD' | 'RUSAK';

export interface SaleRow {
  id: number;
  sale_no: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_address: string | null;
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
  /** Opsional untuk kompatibilitas lama (tanpa qty = seluruh qty baris).
   *  Diperlukan bila satu baris dipecah per kondisi (mis. 1 GOOD + 1 RUSAK). */
  qty?: number;
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

/* ============================== include ============================== */

/**
 * `Product` punya default scope `is_active = true` (soft delete) sedangkan
 * JOIN lama tidak memfilternya -> penjualan produk nonaktif tetap harus terbaca.
 * `PaymentMethod` default-nya `is_active = true`; riwayat bayar/refund metode
 * yang lalu dinonaktifkan juga harus terbaca -> dua-duanya lewat scope.
 */
const INCLUDE_CUSTOMER: Includeable = {
  model: Customer,
  as: 'customer',
  attributes: ['id', 'name', 'address'],
  required: false,
};

const INCLUDE_CREATOR: Includeable = {
  model: UserAccount,
  as: 'creator',
  attributes: ['id', 'username'],
  required: false,
};

const INCLUDE_METHOD: Includeable = {
  model: PaymentMethod.scope('withInactive'),
  as: 'method',
  attributes: ['id', 'code', 'name'],
  required: false,
};

const SALE_INCLUDES: Includeable[] = [INCLUDE_CUSTOMER, INCLUDE_CREATOR];

const ITEM_INCLUDES: Includeable[] = [
  { model: Product.scope('withInactive'), as: 'product', attributes: ['id', 'name', 'unit'], required: true },
  { model: StockBatch, as: 'batch', attributes: ['id', 'batch_code'], required: false },
];

const PAYMENT_INCLUDES: Includeable[] = [
  INCLUDE_METHOD,
  { model: UserAccount, as: 'receiver', attributes: ['id', 'username'], required: false },
];

const REFUND_INCLUDES: Includeable[] = [
  INCLUDE_METHOD,
  { model: UserAccount, as: 'refunder', attributes: ['id', 'username'], required: false },
];

/* ============================== mapper ============================== */

type SaleWithRefs = Sale & {
  customer?: { id: number; name: string | null; address: string | null } | null;
  creator?: { id: number; username: string } | null;
};

type SaleItemWithRefs = SaleItem & {
  product?: { id: number; name: string | null; unit: string | null } | null;
  batch?: { id: number; batch_code: string | null } | null;
};

type PaymentWithRefs = Payment & {
  method?: { id: number; code: string; name: string } | null;
  receiver?: { id: number; username: string } | null;
};

type RefundWithRefs = Refund & {
  method?: { id: number; code: string; name: string } | null;
  refunder?: { id: number; username: string } | null;
};

/** `timestamptz` -> string ISO (JSON `Date` otomatis sama seperti jalur raw SQL). */
function iso(value: Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toSaleRow(row: SaleWithRefs): SaleRow {
  return {
    id: row.id,
    sale_no: row.sale_no,
    customer_id: row.customer_id,
    customer_name: row.customer?.name ?? null,
    customer_address: row.customer?.address ?? null,
    total_amount: row.total_amount,
    tax_amount: row.tax_amount,
    status: row.status,
    payment_status: row.payment_status,
    sale_date: new Date(row.sale_date).toISOString(),
    note: row.note,
    created_by: row.created_by,
    created_by_name: row.creator?.username ?? null,
    voided_at: iso(row.voided_at),
    voided_by: row.voided_by,
    void_reason: row.void_reason,
    is_test: row.is_test,
  };
}

function toSaleItemRow(row: SaleItemWithRefs): SaleItemRow {
  return {
    id: row.id,
    sale_id: row.sale_id,
    product_id: row.product_id,
    product_name: row.product?.name ?? null,
    unit: row.product?.unit ?? null,
    batch_id: row.batch_id,
    batch_code: row.batch?.batch_code ?? null,
    qty: row.qty,
    unit_price: row.unit_price,
    unit_cost: row.unit_cost,
    subtotal: row.subtotal,
    note: row.note,
  };
}

function toPaymentRow(row: PaymentWithRefs): PaymentRow {
  return {
    id: row.id,
    sale_id: row.sale_id,
    method_id: row.method_id,
    method_code: row.method?.code ?? '',
    method_name: row.method?.name ?? '',
    amount: row.amount,
    tendered_amount: row.tendered_amount,
    change_amount: row.change_amount,
    reference_no: row.reference_no,
    paid_at: new Date(row.paid_at).toISOString(),
    received_by: row.received_by,
    received_by_name: row.receiver?.username ?? null,
    notes: row.notes,
  };
}

function toRefundRow(row: RefundWithRefs): RefundRow {
  return {
    id: row.id,
    sale_id: row.sale_id,
    method_id: row.method_id,
    method_code: row.method?.code ?? null,
    amount: row.amount,
    reason: row.reason,
    refunded_at: new Date(row.refunded_at).toISOString(),
    refunded_by: row.refunded_by,
    refunded_by_name: row.refunder?.username ?? null,
  };
}

/* ============================ daftar penjualan ============================ */

export interface SaleListQuery {
  date_from?: string;
  date_to?: string;
  payment_status?: string;
  status?: string;
  customer_id?: number;
  q?: string;
  include_test?: boolean;
  limit: number;
  offset: number;
}

/**
 * `GET /sales` — daftar penjualan (default `id DESC`).
 *
 * Filter tanggal memakai zona waktu bisnis seperti versi lama:
 * `(sale_date AT TIME ZONE $tz)::date >= $date_from`. `$tz` berasal dari env
 * (bukan input user) dan tetap di-escape lewat `sequelize.escape`.
 *
 * Default: baris `is_test = true` disembunyikan (P0 marking) — termasuk dengan
 * `?include_test=true`.
 */
export async function listSales(params: SaleListQuery): Promise<SaleRow[]> {
  const conditions: Record<string, unknown>[] = [];

  if (!params.include_test) conditions.push({ is_test: false });

  const tzLiteral = sequelize.escape(env.businessTz);
  const localDate = (op: '>=' | '<=', value: string): ReturnType<typeof Sequelize.literal> =>
    Sequelize.literal(`(sale_date AT TIME ZONE ${tzLiteral})::date ${op} ${sequelize.escape(value)}`);
  if (params.date_from) conditions.push(localDate('>=', params.date_from) as never);
  if (params.date_to) conditions.push(localDate('<=', params.date_to) as never);

  if (params.payment_status) conditions.push({ payment_status: params.payment_status });
  if (params.status) conditions.push({ status: params.status });
  if (params.customer_id !== undefined) conditions.push({ customer_id: params.customer_id });
  if (params.q) conditions.push({ sale_no: { [Op.iLike]: `%${params.q}%` } });

  const rows = await Sale.findAll({
    where: { [Op.and]: conditions },
    include: SALE_INCLUDES,
    // Semua include 1:1 (belongsTo) -> jumlah baris tidak berubah, LIMIT aman.
    subQuery: false,
    order: [['id', 'DESC']],
    limit: params.limit,
    offset: params.offset,
  });

  return (rows as unknown as SaleWithRefs[]).map(toSaleRow);
}

/* ============================== detail ============================== */

/**
 * Header + item + payment + refund satu penjualan.
 * Boleh dipanggil dalam transaksi (semua query membawa `transaction`), supaya
 * `createSale`/`voidSale`/`refundSale` bisa mengembalikan detail yang SUDAH
 * memasukkan efek baris yang baru ditulis.
 */
async function fetchDetail(transaction: Transaction | null, id: number): Promise<SaleDetail> {
  const sale = await Sale.findByPk(id, { include: SALE_INCLUDES, transaction });
  if (!sale) {
    throw new ApiError('NOT_FOUND', `Penjualan id=${id} tidak ditemukan`);
  }

  const items = await SaleItem.findAll({
    where: { sale_id: id },
    include: ITEM_INCLUDES,
    subQuery: false,
    order: [['id', 'ASC']],
    transaction,
  });
  const payments = await Payment.findAll({
    where: { sale_id: id },
    include: PAYMENT_INCLUDES,
    subQuery: false,
    order: [['id', 'ASC']],
    transaction,
  });
  const refunds = await Refund.findAll({
    where: { sale_id: id },
    include: REFUND_INCLUDES,
    subQuery: false,
    order: [['id', 'ASC']],
    transaction,
  });
  const refundItems = await RefundItem.findAll({
    include: [
      {
        model: Refund,
        as: 'refund',
        attributes: [],
        required: true,
        where: { sale_id: id },
      },
    ],
    subQuery: false,
    order: [['id', 'ASC']],
    transaction,
  });

  const base = toSaleRow(sale as SaleWithRefs);
  const paidAmount = round2(
    payments.reduce((sum, p) => sum + Number(p.amount), 0),
  );
  const refundedAmount = round2(refunds.reduce((sum, r) => sum + Number(r.amount), 0));
  const dueAmount = base.status === 'COMPLETED' ? round2(base.total_amount - paidAmount) : 0;

  return {
    ...base,
    items: (items as unknown as SaleItemWithRefs[]).map(toSaleItemRow),
    payments: (payments as unknown as PaymentWithRefs[]).map(toPaymentRow),
    refunds: (refunds as unknown as RefundWithRefs[]).map(toRefundRow),
    refund_items: refundItems.map((r) => ({
      id: r.id,
      refund_id: r.refund_id,
      sale_item_id: r.sale_item_id,
      qty: r.qty,
      condition: r.condition,
      unit_price: r.unit_price,
      subtotal: r.subtotal,
    })),
    paid_amount: paidAmount,
    refunded_amount: refundedAmount,
    due_amount: dueAmount < 0 ? 0 : dueAmount,
  };
}

export async function getSale(id: number): Promise<SaleDetail> {
  return fetchDetail(null, id);
}

/* ==================== pemilihan batch (auto-FIFO, terkunci) ==================== */

/**
 * Batch eksplisit dari kasir, atau auto-FIFO: batch dengan `qty_remaining > 0`
 * diurutkan `expired_date ASC NULLS LAST` lalu `id ASC` (batch paling lama/
 * paling cepat kedaluwarsa dulu).
 *
 * Baris batch dikunci `FOR UPDATE` di dalam transaksi yang sama dengan INSERT
 * `sale_items`, jadi 2 kasir selling produk yang sama TIDAK bisa menghitung
 * stok dari snapshot yang sama: kasir kedua menunggu, lalu membaca ulang baris
 * post-commit (READ COMMITTED + EvalPlanQual) sebelum INSERT. Stok & harga
 * tetap divalidasi ulang oleh trigger — pemindaian di sini hanya untuk pesan
 * error yang ramah.
 */
async function resolveBatch(
  transaction: Transaction,
  item: SaleInputItem,
): Promise<StockBatch> {
  if (item.batch_id) {
    const batch = await StockBatch.findByPk(item.batch_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!batch) {
      throw new ApiError('BATCH_NOT_FOUND', `Batch id=${item.batch_id} tidak ditemukan`);
    }
    if (batch.product_id !== item.product_id) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Batch ${batch.batch_code} bukan batch produk id=${item.product_id} — pilih batch dari daftar batch produk tersebut`,
      );
    }
    return batch;
  }

  const batch = await StockBatch.findOne({
    where: { product_id: item.product_id, qty_remaining: { [Op.gt]: 0 } },
    order: [
      ['expired_date', 'ASC'], // Postgres: NULLS LAST adalah default untuk ASC
      ['id', 'ASC'],
    ],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!batch) {
    throw new ApiError(
      'INSUFFICIENT_STOCK',
      `Stok tidak cukup untuk produk id=${item.product_id}: tidak ada batch aktif dengan stok tersisa`,
    );
  }
  return batch;
}

/* ====================== validasi method (level API) ====================== */

/**
 * Side API untuk aturan yang juga dijaga trigger `fn_payments_validate`,
 * supaya kasir dapat pesan jelas sebelum DB menolak. DB tetap penjaga terakhirnya.
 */
async function assertMethodUsable(
  transaction: Transaction,
  methodId: number,
  referenceNo?: string | null,
): Promise<{ code: string; requires_reference: boolean }> {
  const m = await PaymentMethod.scope('withInactive').findByPk(methodId, { transaction });
  if (!m) throw new ApiError('PAYMENT_METHOD_NOT_FOUND', `Metode pembayaran id=${methodId} tidak ditemukan`);
  if (!m.is_active) throw new ApiError('PAYMENT_METHOD_INACTIVE', 'Metode pembayaran tidak aktif');
  if (m.requires_reference && (referenceNo === undefined || referenceNo === null || referenceNo.trim() === '')) {
    throw new ApiError('REFERENCE_NO_REQUIRED', 'reference_no wajib untuk metode ini');
  }
  return { code: m.code, requires_reference: m.requires_reference };
}

async function insertPayment(
  transaction: Transaction,
  saleId: number,
  payment: SalePaymentInput,
  receivedBy: number | null,
): Promise<Payment> {
  await assertMethodUsable(transaction, payment.method_id, payment.reference_no);

  // CASH: uang diterima boleh lebih besar (kembalian = generated column change_amount).
  // Metode non-CASH: nominal yang diterima = amount.
  const tendered =
    payment.tendered_amount !== undefined && payment.tendered_amount !== null ? payment.tendered_amount : null;

  if (tendered !== null && tendered < payment.amount) {
    throw new ApiError('VALIDATION_ERROR', 'tendered_amount tidak boleh lebih kecil dari amount');
  }

  // `payment_status` TIDAK ikut ditulis: trigger trg_payments_sync_status yang
  // menghitungnya dari total pembayaran.
  return Payment.create(
    {
      sale_id: saleId,
      method_id: payment.method_id,
      amount: payment.amount,
      tendered_amount: tendered,
      reference_no: payment.reference_no ?? null,
      notes: payment.notes ?? null,
      received_by: receivedBy,
    },
    { transaction },
  );
}

/* ====================== konversi satuan jual (P2) ====================== */

/**
 * Item boleh dijual dalam satuan alternatif (mis. "pak" = 5 pcs).
 * Rasio dibaca dari product.unit_conversions JSONB -> qty dikonversi ke satuan dasar
 * dan unit_price diskalakan per satuan dasar (harga input = harga per satuan ALT).
 */
async function resolveQtyPriceNote(
  transaction: Transaction,
  item: SaleInputItem,
): Promise<{ qty: number; unitPrice: number; note: string | null }> {
  if (!item.unit) return { qty: item.qty, unitPrice: item.unit_price, note: item.note ?? null };

  const p = await Product.scope('withInactive').findByPk(item.product_id, { transaction });
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

/* ====================== POST /sales (checkout) ====================== */

/**
 * POS checkout = SATU transaksi DB:
 *   BEGIN -> INSERT sales (sale_no dari sequence)
 *          -> INSERT sale_items per item (trigger: validasi harga/stok + auto-deduct movement OUT)
 *          -> INSERT payments (opsional; trigger: overpay reject + sync payment_status)
 *          -> COMMIT
 * Gagal di tengah = ROLLBACK total (tidak ada sales yatim, stok tidak berkurang).
 * Dilingkupi Idempotency-Key agar retry multi-POS tidak menghasilkan 2 transaksi.
 *
 * `Idempotency-Key` WAJIB (middleware `requireIdempotencyKey`): retry dengan
 * key sama -> 200 + header `Idempotency-Replayed` + body identik (controller),
 * tanpa membuat transaksi kedua.
 */
export async function createSale(
  input: SaleInput,
  userId: number,
  idempotencyKey: string,
): Promise<{ sale: SaleDetail; replayed: boolean }> {
  try {
    const result = await runOrmIdempotent<SaleDetail>('POST /sales', idempotencyKey, async (transaction) => {
      // Kasbon (tanpa pembayaran awal) wajib atas nama customer — piutang tanpa
      // nama tidak bisa ditagih (menu-matrix.md §8; zod juga menolak, ini jaring
      // kedua untuk pemanggil internal seperti konversi order-book MP-7).
      if (input.payment == null && (input.customer_id === undefined || input.customer_id === null)) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'Penjualan tanpa pembayaran awal (kasbon) wajib menyertakan customer_id',
        );
      }

      if (input.customer_id !== undefined && input.customer_id !== null) {
        const c = await Customer.findByPk(input.customer_id, { attributes: ['id'], transaction });
        if (!c) {
          throw new ApiError('VALIDATION_ERROR', `Customer id=${input.customer_id} tidak ditemukan`);
        }
      }

      // Total dihitung dari request (bukan dari stok), lalu dikoreksi ke subtotal
      // stored generated column DB sebelum commit.
      const estimatedTotal = round2(input.items.reduce((sum, it) => sum + it.qty * it.unit_price, 0));

      const saleNo = await nextDocNo(transaction, 'sale', env.businessTz);
      const sale = await Sale.create(
        {
          sale_no: saleNo,
          customer_id: input.customer_id ?? null,
          total_amount: estimatedTotal,
          note: input.note ?? null,
          created_by: userId,
        },
        { transaction },
      );

      for (const item of input.items) {
        const batch = await resolveBatch(transaction, item);
        // Validasi ramah (kode error sama dengan hasil trigger), supaya kasir
        // tidak menerima 500 raw dari PostgreSQL.
        if (item.unit_price < batch.unit_cost) {
          throw new ApiError(
            'PRICE_BELOW_COST',
            `Harga jual (${item.unit_price}) tidak boleh di bawah harga beli batch ${batch.batch_code} (${batch.unit_cost})`,
          );
        }
        if (batch.qty_remaining < item.qty) {
          throw new ApiError(
            'INSUFFICIENT_STOCK',
            `Stok tidak cukup untuk produk id=${item.product_id}: tersedia ${batch.qty_remaining}, diminta ${item.qty}`,
          );
        }
        const { qty, unitPrice, note } = await resolveQtyPriceNote(transaction, item);
        // unit_cost diisi 0, ditimpa trigger dengan snapshot harga beli batch.
        await SaleItem.create(
          {
            sale_id: sale.id,
            product_id: item.product_id,
            batch_id: batch.id,
            qty,
            unit_price: unitPrice,
            unit_cost: 0,
            note,
          },
          { transaction },
        );
      }

      // Samakan total dengan subtotal tersimpan di DB (NUMERIC presisi penuh)
      // lalu tambahkan PPN (P2) bila diisi.
      const subtotal = round2(
        Number(
          (await SaleItem.sum('subtotal', { where: { sale_id: sale.id }, transaction })) ?? 0,
        ),
      );
      const taxPercent = input.tax_percent ?? 0;
      const taxAmount = round2((subtotal * taxPercent) / 100);
      await sale.update(
        { total_amount: round2(subtotal + taxAmount), tax_amount: taxAmount },
        { transaction },
      );

      if (input.payment) {
        if (input.payment.amount > sale.total_amount) {
          throw new ApiError(
            'PAYMENT_OVER_TOTAL',
            `Total pembayaran (${input.payment.amount}) melebihi total penjualan (${sale.total_amount})`,
          );
        }
        await insertPayment(transaction, sale.id, input.payment, userId);
      }

      const detail = await fetchDetail(transaction, sale.id);
      return { status: 201, body: detail };
    });

    return { sale: result.body, replayed: result.replayed };
  } catch (err) {
    throw mapOrmError(err);
  }
}

/* ====================== POST /sales/{id}/payments ====================== */

/**
 * Pembayaran lanjutan (DP / pelunasan). Kunci baris `sales` `FOR UPDATE` dulu:
 * total & `payment_status` tidak boleh berubah di tengah calculations, dan
 * insert payment kedua berbaris dengan payment pertama.
 */
export async function addPayment(
  saleId: number,
  payment: SalePaymentInput,
  userId: number,
  idempotencyKey: string,
): Promise<{ payment: PaymentRow; sale: SaleDetail; replayed: boolean }> {
  try {
    const result = await runOrmIdempotent<{ payment: PaymentRow; sale: SaleDetail }>(
      'POST /sales/{id}/payments',
      idempotencyKey,
      async (transaction) => {
        const sale = await Sale.findByPk(saleId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!sale) {
          throw new ApiError('NOT_FOUND', `Penjualan id=${saleId} tidak ditemukan`);
        }
        // Sama dengan guard `fn_payments_sync_status` (tanpa pembayaran tambahan
        // pada sale VOIDED/RETURNED), tapi dengan pesan yang jelas lebih dulu.
        if (sale.status !== 'COMPLETED') {
          throw new ApiError(
            'PAYMENT_NOT_ALLOWED',
            `Tidak dapat menambah pembayaran pada penjualan berstatus ${sale.status}`,
          );
        }

        const alreadyPaid = round2(
          Number((await Payment.sum('amount', { where: { sale_id: saleId }, transaction })) ?? 0),
        );
        const newPaid = round2(alreadyPaid + payment.amount);
        if (newPaid > round2(sale.total_amount)) {
          throw new ApiError(
            'PAYMENT_OVER_TOTAL',
            `Total pembayaran (${newPaid}) melebihi total penjualan (${round2(sale.total_amount)})`,
          );
        }

        const created = await insertPayment(transaction, saleId, payment, userId);
        const detail = await fetchDetail(transaction, saleId);
        const stored = detail.payments.find((p) => p.id === created.id)!;
        return { status: 201, body: { payment: stored, sale: detail } };
      },
    );

    return { ...result.body, replayed: result.replayed };
  } catch (err) {
    throw mapOrmError(err);
  }
}

export async function listPayments(saleId: number): Promise<PaymentRow[]> {
  const exists = await Sale.findByPk(saleId, { attributes: ['id'] });
  if (!exists) throw new ApiError('NOT_FOUND', `Penjualan id=${saleId} tidak ditemukan`);
  const rows = await Payment.findAll({
    where: { sale_id: saleId },
    include: PAYMENT_INCLUDES,
    subQuery: false,
    order: [['id', 'ASC']],
  });
  return (rows as unknown as PaymentWithRefs[]).map(toPaymentRow);
}

/* ============ void / retur: stok balik per item + kondisi ============ */

/**
 * Sejak 0005 trigger `fn_sales_void_apply` TIDAK lagi membuat movement IN
 * otomatis. Stok balik (void/retur/refund) sekarang ditulis di service ini
 * sebagai SATU PENULIS, per item dan BERKONDISI:
 *   GOOD -> movement IN -> trigger menambah `qty_remaining` (bisa dijual lagi)
 *   RUSAK -> movement IN -> trigger menambah `qty_damaged` (karantina)
 * Dengan begitu barang rusak punya jejak ledger tersendiri dan tidak terhitung
 * dua kali. `fn_sales_void` (validasi transisi status) tetap penjaga di DB.
 * Tidak ada endpoint DELETE untuk sale/item - ledger immutable.
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

/**
 * Σ qty `refund_items` per sale_item (dasar validasi refund parsial). SQL-nya
 * identik dengan versi lama; agregasi lewat `sequelize.query` karena ini
 * agregasi lintas-tabel (hybrid §D4 — nilainya tetap di-bind, bukan string).
 */
async function loadReturnableItems(
  transaction: Transaction,
  saleId: number,
): Promise<Map<number, ReturnableItem>> {
  const rows = (await sequelize.query(
    `SELECT si.id, si.product_id, si.batch_id, si.qty, si.unit_price, si.unit_cost,
            COALESCE((SELECT sum(ri.qty) FROM refund_items ri WHERE ri.sale_item_id = si.id), 0)::numeric(14,3) AS refunded_qty
       FROM sale_items si
      WHERE si.sale_id = $saleId
      ORDER BY si.id`,
    { bind: { saleId }, type: QueryTypes.SELECT, transaction },
  )) as ReturnableItem[];
  return new Map(rows.map((r) => [Number(r.id), r]));
}

/**
 * Tulis movement IN untuk barang yang kembali ke gudang. Konvensi kolom mengikuti
 * trigger lama (`fn_sales_void_apply`): `reference_type` VOID/RETURN,
 * `reference_id` = sale, `unit_cost` = snapshot `unit_cost` sale_items,
 * `created_by` = kasir yang membatalkan. `condition` menentukan kolom mana di
 * `stock_batches` yang berubah (`qty_remaining` atau `qty_damaged`).
 */
async function insertReturnMovements(
  transaction: Transaction,
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
    await StockMovement.create(
      {
        product_id: line.product_id,
        batch_id: line.batch_id,
        movement_type: 'IN',
        qty_change: line.qty,
        unit_cost: line.unit_cost,
        reference_type: opts.referenceType,
        reference_id: opts.saleId,
        note: line.condition === 'RUSAK' ? opts.noteDamaged : opts.noteGood,
        created_by: opts.userId,
        condition: line.condition,
      },
      { transaction },
    );
  }
}

/**
 * Susun daftar barang yang kembali ke gudang saat void (UC-C).
 * Tanpa `items` -> seluruh item sale kembali, semua GOOD (perilaku lama, kompatibel FE).
 * Dengan `items` -> satu baris BOLEH dipecah per kondisi (mis. 1 GOOD + 1 RUSAK dari
 * baris 2 pcs): entri dengan `qty` eksplisit diagregasi per (sale_item_id, kondisi);
 * entri tunggal tanpa `qty` = seluruh qty baris dengan kondisi itu (kompatibel lama).
 * Validasi: void = pembatalan UTUH — setiap item harus disebut dan total qty per item
 * harus sama dengan qty jual (stok tidak boleh hilang ataupun ganda).
 * Prakondisi (state machine) tetap diperiksa di aplikasi: trigger DB hanya memvalidasi
 * saat `status` benar-benar BERUBAH, sehingga void kedua pada sale yang sudah VOIDED
 * akan lolos bila tidak dicegah di sini.
 */
function planVoidReturn(
  saleId: number,
  items: Map<number, ReturnableItem>,
  requested: VoidItemInput[] | null,
): ReturnLine[] {
  if (!requested || requested.length === 0) {
    return [...items.values()].map((it) => ({
      product_id: it.product_id,
      batch_id: it.batch_id,
      qty: it.qty,
      unit_cost: it.unit_cost,
      condition: 'GOOD' as StockCondition,
    }));
  }

  // Agregasi per sale_item_id + kondisi (pola sama dengan planRefund).
  const wanted = new Map<number, { GOOD: number; RUSAK: number; implicit: boolean }>();
  for (const r of requested) {
    const it = items.get(r.sale_item_id);
    if (!it) {
      throw new ApiError('VOID_ITEM_MISMATCH', `sale_item_id=${r.sale_item_id} bukan item dari penjualan #${saleId}`);
    }
    const condition: StockCondition = r.condition === 'RUSAK' ? 'RUSAK' : 'GOOD';
    const bucket = wanted.get(r.sale_item_id) ?? { GOOD: 0, RUSAK: 0, implicit: false };
    if (typeof r.qty === 'number' && Number.isFinite(r.qty)) {
      if (r.qty <= 0) {
        throw new ApiError('VALIDATION_ERROR', `qty void untuk sale_item_id=${r.sale_item_id} harus lebih besar dari 0`);
      }
      if (bucket.implicit) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `campuran entri dengan dan tanpa qty untuk sale_item_id=${r.sale_item_id} tidak diizinkan`,
        );
      }
      bucket[condition] += r.qty;
    } else {
      if (bucket.GOOD > 0 || bucket.RUSAK > 0 || bucket.implicit) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `entri tanpa qty untuk sale_item_id=${r.sale_item_id} hanya boleh satu (gunakan qty eksplisit untuk memecah kondisi)`,
        );
      }
      bucket[condition] = it.qty;
      bucket.implicit = true;
    }
    wanted.set(r.sale_item_id, bucket);
  }

  // Void = pembatalan utuh: semua item harus tercakup, Σ qty per item = qty jual.
  const lines: ReturnLine[] = [];
  for (const it of items.values()) {
    const bucket = wanted.get(it.id);
    if (!bucket) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `semua item harus dikembalikan saat void: sale_item_id=${it.id} belum disebut`,
      );
    }
    const total = round3(bucket.GOOD + bucket.RUSAK);
    if (Math.abs(total - it.qty) > 0.0005) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `total qty void untuk sale_item_id=${it.id} (${total}) harus sama dengan qty jual (${it.qty})`,
      );
    }
    for (const condition of ['GOOD', 'RUSAK'] as const) {
      const qty = round3(bucket[condition]);
      if (qty > 0) {
        lines.push({ product_id: it.product_id, batch_id: it.batch_id, qty, unit_cost: it.unit_cost, condition });
      }
    }
  }
  return lines;
}

/** POST /sales/{id}/void - hanya untuk penjualan yang belum dibayar. */
export async function voidSale(
  saleId: number,
  reason: string,
  userId: number,
  requested?: VoidItemInput[] | null,
): Promise<SaleDetail> {
  try {
    return await withOrmTx(async (transaction) => {
      const current = await Sale.findByPk(saleId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!current) {
        throw new ApiError('NOT_FOUND', `Penjualan id=${saleId} tidak ditemukan`);
      }

      const { status, payment_status } = current;
      if (status !== 'COMPLETED') {
        throw new ApiError('TRANSITION_NOT_ALLOWED', `Penjualan sudah berstatus ${status}, tidak bisa di-void lagi`);
      }
      // VOIDED hanya untuk yang belum dibayar; yang sudah dibayar wajib lewat refund.
      if (payment_status !== 'UNPAID') {
        throw new ApiError('VOID_NOT_ALLOWED', 'Tidak dapat void penjualan yang sudah dibayar; gunakan retur/refund');
      }

      const items = await loadReturnableItems(transaction, saleId);
      const lines = planVoidReturn(saleId, items, requested ?? null);

      // `voided_at` diisi trigger `trg_sales_void` (COALESCE(now())) — jangan
      // ditulis di sini supaya metadata void tetap milik DB.
      await current.update({ status: 'VOIDED', voided_by: userId, void_reason: reason }, { transaction });

      await insertReturnMovements(transaction, {
        saleId,
        lines,
        referenceType: 'VOID',
        noteGood: 'Void penjualan',
        noteDamaged: 'Void penjualan - rusak',
        userId,
      });

      return fetchDetail(transaction, saleId);
    }, 'void');
  } catch (err) {
    throw mapOrmError(err);
  }
}

/* ====================== refund / retur (parsial) ====================== */

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
 *
 * Catatan uang: TIDAK ada baris `payments` negatif dan TIDAK ada write-off opex
 * di sini — sama seperti versi lama (`git show e33b3b5:...`). Uang keluar dicatat
 * sebagai pengurangan `refunded_amount`; sesi kas (opening/closing) yang
 * memasukkan_refund ke perhitungan kas baru ada di MP-5.
 */
export async function refundSale(
  saleId: number,
  input: RefundInput,
  userId: number,
  idempotencyKey: string,
): Promise<{ sale: SaleDetail; replayed: boolean }> {
  try {
    const result = await runOrmIdempotent<SaleDetail>('POST /sales/{id}/refund', idempotencyKey, async (transaction) => {
      const current = await Sale.findByPk(saleId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!current) throw new ApiError('NOT_FOUND', `Penjualan id=${saleId} tidak ditemukan`);
      if (current.status !== 'COMPLETED') {
        throw new ApiError('TRANSITION_NOT_ALLOWED', `Penjualan sudah berstatus ${current.status}, tidak bisa diretur lagi`);
      }
      if (current.payment_status === 'UNPAID') {
        throw new ApiError('REFUND_NOT_ALLOWED', 'Penjualan belum dibayar; gunakan void untuk membatalkan penjualan');
      }

      const items = await loadReturnableItems(transaction, saleId);
      const plan = planRefund(saleId, items, input.items);

      const payments = await Payment.findAll({
        where: { sale_id: saleId },
        order: [['id', 'ASC']],
        transaction,
      });
      const refunds = await Refund.findAll({ where: { sale_id: saleId }, transaction });
      const paidAmount = round2(payments.reduce((sum, p) => sum + Number(p.amount), 0));
      const refundedAmount = round2(refunds.reduce((sum, r) => sum + Number(r.amount), 0));
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
      const lastPayment = payments.length > 0 ? payments[payments.length - 1]! : null;
      const methodId = input.method_id ?? lastPayment?.method_id ?? null;
      if (methodId !== null) {
        await assertMethodUsable(transaction, methodId);
      }

      const refund = await Refund.create(
        {
          sale_id: saleId,
          method_id: methodId,
          amount: plan.total,
          reason: input.reason,
          refunded_by: userId,
        },
        { transaction },
      );

      for (const line of plan.lines) {
        await RefundItem.create(
          {
            refund_id: refund.id,
            sale_item_id: line.sale_item_id,
            qty: line.qty,
            condition: line.condition,
            unit_price: line.unit_price,
            subtotal: line.subtotal,
          },
          { transaction },
        );
      }

      await insertReturnMovements(transaction, {
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
        await current.update(
          { status: 'RETURNED', voided_by: userId, void_reason: `REFUND: ${input.reason}` },
          { transaction },
        );
      }

      const detail = await fetchDetail(transaction, saleId);
      return { status: 200, body: detail };
    });

    return { sale: result.body, replayed: result.replayed };
  } catch (err) {
    throw mapOrmError(err);
  }
}