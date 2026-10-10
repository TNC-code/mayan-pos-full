import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { withTx } from '../utils/tx.js';
import { nextDocNo } from './docno.js';

export interface BatchRow {
  id: number;
  batch_code: string;
  product_id: number;
  product_name: string | null;
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

const SELECT_BATCH = `
  SELECT b.id, b.batch_code, b.product_id, p.name AS product_name, p.unit,
         b.qty_received, b.qty_remaining, b.unit_cost,
         b.markup_type, b.markup_value, b.suggested_price,
         b.expired_date, b.supplier, b.note,
         b.received_at, b.created_by, u.username AS created_by_name
    FROM stock_batches b
    JOIN product p ON p.id = b.product_id
    LEFT JOIN user_account u ON u.id = b.created_by
`;

export async function listBatches(params: {
  product_id?: number;
  q?: string;
  active_only?: boolean;
  limit: number;
  offset: number;
}): Promise<BatchRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];

  if (params.product_id !== undefined) {
    args.push(params.product_id);
    where.push(`b.product_id = $${args.length}`);
  }
  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`(p.name ILIKE $${args.length} OR b.batch_code ILIKE $${args.length} OR p.barcode ILIKE $${args.length})`);
  }
  if (params.active_only) {
    where.push('b.qty_remaining > 0');
  }

  args.push(params.limit, params.offset);
  const res = await pool.query<BatchRow>(
    `${SELECT_BATCH} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY b.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args as never[],
  );
  return res.rows;
}

export async function getBatch(id: number, client: PoolClient | null = null): Promise<BatchRow> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);
  const res = await runner(`SELECT * FROM (${SELECT_BATCH}) x WHERE x.id = $1`, [id]);
  if (!res.rows[0]) throw new ApiError('BATCH_NOT_FOUND', `Batch id=${id} tidak ditemukan`);
  return res.rows[0] as BatchRow;
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
  return withTx(async (client) => {
    const product = await client.query<{ id: number; name: string; is_active: boolean }>(
      `SELECT id, name, is_active FROM product WHERE id = $1 FOR SHARE`,
      [input.product_id],
    );
    if (!product.rows[0]) {
      throw new ApiError('VALIDATION_ERROR', `Produk id=${input.product_id} tidak ditemukan`);
    }

    /* ---------------- Top-up ke batch existing ---------------- */
    if (input.merge_into_batch_id != null) {
      const target = await client.query<BatchRow>(
        `${SELECT_BATCH} WHERE b.id = $1 FOR UPDATE OF b`,
        [input.merge_into_batch_id],
      );
      const batch = target.rows[0];
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
      await client.query(
        `UPDATE stock_batches SET qty_received = qty_received + $1 WHERE id = $2`,
        [input.qty, batch.id],
      );
      await client.query(
        `INSERT INTO stock_movements
           (product_id, batch_id, movement_type, qty_change, unit_cost, reference_type, reference_id, note, created_by)
         VALUES ($1, $2, 'IN', $3, $4, 'PURCHASE', $2, $5, $6)`,
        [
          input.product_id,
          batch.id,
          input.qty,
          input.unit_cost,
          `Top-up barang susulan: +${input.qty} @ ${input.unit_cost} (batch tetap ${batch.batch_code})`,
          createdBy,
        ],
      );
      return getBatch(batch.id, client);
    }

    /* ---------------- Batch baru (jalur normal) ---------------- */
    const batchCode = await nextDocNo(client, 'batch', env.businessTz);

    const inserted = await client.query<{ id: number }>(
      `INSERT INTO stock_batches
         (batch_code, product_id, qty_received, qty_remaining, unit_cost,
          markup_type, markup_value, expired_date, supplier, note, created_by)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        batchCode,
        input.product_id,
        input.qty,
        input.unit_cost,
        input.markup_type,
        input.markup_value,
        input.expired_date ?? null,
        input.supplier ?? null,
        input.notes ?? null,
        createdBy,
      ],
    );
    const batchId = inserted.rows[0]!.id;

    // Movement IN: trigger trg_stock_movement_apply yang menaikkan qty_remaining
    // (aplikasi tidak boleh menghitung stok sendiri).
    await client.query(
      `INSERT INTO stock_movements
         (product_id, batch_id, movement_type, qty_change, unit_cost, reference_type, reference_id, note, created_by)
       VALUES ($1, $2, 'IN', $3, $4, 'PURCHASE', $2, $5, $6)`,
      [
        input.product_id,
        batchId,
        input.qty,
        input.unit_cost,
        `Barang masuk: ${input.qty} @ ${input.unit_cost}${input.expired_date ? ` (exp ${input.expired_date})` : ''}`,
        createdBy,
      ],
    );

    return getBatch(batchId, client);
  }, 'purchase');
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
 *  3. Qty baru wajib >= 1 dan >= qty_remaining (constraint DB
 *     `chk_batch_remaining_le_received` dijaga sebelum diketik).
 *  4. batch_code & product_id terkunci — koreksi tidak boleh memindahkan stok
 *     antar produk.
 *  5. Perubahan unit_cost/markup pada batch TERBARU menyelaraskan
 *     harga_beli/harga_jual produk (trigger 0011); batch lama tidak menimpa
 *     harga produk (guard di trigger).
 */
export async function updateBatch(batchId: number, input: BatchUpdateInput, updatedBy: number | null): Promise<BatchRow> {
  return withTx(async (client) => {
    const current = await client.query<BatchRow & { qty_damaged: number }>(
      `SELECT b.id, b.batch_code, b.product_id, p.name AS product_name, p.unit,
              b.qty_received, b.qty_remaining, b.unit_cost,
              b.markup_type, b.markup_value, b.suggested_price,
              b.expired_date, b.supplier, b.note,
              b.received_at, b.created_by, u.username AS created_by_name,
              b.qty_damaged
         FROM stock_batches b
         JOIN product p ON p.id = b.product_id
         LEFT JOIN user_account u ON u.id = b.created_by
        WHERE b.id = $1
        FOR UPDATE OF b`,
      [batchId],
    );
    const batch = current.rows[0];
    if (!batch) {
      throw new ApiError('NOT_FOUND', `Batch id=${batchId} tidak ditemukan`);
    }

    // Guard 1: batch harus masih "perawan" — belum ada pemakaian nyata.
    // ADJUSTMENT dengan reference_type BATCH_EDIT = jejak koreksi sebelumnya
    // (fitur ini sendiri) — BUKAN pemakaian, jadi edit berulang tetap boleh
    // selama belum ada penjualan/opname/retur sungguhan.
    const used = await client.query<{ sale: string | null; opname: string | null; retur: string | null; moved: string | null }>(
      `SELECT (SELECT 1::text FROM sale_items si WHERE si.batch_id = $1 LIMIT 1)                    AS sale,
              (SELECT 1::text FROM stock_opname_items o WHERE o.batch_id = $1 LIMIT 1)              AS opname,
              (SELECT 1::text FROM supplier_return_items r WHERE r.batch_id = $1 LIMIT 1)           AS retur,
              (SELECT 1::text FROM stock_movements m
                WHERE m.batch_id = $1
                  AND (m.movement_type <> 'IN' AND m.reference_type IS DISTINCT FROM 'BATCH_EDIT')
                LIMIT 1)                                                                            AS moved`,
      [batchId],
    );
    const usage = used.rows[0]!;
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
    const newExpired = input.expired_date !== undefined ? (input.expired_date ?? null) : batch.expired_date;
    const newSupplier = input.supplier !== undefined ? (input.supplier ?? null) : batch.supplier;
    const newNote = input.notes !== undefined ? (input.notes ?? null) : batch.note;

    // Guard 2: qty valid. Catatan: guard 1 menjamin batch belum pernah dipakai
    // sehingga qty_remaining == qty_received — menurunkan qty berarti
    // menurunkan keduanya sekaligus (sisa ikut turun via ADJUSTMENT), jadi
    // tidak ada guard "qty baru >= qty_remaining" di sini (justru memblokir
    // koreksi salah ketik yang kebanyakan).
    if (newQty <= 0) {
      throw new ApiError('VALIDATION_ERROR', 'Qty barang masuk harus lebih besar dari 0');
    }
    // Urutan tulis tergantung arah perubahan qty demi constraint DB
    // `chk_batch_remaining_le_received` (qty_remaining <= qty_received) yang
    // divalidasi per-statement:
    //  * qty NAIK  → UPDATE qty_received dulu (sisa lama tetap <= terima baru),
    //                lalu movement ADJUSTMENT menaikkan sisa.
    //  * qty TURUN → movement ADJUSTMENT menurunkan sisa dulu (sisa baru <=
    //                terima lama), lalu UPDATE qty_received.
    // Dua-duanya menjaga kondisi antara tetap sah — tidak ada edit "mentah"
    // tanpa jejak ledger.
    const deltaQty = Number((newQty - batch.qty_received).toFixed(3));
    const writeBatch = (): Promise<unknown> =>
      client.query(
        `UPDATE stock_batches
            SET qty_received = $1, unit_cost = $2, markup_type = $3, markup_value = $4,
                expired_date = $5, supplier = $6, note = $7
          WHERE id = $8`,
        [newQty, newCost, newMarkupType, newMarkupValue, newExpired, newSupplier, newNote, batchId],
      );
    const writeAdjustment = (): Promise<unknown> =>
      client.query(
        `INSERT INTO stock_movements
           (product_id, batch_id, movement_type, qty_change, unit_cost, reference_type, reference_id, note, created_by)
         VALUES ($1, $2, 'ADJUSTMENT', $3, $4, 'BATCH_EDIT', $2, $5, $6)`,
        [
          batch.product_id,
          batch.id,
          deltaQty,
          newCost,
          `Koreksi salah input barang masuk: qty ${batch.qty_received} -> ${newQty}`,
          updatedBy,
        ],
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

    return getBatch(batchId, client);
  }, 'purchase-edit');
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
  const product = await pool.query<{ id: number }>(`SELECT id FROM product WHERE id = $1`, [productId]);
  if (!product.rows[0]) {
    throw new ApiError('NOT_FOUND', `Produk id=${productId} tidak ditemukan`);
  }

  const args: unknown[] = [productId];
  const where = ['b.product_id = $1'];
  if (availableOnly) where.push('b.qty_remaining > 0');
  args.push(200);

  const res = await pool.query<BatchRow>(
    `${SELECT_BATCH} WHERE ${where.join(' AND ')}
     ORDER BY b.expired_date ASC NULLS LAST, b.id ASC
     LIMIT $2`,
    args as never[],
  );

  // Alokasi FIFO greedy hanya bila pemanggil minta saran (qty dikirim).
  let remaining = qty != null && qty > 0 ? qty : null;
  return res.rows.map((row) => {
    let suggested = 0;
    if (remaining != null && remaining > 0.0005) {
      suggested = Number(Math.min(row.qty_remaining, remaining).toFixed(3));
      remaining = Number((remaining - suggested).toFixed(3));
    }
    return { ...row, suggested_qty: suggested };
  });
}
