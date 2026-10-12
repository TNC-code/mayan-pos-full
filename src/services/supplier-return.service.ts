import { Op, Sequelize, type Includeable, type Transaction } from 'sequelize';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { round2, round3 } from '../utils/tx.js';
import { mapOrmError } from '../utils/orm-errors.js';
import {
  PaymentMethod,
  Product,
  StockBatch,
  StockMovement,
  SupplierReturn,
  SupplierReturnItem,
  UserAccount,
  sequelize,
  type SupplierReturnSettleType,
  type SupplierReturnStatus,
} from '../models/index.js';
import { nextDocNo } from './docno.js';
import { getWriteOffExpense, recordWriteOffExpense, type ExpenseRow } from './expense.service.js';
import { runOrmIdempotent } from './idempotency.service.js';

/**
 * Retur barang RUSAK ke distributor di atas Sequelize (MP-6, UC-B).
 *
 * Paritas penuh dengan versi raw SQL lama
 * (`git show e33b3b5:src/services/supplier-return.service.ts`) — bentuk response
 * (`SupplierReturnRow`/`SupplierReturnItemRow`/`SupplierReturnDetail`), urutan
 * list (`id DESC`), syarat `return_no`, dan aturan atomicity:
 *
 *   create  : kunci batch (FOR UPDATE) -> cek qty_damaged -> insert header
 *             -> insert item -> movement OUT condition RUSAK per batch.
 *             Stok TIDAK pernah disentuh aplikasi: trigger
 *             `trg_stock_movement_apply` yang mengurang `stock_batches.qty_damaged`
 *             (dan trigger itulah penjaga terakhir kalau validasi aplikasi
 *             terlewat) — ledger tetap append-only
 *             (`trg_stock_movement_immutable`).
 *   settle  : kunci header (FOR UPDATE) -> guard status PENDING -> update
 *             REFUNDED, atau update WRITTEN_OFF + opex write-off OTOMATIS
 *             di transaksi yang sama. Gagal di tengah = ROLLBACK total
 *             (tidak ada retur setengah jadi, tidak ada opex yatim).
 *
 * Idempotency memakai `runOrmIdempotent` (MP-4) dengan payload/tabel yang sama
 * dengan `runIdempotent` raw yang dihapus di fase ini, jadi key yang pernah
 * dibuat versi lama tetap bisa di-replay.
 */

export type { SupplierReturnStatus, SupplierReturnSettleType };

/* ============================== types ============================== */

export interface SupplierReturnRow {
  id: number;
  return_no: string;
  supplier_name: string;
  status: SupplierReturnStatus;
  total_cost: number;
  refunded_amount: number | null;
  refunded_method_id: number | null;
  refunded_method_code: string | null;
  refunded_method_name: string | null;
  refund_reference_no: string | null;
  refunded_at: string | null;
  settled_by: number | null;
  settled_by_name: string | null;
  note: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  /** true = retur dari skrip uji; dikecualikan dari `refund_distributor` P&L kecuali diminta. */
  is_test: boolean;
  item_count?: number;
  total_qty?: number;
}

export interface SupplierReturnItemRow {
  id: number;
  return_id: number;
  product_id: number;
  product_name: string | null;
  unit: string | null;
  batch_id: number | null;
  batch_code: string | null;
  qty: number;
  unit_cost: number;
  condition: string;
  subtotal: number;
}

export interface SupplierReturnDetail extends SupplierReturnRow {
  items: SupplierReturnItemRow[];
  /** Opex otomatis dari settle WRITTEN_OFF (null bila belum disettle / REFUNDED). */
  write_off_expense: ExpenseRow | null;
}

export interface SupplierReturnInputItem {
  batch_id: number;
  qty: number;
  /** Default = unit_cost batch (harga beli saat barang masuk). */
  unit_cost?: number | null;
}

export interface SupplierReturnInput {
  supplier_name: string;
  items: SupplierReturnInputItem[];
  note?: string | null;
  /**
   * Tanda data uji (T9, kolom `supplier_returns.is_test`). Default false = retur produksi.
   * Boleh diisi dari body agar e2e/agen skrip menandai sejak awal, tidak harus menunggu
   * `npm run mark-test-data`. Opex write-off turunannya mewarisi nilai ini.
   */
  is_test?: boolean | null;
}

export type SupplierReturnSettleInput =
  | {
      result: 'REFUNDED';
      amount: number;
      method_id?: number | null;
      reference_no?: string | null;
      note?: string | null;
    }
  | {
      result: 'WRITTEN_OFF';
      note?: string | null;
    };

/* ============================ includes ============================ */

const WITH_CREATOR: Includeable = {
  model: UserAccount,
  as: 'creator',
  attributes: ['id', 'username'],
  required: false,
};

const WITH_SETTLER: Includeable = {
  model: UserAccount,
  as: 'settledBy',
  attributes: ['id', 'username'],
  required: false,
};

// Metode pembayaran punya default scope `is_active = true`, sedangkan
// `LEFT JOIN payment_methods m ON m.id = r.refunded_method_id` versi lama tidak
// memfilternya -> retur lama yang dibayar lewat metode yang lalu dinonaktifkan
// tetap harus menampilkan kode/nama metodenya.
const WITH_REFUNDED_METHOD: Includeable = {
  model: PaymentMethod.scope('withInactive'),
  as: 'refundedMethod',
  attributes: ['id', 'code', 'name'],
  required: false,
};

const RETURN_INCLUDES: Includeable[] = [WITH_CREATOR, WITH_SETTLER, WITH_REFUNDED_METHOD];

const ITEM_INCLUDES: Includeable[] = [
  // JOIN produk versi lama = INNER JOIN & tanpa filter is_active.
  { model: Product.scope('withInactive'), as: 'product', attributes: ['id', 'name', 'unit'], required: true },
  { model: StockBatch, as: 'batch', attributes: ['id', 'batch_code'], required: false },
];

type SupplierReturnWithRefs = SupplierReturn & {
  creator?: { id: number; username: string } | null;
  settledBy?: { id: number; username: string } | null;
  refundedMethod?: { id: number; code: string; name: string } | null;
};

type SupplierReturnItemWithRefs = SupplierReturnItem & {
  product?: { id: number; name: string | null; unit: string | null } | null;
  batch?: { id: number; batch_code: string | null } | null;
};

/** `timestamptz` -> string ISO (sama seperti `pool.query` lama yang mengembalikan Date). */
function iso(value: Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toReturnRow(row: SupplierReturnWithRefs, itemCount: number, totalQty: number): SupplierReturnRow {
  return {
    id: row.id,
    return_no: row.return_no,
    supplier_name: row.supplier_name,
    status: row.status,
    total_cost: row.total_cost,
    refunded_amount: row.refunded_amount,
    refunded_method_id: row.refunded_method_id,
    refunded_method_code: row.refundedMethod?.code ?? null,
    refunded_method_name: row.refundedMethod?.name ?? null,
    refund_reference_no: row.refund_reference_no,
    refunded_at: iso(row.refunded_at),
    settled_by: row.settled_by,
    settled_by_name: row.settledBy?.username ?? null,
    note: row.note,
    created_by: row.created_by,
    created_by_name: row.creator?.username ?? null,
    created_at: new Date(row.created_at).toISOString(),
    is_test: row.is_test,
    item_count: itemCount,
    total_qty: totalQty,
  };
}

function toItemRow(row: SupplierReturnItemWithRefs): SupplierReturnItemRow {
  return {
    id: row.id,
    return_id: row.return_id,
    product_id: row.product_id,
    product_name: row.product?.name ?? null,
    unit: row.product?.unit ?? null,
    batch_id: row.batch_id,
    batch_code: row.batch?.batch_code ?? null,
    qty: row.qty,
    unit_cost: row.unit_cost,
    condition: row.condition,
    // Tidak ada kolom `subtotal` di DB: dihitung di sini seperti SELECT lama
    // (`(i.qty * i.unit_cost)::numeric(14,2)`).
    subtotal: round2(row.qty * row.unit_cost),
  };
}

/* ============================== getter ============================== */

export interface SupplierReturnListQuery {
  status?: string;
  supplier_name?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
  limit: number;
  offset: number;
}

/** Alias tabel yang dipakai Sequelize di SQL hasil `findAll` (nama model class). */
const RETURN_ALIAS = 'SupplierReturn';

/**
 * `GET /supplier-returns` — riwayat retur (default `id DESC`).
 * `item_count`/`total_qty` berasal dari subquery SELECT versi lama; di sini
 * dihitung dari satu query agregat kecil untuk id-id yang sudah terpaginasi
 * (menghindari dua subquery korelasi per baris pada daftar panjang).
 */
export async function listSupplierReturns(params: SupplierReturnListQuery): Promise<SupplierReturnRow[]> {
  const conditions: Record<string, unknown>[] = [];

  if (params.status) conditions.push({ status: params.status });
  if (params.supplier_name) conditions.push({ supplier_name: { [Op.iLike]: params.supplier_name } });
  if (params.q) {
    const like = `%${params.q}%`;
    conditions.push({ [Op.or]: [{ return_no: { [Op.iLike]: like } }, { supplier_name: { [Op.iLike]: like } }] });
  }

  // Tanggal retur = tanggal dibuatnya dokumen retur, dalam zona waktu bisnis —
  // literal + `sequelize.escape` (nilai user di-bind, tidak di-interpolasi).
  // Kolom harus dirujuk lewat ALIAS tabel yang dibuat Sequelize (`"SupplierReturn"`),
  // bukan nama tabel, karena `created_at` juga ada di tabel yang di-JOIN.
  const tzLiteral = sequelize.escape(env.businessTz);
  const localDate = (op: '>=' | '<=', value: string) =>
    Sequelize.literal(`("${RETURN_ALIAS}"."created_at" AT TIME ZONE ${tzLiteral})::date ${op} ${sequelize.escape(value)}`);
  if (params.date_from) conditions.push(localDate('>=', params.date_from) as never);
  if (params.date_to) conditions.push(localDate('<=', params.date_to) as never);

  const rows = await SupplierReturn.findAll({
    where: { [Op.and]: conditions },
    include: RETURN_INCLUDES,
    // Semua include 1:1 (belongsTo) -> jumlah baris tidak berubah, LIMIT aman.
    subQuery: false,
    order: [['id', 'DESC']],
    limit: params.limit,
    offset: params.offset,
  });

  const list = rows as unknown as SupplierReturnWithRefs[];
  if (list.length === 0) return [];

  const items = await SupplierReturnItem.findAll({
    where: { return_id: { [Op.in]: list.map((r) => r.id) } },
    attributes: ['return_id', 'qty'],
    raw: true,
  });

  const totals = new Map<number, { count: number; qty: number }>();
  for (const item of items) {
    const acc = totals.get(item.return_id) ?? { count: 0, qty: 0 };
    acc.count += 1;
    acc.qty += item.qty;
    totals.set(item.return_id, acc);
  }

  return list.map((row) => {
    const acc = totals.get(row.id);
    return toReturnRow(row, acc?.count ?? 0, acc ? round3(acc.qty) : 0);
  });
}

/**
 * Header + item + opex write-off satu retur. Boleh dipanggil dalam transaksi
 * (langsung setelah create/settle) supaya respons sudah memuat efek baris baru.
 */
async function fetchDetail(transaction: Transaction | null, id: number): Promise<SupplierReturnDetail> {
  const head = await SupplierReturn.findByPk(id, { include: RETURN_INCLUDES, transaction });
  if (!head) {
    throw new ApiError('NOT_FOUND', `Retur distributor id=${id} tidak ditemukan`);
  }

  const items = await SupplierReturnItem.findAll({
    where: { return_id: id },
    include: ITEM_INCLUDES,
    subQuery: false,
    order: [['id', 'ASC']],
    transaction,
  });
  const itemRows = (items as unknown as SupplierReturnItemWithRefs[]).map(toItemRow);
  const expense = await getWriteOffExpense(transaction, id);

  return {
    ...toReturnRow(
      head as unknown as SupplierReturnWithRefs,
      itemRows.length,
      round3(itemRows.reduce((sum, i) => sum + i.qty, 0)),
    ),
    items: itemRows,
    write_off_expense: expense,
  };
}

export async function getSupplierReturn(id: number): Promise<SupplierReturnDetail> {
  return fetchDetail(null, id);
}

/* ========================= helper validasi ========================= */

/**
 * Kunci baris batch (FOR UPDATE) lalu pastikan qty_damaged cukup.
 * BARANG RUSAK hanya boleh keluar lewat retur distributor, jadi penjaga utamanya
 * ada di trigger fn_stock_movement_apply ("Stok rusak batch ... tidak cukup");
 * pengecekan di sini supaya pesannya jelas sebelum DB yang menolak.
 */
async function assertDamagedAvailable(
  transaction: Transaction,
  batchId: number,
  qty: number,
): Promise<{ product_id: number; batch_code: string; unit_cost: number; qty_damaged: number }> {
  const batch = await StockBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!batch) {
    throw new ApiError('BATCH_NOT_FOUND', `Batch id=${batchId} tidak ditemukan`);
  }

  const available = Number(batch.qty_damaged);
  if (round3(available - qty) < 0) {
    throw new ApiError(
      'DAMAGED_QTY_INSUFFICIENT',
      `Stok rusak batch ${batch.batch_code} tidak cukup: tersedia ${available}, diminta ${qty}`,
    );
  }
  return {
    product_id: batch.product_id,
    batch_code: batch.batch_code,
    unit_cost: Number(batch.unit_cost),
    qty_damaged: available,
  };
}

/**
 * Metode pembayaran harus ada & aktif (distributor membayar balik lewat kanal ini).
 * `scope('withInactive')` wajib: SELECT lama `FROM payment_methods WHERE id=$1`
 * tidak memfilter `is_active`, jadi metode nonaktif harus menghasilkan
 * 422 PAYMENT_METHOD_INACTIVE (bukan "tidak ditemukan").
 */
async function assertMethodUsable(transaction: Transaction, methodId: number): Promise<PaymentMethod> {
  const method = await PaymentMethod.scope('withInactive').findByPk(methodId, { transaction });
  if (!method) throw new ApiError('PAYMENT_METHOD_NOT_FOUND', `Metode pembayaran id=${methodId} tidak ditemukan`);
  if (!method.is_active) throw new ApiError('PAYMENT_METHOD_INACTIVE', 'Metode pembayaran tidak aktif');
  return method;
}

/* ===================== POST /supplier-returns (UC-B) ===================== */

/**
 * Retur barang rusak ke distributor (UC-B), SATU transaksi DB:
 *   1. kunci batch tiap item (FOR UPDATE) + validasi qty <= qty_damaged
 *   2. insert header `supplier_returns` (status PENDING, total_cost = Σ qty × unit_cost)
 *   3. insert `supplier_return_items`
 *   4. insert `stock_movements OUT` condition RUSAK, reference SUPPLIER_RETURN
 *      -> trigger fn_stock_movement_apply yang mengurang qty_damaged (aplikasi TIDAK
 *         menghitung stok sendiri).
 * Dilingkupi Idempotency-Key agar retry tidak membuat retur ganda.
 */
export async function createSupplierReturn(
  input: SupplierReturnInput,
  userId: number,
  idempotencyKey: string,
): Promise<{ supplierReturn: SupplierReturnDetail; replayed: boolean }> {
  const seen = new Set<number>();
  for (const item of input.items) {
    if (seen.has(item.batch_id)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `batch_id=${item.batch_id} muncul lebih dari sekali pada retur yang sama`,
      );
    }
    seen.add(item.batch_id);
  }

  try {
    const result = await runOrmIdempotent<SupplierReturnDetail>(
      'POST /supplier-returns',
      idempotencyKey,
      async (transaction) => {
        // Kunci semua batch lebih dulu (urut id) supaya dua kasir retur batch yang sama
        // tidak saling menimpa angka qty_damaged (deadlock dihindari dengan urutan tetap).
        const ordered = [...input.items].sort((a, b) => a.batch_id - b.batch_id);

        const lines: Array<{
          batch_id: number;
          product_id: number;
          batch_code: string;
          qty: number;
          unit_cost: number;
          subtotal: number;
        }> = [];

        for (const item of ordered) {
          if (!Number.isFinite(item.qty) || item.qty <= 0) {
            throw new ApiError('VALIDATION_ERROR', `qty retur untuk batch id=${item.batch_id} harus lebih besar dari 0`);
          }
          const batch = await assertDamagedAvailable(transaction, item.batch_id, item.qty);
          const unitCost = item.unit_cost ?? batch.unit_cost;
          if (!Number.isFinite(unitCost) || unitCost < 0) {
            throw new ApiError('VALIDATION_ERROR', `unit_cost untuk batch id=${item.batch_id} tidak boleh negatif`);
          }
          lines.push({
            batch_id: item.batch_id,
            product_id: batch.product_id,
            batch_code: batch.batch_code,
            qty: round3(item.qty),
            unit_cost: round2(unitCost),
            subtotal: round2(round3(item.qty) * round2(unitCost)),
          });
        }

        const totalCost = round2(lines.reduce((sum, l) => sum + l.subtotal, 0));

        const returnNo = await nextDocNo(transaction, 'supplierReturn', env.businessTz);
        const supplierReturn = await SupplierReturn.create(
          {
            return_no: returnNo,
            supplier_name: input.supplier_name.trim(),
            status: 'PENDING',
            total_cost: totalCost,
            note: input.note ?? null,
            created_by: userId,
            is_test: input.is_test ?? false,
          },
          { transaction },
        );

        for (const line of lines) {
          await SupplierReturnItem.create(
            {
              return_id: supplierReturn.id,
              product_id: line.product_id,
              batch_id: line.batch_id,
              qty: line.qty,
              unit_cost: line.unit_cost,
              condition: 'RUSAK',
            },
            { transaction },
          );

          // OUT barang rusak -> trigger mengurangi qty_damaged batch tersebut.
          await StockMovement.create(
            {
              product_id: line.product_id,
              batch_id: line.batch_id,
              movement_type: 'OUT',
              qty_change: -line.qty,
              unit_cost: line.unit_cost,
              reference_type: 'SUPPLIER_RETURN',
              reference_id: supplierReturn.id,
              note: `Retur distributor ${returnNo}: ${line.qty} rusak dari batch ${line.batch_code} ke ${input.supplier_name.trim()}`,
              created_by: userId,
              condition: 'RUSAK',
            },
            { transaction },
          );
        }

        return { status: 201, body: await fetchDetail(transaction, supplierReturn.id) };
      },
    );

    return { supplierReturn: result.body, replayed: result.replayed };
  } catch (err) {
    throw mapOrmError(err);
  }
}

/* ================ POST /supplier-returns/{id}/settle (UC-B) ================ */

/**
 * Penyelesaian retur distributor, dua kemungkinan (discriminated union di zod):
 *  - REFUNDED   : distributor mengembalikan uang -> isi refunded_* + status REFUNDED
 *  - WRITTEN_OFF: distributor menolak -> status WRITTEN_OFF + OTOMATIS jadi opex
 *                  BARANG_RUSAK (source SUPPLIER_RETURN, ter-link supplier_return_id)
 *                  di transaksi yang SAMA.
 * Guard: status harus PENDING, selain itu 409 SUPPLIER_RETURN_SETTLED.
 */
export async function settleSupplierReturn(
  id: number,
  input: SupplierReturnSettleInput,
  userId: number,
  idempotencyKey: string,
): Promise<{ supplierReturn: SupplierReturnDetail; replayed: boolean }> {
  try {
    // Scope memuat id konkret: key yang sama untuk 2 retur berbeda tidak boleh
    // me-replay response retur sebelumnya.
    const result = await runOrmIdempotent<SupplierReturnDetail>(
      `POST /supplier-returns/${id}/settle`,
      idempotencyKey,
      async (transaction) => {
        const supplierReturn = await SupplierReturn.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!supplierReturn) {
          throw new ApiError('NOT_FOUND', `Retur distributor id=${id} tidak ditemukan`);
        }
        if (supplierReturn.status !== 'PENDING') {
          throw new ApiError(
            'SUPPLIER_RETURN_SETTLED',
            `Retur distributor ${supplierReturn.return_no} sudah berstatus ${supplierReturn.status}, tidak bisa disettle lagi`,
          );
        }

        const totalCost = round2(Number(supplierReturn.total_cost));

        if (input.result === 'REFUNDED') {
          if (!Number.isFinite(input.amount) || input.amount <= 0) {
            throw new ApiError('VALIDATION_ERROR', 'amount refund distributor harus lebih besar dari 0');
          }
          if (round2(input.amount) > totalCost) {
            throw new ApiError(
              'REFUND_AMOUNT_EXCEEDED',
              `Refund distributor ${round2(input.amount)} melebihi total biaya retur ${supplierReturn.return_no} (${totalCost})`,
            );
          }
          if (input.method_id !== undefined && input.method_id !== null) {
            const method = await assertMethodUsable(transaction, input.method_id);
            // Metode yang butuh bukti transfer (mis. BANK_TRANSFER) wajib punya
            // reference_no — padanan aturan trigger `fn_payments_validate`
            // (422 REFERENCE_NO_REQUIRED) supaya pesannya ramah, bukan 500 mentah.
            const reference = input.reference_no?.trim();
            if (method.requires_reference && !reference) {
              throw new ApiError(
                'REFERENCE_NO_REQUIRED',
                `reference_no wajib diisi untuk metode pembayaran ${method.code}`,
              );
            }
          }

          await supplierReturn.update(
            {
              status: 'REFUNDED',
              refunded_amount: round2(input.amount),
              refunded_method_id: input.method_id ?? null,
              refund_reference_no: input.reference_no ?? null,
              refunded_at: new Date(),
              settled_by: userId,
              // `note: undefined` = kolom tidak ikut di-update (COALESCE versi lama).
              ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
            },
            { transaction },
          );
        } else {
          await supplierReturn.update(
            {
              status: 'WRITTEN_OFF',
              settled_by: userId,
              ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
            },
            { transaction },
          );

          // Opex otomatis DALAM transaksi yang sama: retur + opex atomik.
          // is_test opex mewarisi tanda retur, supaya write-off retur uji tidak masuk P&L produksi.
          await recordWriteOffExpense(transaction, {
            supplier_return_id: id,
            return_no: supplierReturn.return_no,
            supplier_name: supplierReturn.supplier_name,
            amount: totalCost,
            created_by: userId,
            note: input.note ?? null,
            is_test: supplierReturn.is_test,
          });
        }

        return { status: 200, body: await fetchDetail(transaction, id) };
      },
    );

    return { supplierReturn: result.body, replayed: result.replayed };
  } catch (err) {
    throw mapOrmError(err);
  }
}