import { Op, QueryTypes, type Includeable, type Transaction } from 'sequelize';
import { ApiError } from '../utils/errors.js';
import { mapOrmError } from '../utils/orm-errors.js';
import { isoDateOnly } from '../utils/dates.js';
import { withOrmTx } from '../utils/tx.js';
import { env } from '../config/env.js';
import { Product, StockBatch, StockMovement, UserAccount, sequelize } from '../models/index.js';
import { nextDocNo } from './docno.js';

/**
 * Barang masuk (pembelian) di atas Sequelize (MP-3).
 *
 * Perilaku DISAMAKAN PERSIS dengan versi raw SQL lama
 * (`git show HEAD~2:src/services/purchase.service.ts`):
 *  - satu batch + satu movement `IN` per pembelian dalam SATU transaksi;
 *    `qty_remaining` SELALU ditulis trigger `trg_stock_movement_apply` dari
 *    `qty_change` — aplikasi tidak pernah menghitung/mutasi stok sendiri;
 *  - `batch_code` dari sequence DB `GRN-YYYYMMDD-NNN` (aman 2 kasir bersamaan);
 *  - `suggested_price` = generated column DB (unit_cost + markup AMOUNT/PERCENT);
 *  - top-up `merge_into_batch_id`: produk sama + `unit_cost` IDENTIK, pricing
 *    mengikuti batch tujuan, `qty_received` dijumlah DULU (constraint
 *    `chk_batch_remaining_le_received`), lalu movement IN per-event;
 *  - `updateBatch`: guard "batch belum pernah dipakai" (4 pemeriksaan), qty baru
 *    > 0, `batch_code`/`product_id` terkunci, perubahan qty dicatat sebagai
 *    movement `ADJUSTMENT`, dan arah tulis batch/movement mengikuti arah
 *    perubahan qty supaya constraint per-statement tetap terpenuhi;
 *  - response `BatchRow` = bentuk SQL lama (termasuk `unit`; `expired_date`
 *    diserialisasi lewat `utils/dates.ts`).
 *
 * Yang TIDAK digandakan di sini: validasi stok/constraint/penyelarasan harga
 * produk tetap milik trigger DB (`trg_stock_movement_apply`,
 * `trg_batch_update_product_cost`, …). Lapisan aplikasi hanya menambah
 * validasi ramah ber-`ApiError` (produk tidak ada, batch milik produk lain,
 * harga beli beda, batch sudah terpakai) sebelum SQL jalan.
 *
 * Catatan include: `Product` punya default scope `is_active = true`, sedangkan
 * JOIN lama tidak memfilternya -> semua include produk memakai `.scope('withInactive')`.
 */

export interface BatchRow {
  id: number;
  batch_code: string;
  product_id: number;
  product_name: string | null;
  /** Ada di JSON lama (`p.unit`) walau interface lama tidak mendeklarasikannya. */
  unit: string | null;
  qty_received: number;
  qty_remaining: number;
  unit_cost: number;
  /** Mode markup harga jual usulan: AMOUNT (Rp/pcs) | PERCENT (%) | NULL (batch lama). */
  markup_type: 'AMOUNT' | 'PERCENT' | null;
  markup_value: number;
  /** Generated column DB: harga jual usulan batch ini (req #4: harga beli + markup). */
  suggested_price: number;
  expired_date: string | null;
  supplier: string | null;
  note: string | null;
  received_at: string;
  created_by: number | null;
  created_by_name: string | null;
}

const WITH_PRODUCT: Includeable = {
  model: Product.scope('withInactive'),
  as: 'product',
  attributes: ['id', 'name', 'unit', 'barcode'],
  required: true,
};

const WITH_CREATOR: Includeable = {
  model: UserAccount,
  as: 'creator',
  attributes: ['id', 'username'],
  required: false,
};

const BATCH_INCLUDES: Includeable[] = [WITH_PRODUCT, WITH_CREATOR];

type BatchWithRefs = StockBatch & {
  product?: { id: number; name: string | null; unit: string | null; barcode: string | null } | null;
  creator?: { id: number; username: string } | null;
};

function toBatchRow(row: BatchWithRefs): BatchRow {
  return {
    id: row.id,
    batch_code: row.batch_code,
    product_id: row.product_id,
    product_name: row.product?.name ?? null,
    unit: row.product?.unit ?? null,
    qty_received: row.qty_received,
    qty_remaining: row.qty_remaining,
    unit_cost: row.unit_cost,
    markup_type: row.markup_type,
    markup_value: row.markup_value,
    suggested_price: row.suggested_price,
    expired_date: isoDateOnly(row.expired_date),
    supplier: row.supplier,
    note: row.note,
    received_at: new Date(row.received_at).toISOString(),
    created_by: row.created_by,
    created_by_name: row.creator?.username ?? null,
  };
}

/* ============================== daftar pembelian ============================== */

export interface PurchaseListQuery {
  product_id?: number;
  q?: string;
  active_only?: boolean;
  limit: number;
  offset: number;
}

/**
 * `GET /purchases` — daftar batch barang masuk.
 * `active_only=true` -> hanya batch yang masih punya sisa stok (`qty_remaining > 0`).
 */
export async function listPurchases(params: PurchaseListQuery): Promise<BatchRow[]> {
  const conditions: Record<string, unknown>[] = [];
  if (params.product_id !== undefined) conditions.push({ product_id: params.product_id });
  if (params.q) {
    const like = `%${params.q}%`;
    conditions.push({
      [Op.or]: [
        { '$product.name$': { [Op.iLike]: like } },
        { batch_code: { [Op.iLike]: like } },
        { '$product.barcode$': { [Op.iLike]: like } },
      ],
    });
  }
  if (params.active_only) conditions.push({ qty_remaining: { [Op.gt]: 0 } });

  const rows = await StockBatch.findAll({
    where: { [Op.and]: conditions },
    include: BATCH_INCLUDES,
    // `subQuery: false` karena semua include 1:1 (belongsTo) — jumlah baris
    // tidak berubah, jadi LIMIT/OFFSET aman tanpa subquery.
    subQuery: false,
    order: [['id', 'DESC']],
    limit: params.limit,
    offset: params.offset,
  });

  return (rows as unknown as BatchWithRefs[]).map(toBatchRow);
}

/** `GET /purchases/batches/:id` — boleh dipanggil dalam transaksi (create/update). */
export async function getBatch(id: number, transaction?: Transaction): Promise<BatchRow> {
  const row = await StockBatch.findByPk(id, { include: BATCH_INCLUDES, transaction });
  if (!row) throw new ApiError('BATCH_NOT_FOUND', `Batch id=${id} tidak ditemukan`);
  return toBatchRow(row as unknown as BatchWithRefs);
}

export interface PurchaseInput {
  product_id: number;
  qty: number;
  unit_cost: number;
  markup_type: 'AMOUNT' | 'PERCENT';
  markup_value: number;
  expired_date?: string | null;
  supplier?: string | null;
  notes?: string | null;
  /** Top-up stok ke batch existing (barang susulan) — lihat purchaseSchema. */
  merge_into_batch_id?: number | null;
}

/**
 * FASE 2 - Barang masuk: 1 batch + 1 movement IN dalam SATU transaksi.
 * `qty_remaining` tidak dihitung aplikasi; trigger trg_stock_movement_apply yang
 * menambahkannya dari qty_change movement.
 * Side effect DB: trg_batch_update_product_cost menyelaraskan product.harga_beli
 * dengan unit_cost batch terbaru, dan (sejak 0010) product.harga_jual dengan
 * suggested_price batch (markup AMOUNT/PERCENT — baruplan.md req #3-4).
 *
 * TOP-UP (`merge_into_batch_id` — barang susulan dari PO yang sama):
 *  - tidak membuat batch baru; movement IN baru dicatat ke batch tujuan sehingga
 *    qty_remaining bertambah via trigger dan ledger tetap per-event;
 *  - syarat: produk sama + unit_cost IDENTIK dengan batch tujuan (kalau harga
 *    berbeda, wajib batch baru supaya harga beli per batch tetap murni);
 *  - pricing (markup/harga jual) mengikuti batch tujuan — field markup input
 *    diabaikan; qty_received batch dijumlah.
 */
export async function createPurchase(input: PurchaseInput, createdBy: number | null): Promise<BatchRow> {
  try {
    return await withOrmTx(async (transaction) => {
      // Lock baris produk (FOR SHARE) supaya produk tidak hilang/berubah saat
      // batch ditulis — padanan `SELECT … FROM product WHERE id=$1 FOR SHARE`.
      const product = await Product.scope('withInactive').findByPk(input.product_id, {
        transaction,
        lock: transaction.LOCK.SHARE,
      });
      if (!product) {
        throw new ApiError('VALIDATION_ERROR', `Produk id=${input.product_id} tidak ditemukan`);
      }

      /* ---------------- Top-up ke batch existing ---------------- */
      if (input.merge_into_batch_id != null) {
        // Lock hanya baris batch (tanpa include: `FOR UPDATE` pada query ber-LOCK
        // JOIN ke user_account nullable akan ditolak PostgreSQL).
        const batch = await StockBatch.findByPk(input.merge_into_batch_id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!batch) {
          throw new ApiError('NOT_FOUND', `Batch id=${input.merge_into_batch_id} tidak ditemukan`);
        }
        if (batch.product_id !== input.product_id) {
          throw new ApiError(
            'VALIDATION_ERROR',
            `Batch ${batch.batch_code} milik produk lain — top-up hanya untuk produk yang sama`,
          );
        }
        if (Math.abs(batch.unit_cost - input.unit_cost) > 0.005) {
          throw new ApiError(
            'VALIDATION_ERROR',
            `Harga beli berbeda (${input.unit_cost} vs ${batch.unit_cost} di ${batch.batch_code}) — ` +
              `barang dengan harga berbeda wajib dibuat batch baru`,
          );
        }
        // Urutan penting demi constraint `chk_batch_remaining_le_received`:
        // qty_received dijumlah DULU (sisa lama tetap <= terima baru), baru
        // movement IN dieksekusi — trigger menaikkan qty_remaining hingga
        // menyamai qty_received. Movement dicatat per-event agar ledger utuh.
        await batch.update({ qty_received: batch.qty_received + input.qty }, { transaction });
        await StockMovement.create(
          {
            product_id: input.product_id,
            batch_id: batch.id,
            movement_type: 'IN',
            qty_change: input.qty,
            unit_cost: input.unit_cost,
            reference_type: 'PURCHASE',
            reference_id: batch.id,
            note: `Top-up barang susulan: +${input.qty} @ ${input.unit_cost} (batch tetap ${batch.batch_code})`,
            created_by: createdBy,
            condition: 'GOOD',
          },
          { transaction },
        );
        return getBatch(batch.id, transaction);
      }

      /* ---------------- Batch baru (jalur normal) ---------------- */
      const batchCode = await nextDocNo(transaction, 'batch', env.businessTz);

      const batch = await StockBatch.create(
        {
          batch_code: batchCode,
          product_id: input.product_id,
          qty_received: input.qty,
          // Selalu 0: sisa stok hanya boleh naik lewat trigger movement IN.
          qty_remaining: 0,
          unit_cost: input.unit_cost,
          markup_type: input.markup_type,
          markup_value: input.markup_value,
          expired_date: input.expired_date ?? null,
          supplier: input.supplier ?? null,
          note: input.notes ?? null,
          created_by: createdBy,
        },
        { transaction },
      );

      // Movement IN: trigger trg_stock_movement_apply yang menaikkan qty_remaining
      // (aplikasi tidak boleh menghitung stok sendiri).
      await StockMovement.create(
        {
          product_id: input.product_id,
          batch_id: batch.id,
          movement_type: 'IN',
          qty_change: input.qty,
          unit_cost: input.unit_cost,
          reference_type: 'PURCHASE',
          reference_id: batch.id,
          note: `Barang masuk: ${input.qty} @ ${input.unit_cost}${
            input.expired_date ? ` (exp ${input.expired_date})` : ''
          }`,
          created_by: createdBy,
          condition: 'GOOD',
        },
        { transaction },
      );

      return getBatch(batch.id, transaction);
    }, 'purchase');
  } catch (err) {
    // 23514/23502/check trigger -> VALIDATION_ERROR, 23505 -> DUPLICATE, dst.
    throw mapOrmError(err);
  }
}

/* ================= koreksi salah input barang masuk (PATCH batch) ================= */

export interface BatchUpdateInput {
  qty?: number | null;
  unit_cost?: number | null;
  markup_type?: 'AMOUNT' | 'PERCENT' | null;
  markup_value?: number | null;
  expired_date?: string | null;
  supplier?: string | null;
  notes?: string | null;
}

/** Kolom yang boleh ditulis `updateBatch`; `batch_code` & `product_id` terkunci. */
const BATCH_WRITE_FIELDS = [
  'qty_received',
  'unit_cost',
  'markup_type',
  'markup_value',
  'expired_date',
  'supplier',
  'note',
] as const;

/**
 * Apakah ada pemakaian nyata batch ini? Tabel pemakai (`sale_items`,
 * `stock_opname_items`, `supplier_return_items`) baru punya model di MP-4..MP-6,
 * jadi pemeriksaan ini sengaja lewat `sequelize.query` (hybrid §D4) — SQL-nya
 * sama persis dengan versi lama.
 *
 * ADJUSTMENT dengan reference_type BATCH_EDIT = jejak koreksi sebelumnya
 * (fitur ini sendiri) — BUKAN pemakaian, jadi edit berulang tetap boleh
 * selama belum ada penjualan/opname/retur sungguhan.
 */
async function batchUsage(
  batchId: number,
  transaction: Transaction,
): Promise<{ sale: string | null; opname: string | null; retur: string | null; moved: string | null }> {
  const rows = (await sequelize.query(
    `SELECT (SELECT 1::text FROM sale_items si WHERE si.batch_id = $batchId LIMIT 1)                    AS sale,
            (SELECT 1::text FROM stock_opname_items o WHERE o.batch_id = $batchId LIMIT 1)              AS opname,
            (SELECT 1::text FROM supplier_return_items r WHERE r.batch_id = $batchId LIMIT 1)           AS retur,
            (SELECT 1::text FROM stock_movements m
              WHERE m.batch_id = $batchId
                AND (m.movement_type <> 'IN' AND m.reference_type IS DISTINCT FROM 'BATCH_EDIT')
              LIMIT 1)                                                                            AS moved`,
    { bind: { batchId }, type: QueryTypes.SELECT, transaction },
  )) as Array<{ sale: string | null; opname: string | null; retur: string | null; moved: string | null }>;
  return rows[0]!;
}

/**
 * Koreksi salah input barang masuk — `PATCH /purchases/batches/{id}`.
 *
 * ATURAN (dibela di sini, bukan cuma di UI):
 *  1. Batch belum boleh punya mutasi nyata selain IN awalnya: tidak ada
 *     sale_items / stock_opname_items / supplier_return_items yang menunjuk
 *     batch, dan tidak ada movement OUT/ADJUSTMENT. Kalau sudah terpakai,
 *     koreksi harus lewat opname/retur (jejak nyata, bukan sunting sejarah).
 *  2. Perubahan qty dicatat sebagai movement ADJUSTMENT (+/-) sehingga ledger
 *     tetap utuh; qty_remaining berubah via trigger, aplikasi tidak menghitung.
 *  3. Qty baru wajib > 0 dan (karena batch belum pernah dipakai) otomatis
 *     >= qty_remaining — menurunkan qty berarti menurunkan keduanya sekaligus.
 *  4. batch_code & product_id terkunci — koreksi tidak boleh memindahkan stok
 *     antar produk.
 *  5. Perubahan unit_cost/markup pada batch TERBARU menyelaraskan
 *     harga_beli/harga_jual produk (trigger 0011); batch lama tidak menimpa
 *     harga produk (guard di trigger).
 */
export async function updateBatch(batchId: number, input: BatchUpdateInput, updatedBy: number | null): Promise<BatchRow> {
  try {
    return await withOrmTx(async (transaction) => {
      const batch = await StockBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!batch) {
        throw new ApiError('NOT_FOUND', `Batch id=${batchId} tidak ditemukan`);
      }

      // Guard 1: batch harus masih "perawan" — belum ada pemakaian nyata.
      const usage = await batchUsage(batchId, transaction);
      if (usage.sale || usage.opname || usage.retur || usage.moved) {
        const why = usage.sale
          ? 'sudah ada penjualan'
          : usage.opname
            ? 'sudah di-opname'
            : usage.retur
              ? 'sudah diretur ke distributor'
              : 'sudah ada mutasi stok lain';
        throw new ApiError(
          'CONCURRENT_CONFLICT',
          `Batch ${batch.batch_code} tidak bisa diedit karena ${why} — ` +
            `gunakan Opname (selisih fisik) atau Retur untuk koreksi setelah barang terpakai`,
        );
      }

      // Nilai efektif: field yang tidak dikirim = nilai lama.
      const newQty = input.qty != null ? input.qty : batch.qty_received;
      const newCost = input.unit_cost != null ? input.unit_cost : batch.unit_cost;
      const newMarkupType = input.markup_type != null ? input.markup_type : batch.markup_type;
      const newMarkupValue = input.markup_value != null ? input.markup_value : batch.markup_value;
      const newExpired = input.expired_date !== undefined ? input.expired_date : batch.expired_date;
      const newSupplier = input.supplier !== undefined ? input.supplier : batch.supplier;
      const newNote = input.notes !== undefined ? input.notes : batch.note;

      // Guard 2: qty valid. Guard 1 menjamin batch belum pernah dipakai
      // sehingga qty_remaining == qty_received — menurunkan qty berarti
      // menurunkan keduanya sekaligus (sisa ikut turun via ADJUSTMENT).
      if (newQty <= 0) {
        throw new ApiError('VALIDATION_ERROR', 'Qty barang masuk harus lebih besar dari 0');
      }

      // Urutan tulis tergantung arah perubahan qty demi constraint DB
      // `chk_batch_remaining_le_received` (qty_remaining <= qty_received) yang
      // divalidasi per-statement:
      //  * qty NAIK  → UPDATE batch dulu (sisa lama tetap <= terima baru),
      //                lalu movement ADJUSTMENT menaikkan sisa.
      //  * qty TURUN → movement ADJUSTMENT menurunkan sisa dulu (sisa baru <=
      //                terima lama), baru UPDATE batch.
      // Dua-duanya menjaga kondisi antara tetap sah — tidak ada edit "mentah"
      // tanpa jejak ledger.
      const deltaQty = Number((newQty - batch.qty_received).toFixed(3));
      const writeBatch = (): Promise<unknown> => {
        batch.set({
          qty_received: newQty,
          unit_cost: newCost,
          markup_type: newMarkupType,
          markup_value: newMarkupValue,
          expired_date: newExpired,
          supplier: newSupplier,
          note: newNote,
        });
        // `fields` eksplisit = kolom yang SELALU ikut ditulis (padanan SQL lama
        // yang menulis 7 kolom sekaligus) supaya trigger
        // `trg_batch_update_product_cost` tetap menyelaraskan harga produk
        // walaupun hanya kolom non-harga yang berubah.
        return batch.save({ fields: [...BATCH_WRITE_FIELDS], transaction });
      };
      const writeAdjustment = (): Promise<unknown> =>
        StockMovement.create(
          {
            product_id: batch.product_id,
            batch_id: batch.id,
            movement_type: 'ADJUSTMENT',
            qty_change: deltaQty,
            unit_cost: newCost,
            reference_type: 'BATCH_EDIT',
            reference_id: batch.id,
            note: `Koreksi salah input barang masuk: qty ${batch.qty_received} -> ${newQty}`,
            created_by: updatedBy,
            condition: 'GOOD',
          },
          { transaction },
        );

      if (deltaQty > 0.0005) {
        await writeBatch();
        await writeAdjustment();
      } else if (deltaQty < -0.0005) {
        await writeAdjustment();
        await writeBatch();
      } else {
        await writeBatch();
      }
      // Trigger 0011 (AFTER UPDATE OF unit_cost/markup...) menyelaraskan harga
      // produk bila batch ini batch terbaru — tidak perlu UPDATE manual di sini.

      return getBatch(batchId, transaction);
    }, 'purchase-edit');
  } catch (err) {
    throw mapOrmError(err);
  }
}

/* ================= picker batch layar kasir (baruplan.md req #1) ================= */

/**
 * Daftar batch SATU produk untuk modal "Detail Item" di POS: kasir melihat tiap
 * batch punya sisa stok (qty_remaining), harga beli (unit_cost — floor nego), dan
 * harga jual usulan (suggested_price dari markup batch). Urutan FIFO dengan
 * expired NULLS LAST (sama dengan auto-FIFO resolveBatchId di sale.service).
 *
 * `qty` (opsional) → tiap batch diberi `suggested_qty`: alokasi FIFO hitungan
 * server (batch terlama penuh dulu, sisanya ke batch berikutnya). Tujuannya
 * satu aturan alokasi untuk semua client (FE/WA bot/integrasi) — FE bebas
 * menghitung ulang lokal selama algoritmanya sama (greedy pada urutan ini).
 * Bila total stok < qty, seluruh batch terisi penuh dan kekurangan terlihat
 * dari `qty - Σ suggested_qty` (divalidasi ulang server saat POST /sales).
 */
export async function listProductBatches(
  productId: number,
  availableOnly: boolean,
  qty?: number | null,
): Promise<Array<BatchRow & { suggested_qty: number }>> {
  const product = await Product.scope('withInactive').findByPk(productId, { attributes: ['id'] });
  if (!product) {
    throw new ApiError('NOT_FOUND', `Produk id=${productId} tidak ditemukan`);
  }

  const conditions: Record<string, unknown>[] = [{ product_id: productId }];
  if (availableOnly) conditions.push({ qty_remaining: { [Op.gt]: 0 } });

  const rows = await StockBatch.findAll({
    where: { [Op.and]: conditions },
    include: BATCH_INCLUDES,
    subQuery: false,
    order: [
      ['expired_date', 'ASC'], // Postgres: NULLS LAST adalah default untuk ASC
      ['id', 'ASC'],
    ],
    limit: 200,
  });

  // Alokasi FIFO greedy hanya bila pemanggil minta saran (qty dikirim).
  let remaining = qty != null && qty > 0 ? qty : null;
  return (rows as unknown as BatchWithRefs[]).map((row) => {
    let suggested = 0;
    if (remaining != null && remaining > 0.0005) {
      suggested = Number(Math.min(row.qty_remaining, remaining).toFixed(3));
      remaining = Number((remaining - suggested).toFixed(3));
    }
    return { ...toBatchRow(row), suggested_qty: suggested };
  });
}
