import { Op, QueryTypes, Sequelize, type Includeable, type Transaction } from 'sequelize';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { round2, round3, withOrmTx } from '../utils/tx.js';
import { mapOrmError } from '../utils/orm-errors.js';
import {
  Customer,
  OrderBook,
  OrderBookItem,
  Product,
  Sale,
  UserAccount,
  sequelize,
  type OrderStatus,
} from '../models/index.js';
import { nextDocNo } from './docno.js';

/**
 * Order book WhatsApp di atas Sequelize (MP-7, WA-1/WA-2).
 *
 * Paritas penuh dengan versi raw SQL lama
 * (`git show e33b3b5:src/services/order-book.service.ts`) — bentuk response
 * (`OrderBookRow`/`OrderBookItemRow`/`OrderBookDetail`), urutan list (`id DESC`),
 * kode error, dan semua guard:
 *
 *   create : kunci customer (advisory lock per nomor WA) -> insert header
 *            (status PENDING, `ORD-` dari sequence) -> insert item
 *            (product_id ada -> `unit_price` di-snapshot & `matched = true`;
 *             tanpa product_id -> UNMATCHED, `unit_price = 0`).
 *            Stok & ledger TIDAK disentuh sama sekali (order book bukan penjualan).
 *   patch  : kunci order (FOR UPDATE) -> guard status PENDING/PROCESSING ->
 *            kunci item -> pilih produk (harga di-snapshot ULANG, `matched = true`)
 *            dan/atau ubah qty.
 *   delete : guard status + `ORDER_LAST_ITEM` (order minimal 1 item).
 *   status : PENDING -> PROCESSING, PENDING/PROCESSING -> CANCELLED (alasan
 *            ditempel ke `note` dengan pemisah ' | '), CANCELLED final.
 *   convert: DONE hanya lewat `/convert` yang mengaitkan `sale_id` penjualan
 *            `COMPLETED`; CANCELLED ditolak, konversi ulang ke sale yang sama
 *            = replay idempotent (200 + `X-Idempotent-Replay`).
 *
 * TIGA hal yang TIDAK digeser (catatan di bawah):
 *  1. Convert TIDAK membuat penjualan. Kasir menagih lewat `POST /sales` (MP-4)
 *     lebih dulu, lalu mengaitkan hasilnya lewat `sale_id` — kontrak openapi
 *     (`OrderBookConvertInput: required [sale_id]`) & zod sudah mengunci itu.
 *  2. Convert tidak menuntut status PROCESSING; order PENDING pun boleh ditutup
 *     (parity + openapi hanya menolak CANCELLED).
 *  3. Alasan pembatalan tetap di `note` (tidak ada kolom `cancelled_reason`).
 */

export type { OrderStatus };

/* ============================== types ============================== */

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

/* ============================ includes ============================ */

const WITH_CREATOR: Includeable = {
  model: UserAccount,
  as: 'creator',
  attributes: ['id', 'username'],
  required: false,
};

const WITH_PROCESSOR: Includeable = {
  model: UserAccount,
  as: 'processor',
  attributes: ['id', 'username'],
  required: false,
};

// `Sale` tidak punya default scope, jadi cukup include biasa: yang perlu hanya sale_no.
const WITH_SALE: Includeable = {
  model: Sale,
  as: 'sale',
  attributes: ['id', 'sale_no'],
  required: false,
};

const ORDER_INCLUDES: Includeable[] = [WITH_CREATOR, WITH_PROCESSOR, WITH_SALE];

type OrderBookWithRefs = OrderBook & {
  creator?: { id: number; username: string | null } | null;
  processor?: { id: number; username: string | null } | null;
  sale?: { id: number; sale_no: string | null } | null;
};

/** Alias tabel yang dipakai Sequelize di SQL hasil `findAll` (nama model class). */
const ORDER_ALIAS = 'OrderBook';

function toOrderRow(row: OrderBookWithRefs, agg: OrderAgg): OrderBookRow {
  return {
    id: row.id,
    order_no: row.order_no,
    status: row.status,
    source: row.source,
    customer_id: row.customer_id,
    // Snapshot dari chat (bukan JOIN ke customer) — sama seperti SELECT versi lama.
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    raw_message: row.raw_message,
    note: row.note,
    sale_id: row.sale_id,
    sale_no: row.sale?.sale_no ?? null,
    created_by: row.created_by,
    created_by_name: row.creator?.username ?? null,
    processed_by: row.processed_by,
    processed_by_name: row.processor?.username ?? null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    item_count: agg.count,
    unmatched_count: agg.unmatched,
    total_qty: round3(agg.qty),
    estimated_total: round2(agg.estimated),
  };
}

interface OrderAgg {
  count: number;
  unmatched: number;
  qty: number;
  estimated: number;
}

const EMPTY_AGG: OrderAgg = { count: 0, unmatched: 0, qty: 0, estimated: 0 };

/**
 * Agregat item per order (`item_count`, `unmatched_count`, `total_qty`,
 * `estimated_total`). Versi lama memakai 4 subquery korelasi per baris; di sini
 * satu query untuk semua id yang sudah terpaginasi lalu dijumlahkan di memori —
 * angka & pembulatan identik, hanya bentuk SQL-nya yang berbeda.
 */
async function aggregateItems(orderIds: number[]): Promise<Map<number, OrderAgg>> {
  const totals = new Map<number, OrderAgg>();
  if (orderIds.length === 0) return totals;

  const items = await OrderBookItem.findAll({
    where: { order_book_id: { [Op.in]: orderIds } },
    attributes: ['order_book_id', 'qty', 'unit_price', 'matched'],
    raw: true,
  });

  for (const item of items as unknown as Array<{
    order_book_id: number;
    qty: number;
    unit_price: number;
    matched: boolean;
  }>) {
    const acc = totals.get(item.order_book_id) ?? { ...EMPTY_AGG };
    acc.count += 1;
    if (!item.matched) acc.unmatched += 1;
    acc.qty += item.qty;
    acc.estimated += item.qty * item.unit_price;
    totals.set(item.order_book_id, acc);
  }
  return totals;
}

function toItemRow(row: OrderBookItem): OrderBookItemRow {
  return {
    id: row.id,
    order_book_id: row.order_book_id,
    product_id: row.product_id,
    product_name: row.product_name,
    raw_text: row.raw_text,
    qty: row.qty,
    unit_price: row.unit_price,
    matched: row.matched,
    match_score: row.match_score,
    // Tidak ada kolom `subtotal` di DB: dihitung di sini seperti SELECT lama
    // (`(i.qty * i.unit_price)::numeric(14,2)`).
    subtotal: round2(row.qty * row.unit_price),
  };
}

/* ============================== list ============================== */

export interface OrderBookListQuery {
  status?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
  limit: number;
  offset: number;
}

/**
 * `GET /order-books` — daftar order (default `id DESC`).
 * `q` mencocokkan `order_no`/nama/nomor WA dengan ILIKE, sama seperti versi lama.
 */
export async function listOrderBooks(params: OrderBookListQuery): Promise<OrderBookRow[]> {
  const conditions: Record<string, unknown>[] = [];

  if (params.status) conditions.push({ status: params.status });
  if (params.q) {
    const like = `%${params.q}%`;
    conditions.push({
      [Op.or]: [
        { order_no: { [Op.iLike]: like } },
        { customer_name: { [Op.iLike]: like } },
        { customer_phone: { [Op.iLike]: like } },
      ],
    });
  }

  // Tanggal order = tanggal dibuatnya order, dalam zona waktu bisnis —
  // literal + `sequelize.escape` (nilai user di-bind, tidak di-interpolasi).
  // Kolom harus dirujuk lewat ALIAS tabel yang dibuat Sequelize (`"OrderBook"`),
  // bukan nama tabel, karena `created_at` juga ada di tabel yang di-JOIN.
  const tzLiteral = sequelize.escape(env.businessTz);
  const localDate = (op: '>=' | '<=', value: string) =>
    Sequelize.literal(`("${ORDER_ALIAS}"."created_at" AT TIME ZONE ${tzLiteral})::date ${op} ${sequelize.escape(value)}`);
  if (params.date_from) conditions.push(localDate('>=', params.date_from) as never);
  if (params.date_to) conditions.push(localDate('<=', params.date_to) as never);

  const rows = await OrderBook.findAll({
    where: { [Op.and]: conditions },
    include: ORDER_INCLUDES,
    // Semua include 1:1 (belongsTo) -> jumlah baris tidak berubah, LIMIT aman.
    subQuery: false,
    order: [['id', 'DESC']],
    limit: params.limit,
    offset: params.offset,
  });

  const list = rows as unknown as OrderBookWithRefs[];
  const totals = await aggregateItems(list.map((r) => r.id));
  return list.map((row) => toOrderRow(row, totals.get(row.id) ?? EMPTY_AGG));
}

/* ============================== detail ============================== */

/**
 * Header + item satu order. Boleh dipanggil dalam transaksi (langsung setelah
 * create/patch/delete/status/convert) supaya respons sudah memuat efek baris baru.
 */
async function fetchDetail(transaction: Transaction | null, id: number): Promise<OrderBookDetail> {
  const head = await OrderBook.findByPk(id, { include: ORDER_INCLUDES, transaction });
  if (!head) throw new ApiError('ORDER_NOT_FOUND', `Order book id=${id} tidak ditemukan`);

  const items = await OrderBookItem.findAll({
    where: { order_book_id: id },
    order: [['id', 'ASC']],
    transaction,
  });

  const itemRows = items.map(toItemRow);
  return {
    ...toOrderRow(
      head as unknown as OrderBookWithRefs,
      {
        count: itemRows.length,
        unmatched: itemRows.filter((i) => !i.matched).length,
        qty: itemRows.reduce((sum, i) => sum + i.qty, 0),
        // `Σ qty × unit_price` dibulatkan SEKALI di akhir (setara
        // `sum(i.qty * i.unit_price)::numeric(14,2)` versi lama), bukan jumlah
        // dari `subtotal` yang sudah dibulatkan per item.
        estimated: items.reduce((sum, i) => sum + i.qty * i.unit_price, 0),
      },
    ),
    items: itemRows,
  };
}

export async function getOrderBook(id: number): Promise<OrderBookDetail> {
  return fetchDetail(null, id);
}

/* ====================== helper: produk & customer ====================== */

/**
 * Validasi produk + harga snapshot. Server TIDAK menghitung match (itu tugas bot);
 * server hanya memastikan produk yang dikirim bot benar-benar ada & aktif, lalu
 * menyimpan harga_jual saat itu (bukan harga saat order di-convert).
 *
 * `Product.scope('withInactive')`: SELECT lama `FROM product WHERE id = $1` tidak
 * memfilter `is_active`, jadi produk nonaktif harus menghasilkan 400 "tidak aktif"
 * (bukan "tidak ditemukan") — pesan yang sama seperti versi lama.
 */
async function resolveProduct(transaction: Transaction, productId: number): Promise<{ id: number; name: string; unit_price: number }> {
  const product = await Product.scope('withInactive').findByPk(productId, { transaction });
  if (!product) throw new ApiError('VALIDATION_ERROR', `Produk id=${productId} tidak ditemukan`);
  if (!product.is_active) {
    throw new ApiError('VALIDATION_ERROR', `Produk id=${productId} ("${product.name}") tidak aktif; tidak bisa dipakai di order book`);
  }
  return { id: product.id, name: product.name ?? '', unit_price: Number(product.harga_jual ?? 0) };
}

/** id user sistem `bot` (seeder `202610110004-bot-user`) - jadi `created_by` order dari internal key. */
export async function getBotUserId(transaction: Transaction | null = null): Promise<number> {
  const bot = await UserAccount.findOne({
    where: { username: { [Op.iLike]: 'bot' } },
    order: [['id', 'ASC']],
    transaction,
  });
  if (!bot) {
    throw new ApiError('INTERNAL_ERROR', 'User sistem "bot" belum ada; jalankan `npm run db:seed` lebih dulu');
  }
  return bot.id;
}

/**
 * Customer by nomor WA, auto-register bila belum ada.
 *
 * `pg_advisory_xact_lock(hashtext(phone))` per nomor supaya 2 request bersamaan
 * (2 chat masuk bersamaan) tidak membuat customer ganda. Ini satu-satunya SQL
 * mentah yang tersisa di service ini (hybrid): fungsi advisory lock tidak punya
 * padanan ORM, dan pemanggilnya dijaga `hashtext()` — nilainya tidak masuk string
 * SQL. Baris customer sendiri dibaca/tulis lewat model `Customer` seperti service
 * lain (MP-2 dst).
 */
async function ensureCustomer(
  transaction: Transaction,
  phone: string,
  nameFromRequest: string | null,
): Promise<{ id: number; name: string }> {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', {
    bind: [phone],
    type: QueryTypes.SELECT,
    transaction,
  });

  const found = await Customer.findOne({ where: { phone }, order: [['id', 'ASC']], transaction });
  if (found) return { id: found.id, name: found.name ?? '' };

  // Tanpa nama profil dari WA, tetap dibuat supaya pesanan punya identitas (nama kasual).
  const name = nameFromRequest?.trim() || `WA ${phone}`;
  const created = await Customer.create({ name, phone }, { transaction });
  return { id: created.id, name: created.name ?? '' };
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
  try {
    return await withOrmTx(async (transaction) => {
      const createdBy = createdByUserId ?? (await getBotUserId(transaction));
      const customer = await ensureCustomer(transaction, input.customer_phone, input.customer_name ?? null);

      const orderNo = await nextDocNo(transaction, 'order', env.businessTz);
      const order = await OrderBook.create(
        {
          order_no: orderNo,
          status: 'PENDING',
          customer_id: customer.id,
          customer_name: input.customer_name?.trim() || customer.name,
          customer_phone: input.customer_phone,
          raw_message: input.raw_message,
          note: input.note ?? null,
          created_by: createdBy,
        },
        { transaction },
      );

      for (const item of input.items) {
        let productId: number | null = null;
        let unitPrice = 0;
        if (item.product_id !== undefined && item.product_id !== null) {
          const p = await resolveProduct(transaction, item.product_id);
          productId = p.id;
          unitPrice = p.unit_price;
        }
        await OrderBookItem.create(
          {
            order_book_id: order.id,
            product_id: productId,
            product_name: item.product_name.trim(),
            raw_text: item.raw_text ?? null,
            qty: round3(item.qty),
            unit_price: unitPrice,
            matched: productId !== null,
            match_score: item.match_score ?? null,
          },
          { transaction },
        );
      }

      return fetchDetail(transaction, order.id);
    }, 'order-book-create');
  } catch (err) {
    throw mapOrmError(err);
  }
}

/* ================== kunci order + item (PATCH/DELETE/status/convert) ================== */

/** Kunci baris order (FOR UPDATE) supaya transisi status & edit item tidak balapan. */
async function lockOrder(transaction: Transaction, orderId: number): Promise<OrderBook> {
  const order = await OrderBook.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw new ApiError('ORDER_NOT_FOUND', `Order book id=${orderId} tidak ditemukan`);
  return order;
}

/** Item hanya boleh diubah selama order masih bisa dikerjakan kasir. */
function assertEditable(status: OrderStatus): void {
  if (status !== 'PENDING' && status !== 'PROCESSING') {
    throw new ApiError('ORDER_STATUS_TRANSITION', `Order book berstatus ${status} tidak bisa diubah lagi`);
  }
}

/** Kunci 1 item milik order tsb; item dari order lain dianggap tidak ada. */
async function lockItem(transaction: Transaction, orderId: number, itemId: number): Promise<OrderBookItem> {
  const item = await OrderBookItem.findOne({
    where: { id: itemId, order_book_id: orderId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!item) {
    throw new ApiError('ORDER_ITEM_NOT_FOUND', `Item id=${itemId} bukan item dari order book id=${orderId}`);
  }
  return item;
}

/** Sentuh `updated_at` order (kolomnya dipakai FE untuk tahu order berubah). */
async function touchOrder(transaction: Transaction, order: OrderBook): Promise<void> {
  await order.update({ updated_at: new Date() }, { transaction });
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
  try {
    return await withOrmTx(async (transaction) => {
      const order = await lockOrder(transaction, orderId);
      assertEditable(order.status);
      const item = await lockItem(transaction, orderId, itemId);

      const changes: Partial<{
        product_id: number | null;
        product_name: string;
        unit_price: number;
        qty: number;
        matched: boolean;
      }> = {};

      if (patch.product_id !== undefined && patch.product_id !== null) {
        const p = await resolveProduct(transaction, patch.product_id);
        changes.product_id = p.id;
        changes.product_name = p.name;
        changes.unit_price = p.unit_price;
        changes.matched = true;
      }
      if (patch.qty !== undefined) changes.qty = round3(patch.qty);

      if (Object.keys(changes).length === 0) {
        throw new ApiError('VALIDATION_ERROR', 'Tidak ada field yang bisa diperbarui (product_id / qty)');
      }

      await item.update(changes, { transaction });
      await touchOrder(transaction, order);
      return fetchDetail(transaction, orderId);
    }, 'order-book-patch-item');
  } catch (err) {
    throw mapOrmError(err);
  }
}

/* =================== DELETE /order-books/{id}/items/{itemId} =================== */

/** Order minimal 1 item (order tanpa item tidak ada artinya) -> 422 ORDER_LAST_ITEM. */
export async function deleteOrderBookItem(orderId: number, itemId: number): Promise<OrderBookDetail> {
  try {
    return await withOrmTx(async (transaction) => {
      const order = await lockOrder(transaction, orderId);
      assertEditable(order.status);
      const item = await lockItem(transaction, orderId, itemId);

      const total = await OrderBookItem.count({ where: { order_book_id: orderId }, transaction });
      if (total <= 1) {
        throw new ApiError('ORDER_LAST_ITEM', 'Order book harus punya minimal 1 item; item terakhir tidak bisa dihapus');
      }

      await item.destroy({ transaction });
      await touchOrder(transaction, order);
      return fetchDetail(transaction, orderId);
    }, 'order-book-delete-item');
  } catch (err) {
    throw mapOrmError(err);
  }
}

/* ==================== POST /order-books/{id}/status ==================== */

/**
 * Transisi status oleh kasir:
 *   PENDING -> PROCESSING (kasir mulai kerjakan)
 *   PENDING/PROCESSING -> CANCELLED (alasan wajib, ditempel ke `note`)
 * DONE hanya lewat `/convert`; CANCELLED bersifat final.
 */
export async function setOrderBookStatus(
  orderId: number,
  status: 'PROCESSING' | 'CANCELLED',
  reason: string | null,
  userId: number,
): Promise<OrderBookDetail> {
  try {
    return await withOrmTx(async (transaction) => {
      const order = await lockOrder(transaction, orderId);

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

      // Alasan pembatalan ditumpuk ke `note` (pola `note || ' | ' || reason` versi lama);
      // tanpa reason, `note` tidak berubah sama sekali.
      let note = order.note;
      if (reason) {
        note = !note ? reason : `${note} | ${reason}`;
      }

      await order.update(
        { status, processed_by: userId, updated_at: new Date(), ...(reason ? { note } : {}) },
        { transaction },
      );
      return fetchDetail(transaction, orderId);
    }, 'order-book-status');
  } catch (err) {
    throw mapOrmError(err);
  }
}

/* ==================== POST /order-books/{id}/convert ==================== */

/**
 * Tutup order jadi DONE setelah kasir menagih di POS biasa.
 *
 * Kasir sudah melakukan `POST /sales` lebih dulu (transaksi sendiri, MP-4) lalu
 * mengaitkan penjualan itu lewat `sale_id` — order book TIDAK membuat penjualan
 * sendiri (kontrak openapi `OrderBookConvertInput` mewajibkan `sale_id`, dan stok
 * hanya boleh berkurang satu kali lewat trigger penjualan).
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
  try {
    return await withOrmTx(async (transaction) => {
      const order = await lockOrder(transaction, orderId);

      if (order.status === 'DONE') {
        if (Number(order.sale_id) === saleId) {
          return { order: await fetchDetail(transaction, orderId), alreadyDone: true };
        }
        throw new ApiError(
          'ORDER_ALREADY_DONE',
          `Order book sudah DONE ke penjualan #${order.sale_id}; tidak bisa di-convert ke #${saleId}`,
        );
      }
      if (order.status === 'CANCELLED') {
        throw new ApiError('ORDER_STATUS_TRANSITION', 'Order book dibatalkan; tidak bisa di-convert');
      }

      const sale = await Sale.findByPk(saleId, { attributes: ['id', 'status'], transaction });
      if (!sale) throw new ApiError('ORDER_CONVERT_INVALID', `Penjualan id=${saleId} tidak ditemukan`);
      if (sale.status !== 'COMPLETED') {
        throw new ApiError(
          'ORDER_CONVERT_INVALID',
          `Penjualan id=${saleId} berstatus ${sale.status}; hanya penjualan COMPLETED yang bisa dipakai`,
        );
      }

      await order.update(
        { status: 'DONE', sale_id: saleId, processed_by: userId, updated_at: new Date() },
        { transaction },
      );
      return { order: await fetchDetail(transaction, orderId), alreadyDone: false };
    }, 'order-book-convert');
  } catch (err) {
    throw mapOrmError(err);
  }
}
