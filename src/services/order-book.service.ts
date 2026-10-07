import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { round3, withTx } from '../utils/tx.js';
import { nextDocNo } from './docno.js';

/* ============================== types ============================== */

export type OrderStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'CANCELLED';

export interface OrderBookRow {
  id: number;
  order_no: string;
  status: OrderStatus;
  source: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  raw_message: string | null;
  note: string | null;
  sale_id: number | null;
  /** sale_no penjualan hasil convert (null bila belum DONE). */
  sale_no: string | null;
  created_by: number | null;
  created_by_name: string | null;
  processed_by: number | null;
  processed_by_name: string | null;
  created_at: string;
  updated_at: string;
  item_count: number;
  /** Jumlah item yang belum punya product_id (perlu pemilihan produk oleh kasir). */
  unmatched_count: number;
  total_qty: number;
  /** Estimasi nilai order dari harga snapshot item yang sudah match. */
  estimated_total: number;
}

export interface OrderBookItemRow {
  id: number;
  order_book_id: number;
  /** NULL = UNMATCHED (kasir belum memilih produk). */
  product_id: number | null;
  product_name: string;
  raw_text: string | null;
  qty: number;
  unit_price: number;
  matched: boolean;
  match_score: number | null;
  subtotal: number;
}

export interface OrderBookDetail extends OrderBookRow {
  items: OrderBookItemRow[];
}

export interface OrderBookInputItem {
  product_id?: number | null;
  product_name: string;
  raw_text?: string | null;
  qty: number;
  /**
   * Confidence fuzzy dari bot (0..1). Bot yang menghitungnya; server cuma menyimpan
   * supaya kasir melihat seberapa yakin matcher (WA-1/WA-2: kandidat 0.4-0.75 = UNMATCHED
   * tapi ada saran). WA-1 belum kirim kolom ini -> boleh kosong.
   */
  match_score?: number | null;
}

export interface OrderBookInput {
  /** Sudah dinormalisasi ke format 62... oleh zod. */
  customer_phone: string;
  customer_name?: string | null;
  raw_message: string;
  note?: string | null;
  items: OrderBookInputItem[];
}

/* ============================ selectors ============================ */

const SELECT_ORDER_BOOK = `
  SELECT ob.id, ob.order_no, ob.status, ob.source, ob.customer_id, ob.customer_name, ob.customer_phone,
         ob.raw_message, ob.note, ob.sale_id, s.sale_no,
         ob.created_by, cu.username AS created_by_name,
         ob.processed_by, pu.username AS processed_by_name,
         ob.created_at, ob.updated_at,
         (SELECT count(*)::int FROM order_book_items i WHERE i.order_book_id = ob.id) AS item_count,
         (SELECT count(*)::int FROM order_book_items i WHERE i.order_book_id = ob.id AND i.matched = false) AS unmatched_count,
         (SELECT COALESCE(sum(i.qty), 0)::numeric(14,3) FROM order_book_items i WHERE i.order_book_id = ob.id) AS total_qty,
         (SELECT COALESCE(sum(i.qty * i.unit_price), 0)::numeric(14,2) FROM order_book_items i WHERE i.order_book_id = ob.id) AS estimated_total
    FROM order_books ob
    LEFT JOIN sales s ON s.id = ob.sale_id
    LEFT JOIN user_account cu ON cu.id = ob.created_by
    LEFT JOIN user_account pu ON pu.id = ob.processed_by
`;

const SELECT_ITEM = `
  SELECT i.id, i.order_book_id, i.product_id, i.product_name, i.raw_text, i.qty, i.unit_price,
         i.matched, i.match_score, (i.qty * i.unit_price)::numeric(14,2) AS subtotal
    FROM order_book_items i
`;

/* ============================== list ============================== */

export async function listOrderBooks(params: {
  status?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
  limit: number;
  offset: number;
}): Promise<OrderBookRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];
  const tz = env.businessTz;

  if (params.status) {
    args.push(params.status);
    where.push(`ob.status = $${args.length}`);
  }
  if (params.date_from) {
    args.push(tz);
    const tzIdx = args.length;
    args.push(params.date_from);
    where.push(`(ob.created_at AT TIME ZONE $${tzIdx})::date >= $${args.length}::date`);
  }
  if (params.date_to) {
    args.push(tz);
    const tzIdx = args.length;
    args.push(params.date_to);
    where.push(`(ob.created_at AT TIME ZONE $${tzIdx})::date <= $${args.length}::date`);
  }
  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`(ob.order_no ILIKE $${args.length} OR ob.customer_name ILIKE $${args.length} OR ob.customer_phone ILIKE $${args.length})`);
  }

  args.push(params.limit, params.offset);
  const res = await pool.query<OrderBookRow>(
    `${SELECT_ORDER_BOOK} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ob.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args as never[],
  );
  return res.rows;
}

/* ============================== detail ============================== */

export async function getOrderBook(id: number, client: PoolClient | null = null): Promise<OrderBookDetail> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);
  const head = await runner(`${SELECT_ORDER_BOOK} WHERE ob.id = $1`, [id]);
  if (!head.rows[0]) throw new ApiError('ORDER_NOT_FOUND', `Order book id=${id} tidak ditemukan`);
  const items = await runner(`${SELECT_ITEM} WHERE i.order_book_id = $1 ORDER BY i.id ASC`, [id]);
  return { ...(head.rows[0] as OrderBookRow), items: items.rows as OrderBookItemRow[] };
}

/* ====================== helper: produk & customer ====================== */

/**
 * Validasi produk + harga snapshot. Server TIDAK menghitung match (itu tugas bot);
 * server hanya memastikan produk yang dikirim bot benar-benar ada & aktif, lalu
 * menyimpan harga_jual saat itu (bukan harga saat order di-convert).
 */
async function resolveProduct(
  client: PoolClient,
  productId: number,
): Promise<{ id: number; name: string; unit_price: number }> {
  const res = await client.query<{ id: number; name: string; harga_jual: number | null; is_active: boolean }>(
    `SELECT id, name, harga_jual, is_active FROM product WHERE id = $1`,
    [productId],
  );
  const p = res.rows[0];
  if (!p) throw new ApiError('VALIDATION_ERROR', `Produk id=${productId} tidak ditemukan`);
  if (!p.is_active) {
    throw new ApiError('VALIDATION_ERROR', `Produk id=${productId} ("${p.name}") tidak aktif; tidak bisa dipakai di order book`);
  }
  return { id: p.id, name: p.name, unit_price: Number(p.harga_jual ?? 0) };
}

/** id user sistem `bot` (seed migration 0009) - jadi `created_by` order dari internal key. */
export async function getBotUserId(client: PoolClient | null = null): Promise<number> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);
  const res = await runner<{ id: number }>(
    `SELECT id FROM user_account WHERE lower(username) = 'bot' ORDER BY id LIMIT 1`,
  );
  if (!res.rows[0]) {
    throw new ApiError('INTERNAL_ERROR', 'User sistem "bot" belum ada; jalankan `npm run migrate` lebih dulu');
  }
  return res.rows[0].id;
}

/**
 * Customer by nomor WA, auto-register bila belum ada. `pg_advisory_xact_lock` per nomor
 * supaya 2 request bersamaan (2 chat masuk bersamaan) tidak membuat customer ganda.
 */
async function ensureCustomer(
  client: PoolClient,
  phone: string,
  nameFromRequest: string | null,
): Promise<{ id: number; name: string }> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [phone]);

  const found = await client.query<{ id: number; name: string }>(
    `SELECT id, name FROM customer WHERE phone = $1 ORDER BY id LIMIT 1`,
    [phone],
  );
  if (found.rows[0]) return found.rows[0];

  // Tanpa nama profil dari WA, tetap dibuat supaya pesanan punya identitas (nama kasual).
  const name = nameFromRequest?.trim() || `WA ${phone}`;
  const ins = await client.query<{ id: number; name: string }>(
    `INSERT INTO customer (name, phone) VALUES ($1, $2) RETURNING id, name`,
    [name, phone],
  );
  return ins.rows[0]!;
}

/* ====================== POST /order-books (buat) ====================== */

/**
 * Buat order book (draft) dari chat WA.
 *
 *  - `createdByUserId` = user kasir dari JWT; null = jalur internal key (bot) -> memakai
 *    user sistem 'bot' supaya audit tetap punya pelaku.
 *  - item dengan product_id -> harga di-snapshot dari harga_jual & `matched = true`.
 *  - item tanpa product_id  -> UNMATCHED, `unit_price = 0` (kasir pilih produknya).
 *  - stok & ledger TIDAK disentuh sama sekali (order book bukan penjualan).
 * Satu transaksi DB: header + items + (customer baru) atomic.
 */
export async function createOrderBook(input: OrderBookInput, createdByUserId: number | null): Promise<OrderBookDetail> {
  return withTx(async (client) => {
    const createdBy = createdByUserId ?? (await getBotUserId(client));
    const customer = await ensureCustomer(client, input.customer_phone, input.customer_name ?? null);

    const orderNo = await nextDocNo(client, 'order', env.businessTz);
    const head = await client.query<{ id: number }>(
      `INSERT INTO order_books
         (order_no, customer_id, customer_name, customer_phone, raw_message, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        orderNo,
        customer.id,
        input.customer_name?.trim() || customer.name,
        input.customer_phone,
        input.raw_message,
        input.note ?? null,
        createdBy,
      ],
    );
    const orderId = head.rows[0]!.id;

    for (const item of input.items) {
      let productId: number | null = null;
      let unitPrice = 0;
      if (item.product_id !== undefined && item.product_id !== null) {
        const p = await resolveProduct(client, item.product_id);
        productId = p.id;
        unitPrice = p.unit_price;
      }
      await client.query(
        `INSERT INTO order_book_items
           (order_book_id, product_id, product_name, raw_text, qty, unit_price, matched, match_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          orderId,
          productId,
          item.product_name.trim(),
          item.raw_text ?? null,
          round3(item.qty),
          unitPrice,
          productId !== null,
          item.match_score ?? null,
        ],
      );
    }

    return getOrderBook(orderId, client);
  }, 'order-book-create');
}

/* ================== kunci order + item (PATCH/DELETE/status/convert) ================== */

/** Kunci baris order (FOR UPDATE) supaya transisi status & edit item tidak balapan. */
async function lockOrder(client: PoolClient, orderId: number): Promise<{ id: number; status: OrderStatus }> {
  const res = await client.query<{ id: number; status: OrderStatus }>(
    `SELECT id, status FROM order_books WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  if (!res.rows[0]) throw new ApiError('ORDER_NOT_FOUND', `Order book id=${orderId} tidak ditemukan`);
  return res.rows[0];
}

/** Item hanya boleh diubah selama order masih bisa dikerjakan kasir. */
function assertEditable(status: OrderStatus): void {
  if (status !== 'PENDING' && status !== 'PROCESSING') {
    throw new ApiError('ORDER_STATUS_TRANSITION', `Order book berstatus ${status} tidak bisa diubah lagi`);
  }
}

/** Kunci 1 item milik order tsb; item dari order lain dianggap tidak ada. */
async function lockItem(
  client: PoolClient,
  orderId: number,
  itemId: number,
): Promise<{ id: number; product_id: number | null; product_name: string; qty: number }> {
  const res = await client.query<{ id: number; product_id: number | null; product_name: string; qty: number }>(
    `SELECT id, product_id, product_name, qty FROM order_book_items WHERE id = $1 AND order_book_id = $2 FOR UPDATE`,
    [itemId, orderId],
  );
  if (!res.rows[0]) {
    throw new ApiError('ORDER_ITEM_NOT_FOUND', `Item id=${itemId} bukan item dari order book id=${orderId}`);
  }
  return res.rows[0];
}

/* ==================== PATCH /order-books/{id}/items/{itemId} ==================== */

/**
 * Kasir memperbaiki item: pilih produk (harga di-snapshot ulang & `matched = true`)
 * dan/atau ubah qty. `product_name` diganti dengan nama katalog karena di sini
 * manusianya yang memilih produk (bukan tebakan matcher bot); `raw_text` chat asli
 * tetap disimpan sebagai jejak.
 */
export async function patchOrderBookItem(
  orderId: number,
  itemId: number,
  patch: { product_id?: number | null; qty?: number },
): Promise<OrderBookDetail> {
  return withTx(async (client) => {
    const order = await lockOrder(client, orderId);
    assertEditable(order.status);
    await lockItem(client, orderId, itemId);

    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.product_id !== undefined && patch.product_id !== null) {
      const p = await resolveProduct(client, patch.product_id);
      args.push(p.id);
      sets.push(`product_id = $${args.length}`);
      args.push(p.name);
      sets.push(`product_name = $${args.length}`);
      args.push(p.unit_price);
      sets.push(`unit_price = $${args.length}`);
      sets.push('matched = true');
    }
    if (patch.qty !== undefined) {
      args.push(round3(patch.qty));
      sets.push(`qty = $${args.length}`);
    }

    args.push(itemId, orderId);
    await client.query(
      `UPDATE order_book_items SET ${sets.join(', ')}
        WHERE id = $${args.length - 1} AND order_book_id = $${args.length}`,
      args as never[],
    );
    await client.query(`UPDATE order_books SET updated_at = now() WHERE id = $1`, [orderId]);
    return getOrderBook(orderId, client);
  }, 'order-book-patch-item');
}

/* =================== DELETE /order-books/{id}/items/{itemId} =================== */

/** Order minimal 1 item (order tanpa item tidak ada artinya) -> 422 ORDER_LAST_ITEM. */
export async function deleteOrderBookItem(orderId: number, itemId: number): Promise<OrderBookDetail> {
  return withTx(async (client) => {
    const order = await lockOrder(client, orderId);
    assertEditable(order.status);
    await lockItem(client, orderId, itemId);

    const cnt = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM order_book_items WHERE order_book_id = $1`,
      [orderId],
    );
    if ((cnt.rows[0]?.n ?? 0) <= 1) {
      throw new ApiError('ORDER_LAST_ITEM', 'Order book harus punya minimal 1 item; item terakhir tidak bisa dihapus');
    }

    await client.query(`DELETE FROM order_book_items WHERE id = $1 AND order_book_id = $2`, [itemId, orderId]);
    await client.query(`UPDATE order_books SET updated_at = now() WHERE id = $1`, [orderId]);
    return getOrderBook(orderId, client);
  }, 'order-book-delete-item');
}

/* ==================== POST /order-books/{id}/status ==================== */

/**
 * Transisi status oleh kasir:
 *   PENDING -> PROCESSING (kasir mulai kerjakan)
 *   PENDING/PROCESSING -> CANCELLED (alasan wajib, disimpan di `note`)
 * DONE hanya lewat `/convert`; CANCELLED bersifat final.
 */
export async function setOrderBookStatus(
  orderId: number,
  status: 'PROCESSING' | 'CANCELLED',
  reason: string | null,
  userId: number,
): Promise<OrderBookDetail> {
  return withTx(async (client) => {
    const order = await lockOrder(client, orderId);

    if (status === 'PROCESSING') {
      if (order.status !== 'PENDING') {
        throw new ApiError(
          'ORDER_STATUS_TRANSITION',
          `Hanya order PENDING yang bisa jadi PROCESSING (sekarang ${order.status})`,
        );
      }
    } else if (order.status !== 'PENDING' && order.status !== 'PROCESSING') {
      throw new ApiError(
        'ORDER_STATUS_TRANSITION',
        `Order book berstatus ${order.status} tidak bisa dibatalkan lagi`,
      );
    }

    await client.query(
      `UPDATE order_books
          SET status = $2, processed_by = $3, updated_at = now(),
              note = CASE
                WHEN $4::text IS NULL THEN note
                WHEN note IS NULL OR note = '' THEN $4
                ELSE note || ' | ' || $4
              END
        WHERE id = $1`,
      [orderId, status, userId, reason],
    );
    return getOrderBook(orderId, client);
  }, 'order-book-status');
}

/* ==================== POST /order-books/{id}/convert ==================== */

/**
 * Tutup order jadi DONE setelah kasir menagih di POS biasa.
 *
 * Guard:
 *  - order tidak boleh CANCELLED (`409 ORDER_STATUS_TRANSITION`)
 *  - penjualan harus ada & `status = 'COMPLETED'` (VOIDED/RETURNED/sale lain
 *    tidak bisa jadi bukti order) -> `422 ORDER_CONVERT_INVALID`
 *  - sudah DONE dengan sale yang sama -> 200 tanpa perubahan (aman bila FE retry)
 *  - sudah DONE dengan sale lain -> `409 ORDER_ALREADY_DONE`
 */
export async function convertOrderBook(
  orderId: number,
  saleId: number,
  userId: number,
): Promise<{ order: OrderBookDetail; alreadyDone: boolean }> {
  return withTx(async (client) => {
    const current = await client.query<{ id: number; status: OrderStatus; sale_id: number | null }>(
      `SELECT id, status, sale_id FROM order_books WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = current.rows[0];
    if (!order) throw new ApiError('ORDER_NOT_FOUND', `Order book id=${orderId} tidak ditemukan`);

    if (order.status === 'DONE') {
      if (Number(order.sale_id) === saleId) {
        return { order: await getOrderBook(orderId, client), alreadyDone: true };
      }
      throw new ApiError(
        'ORDER_ALREADY_DONE',
        `Order book sudah DONE ke penjualan #${order.sale_id}; tidak bisa di-convert ke #${saleId}`,
      );
    }
    if (order.status === 'CANCELLED') {
      throw new ApiError('ORDER_STATUS_TRANSITION', 'Order book dibatalkan; tidak bisa di-convert');
    }

    const sale = await client.query<{ id: number; status: string }>(`SELECT id, status FROM sales WHERE id = $1`, [
      saleId,
    ]);
    const s = sale.rows[0];
    if (!s) throw new ApiError('ORDER_CONVERT_INVALID', `Penjualan id=${saleId} tidak ditemukan`);
    if (s.status !== 'COMPLETED') {
      throw new ApiError(
        'ORDER_CONVERT_INVALID',
        `Penjualan id=${saleId} berstatus ${s.status}; hanya penjualan COMPLETED yang bisa dipakai`,
      );
    }

    await client.query(
      `UPDATE order_books
          SET status = 'DONE', sale_id = $2, processed_by = $3, updated_at = now()
        WHERE id = $1`,
      [orderId, saleId, userId],
    );
    return { order: await getOrderBook(orderId, client), alreadyDone: false };
  }, 'order-book-convert');
}
