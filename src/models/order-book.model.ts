import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

/**
 * Status order book (CHECK `chk_order_book_status` di DB).
 *  - PENDING    : order dari bot WA, belum disentuh kasir
 *  - PROCESSING : kasir sedang mencocokkan produk / menyiapkan pesanan
 *  - DONE       : SUDAH terjual (WAJIB punya `sale_id` dari `/convert`)
 *  - CANCELLED  : batal (alasan disimpan di `note`, lihat catatan di bawah)
 */
export type OrderStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'CANCELLED';

/**
 * `order_books` — header pesanan yang masuk lewat WhatsApp (MP-7, WA-1/WA-2).
 *
 * Paritas penuh dengan versi raw SQL lama
 * (`git show e33b3b5:src/services/order-book.service.ts`) — tiga hal yang TIDAK
 * boleh dibalik:
 *  - `order_no` = `ORD-YYYYMMDD-NNN` dari sequence `order_no_seq`
 *    (`services/docno.ts`), bukan `max()+1` -> tetap unik saat 2 order masuk
 *    bersamaan dari chat yang berbeda.
 *  - `customer_name`/`customer_phone` adalah SNAPSHOT dari chat pada saat order
 *    dibuat (bukan JOIN ke `customer`): profil WA bisa berubah/typo, dan order
 *    lama harus tetap menampilkan apa yang 실제로 diketik customer. Kolom
 *    `customer_id` nullable = customer auto-register bisa gagal tanpa
 *    membatalkan order.
 *  - Alasan pembatalan TIDAK punya kolom sendiri: versi lama menempelkannya ke
 *    `note` dengan pemisah `' | '` (`CASE WHEN … ELSE note || ' | ' || $4`),
 *    dan openapi tetap mendokumentasikannya sebagai "catatan kasir / alasan
 *    pembatalan" -> tetap di `note` supaya bentuk response tidak berubah.
 *
 * Status `DONE` hanya boleh lewat `POST /order-books/{id}/convert` yang mengaitkan
 * `sale_id` penjualan `COMPLETED`; `source` default `WHATSAPP` (order yang dibuat
 * kasir manual lewat endpoint yang sama tetap dicatat sebagai order WA — sama
 * seperti versi lama).
 *
 * Kolom waktu `created_at` + `updated_at` keduanya ada -> `timestamps: true`.
 */
export interface OrderBookAttributes {
  id: number;
  /** `ORD-YYYYMMDD-NNN` dari sequence `order_no_seq`. */
  order_no: string;
  status: OrderStatus;
  source: string;
  customer_id: number | null;
  /** Snapshot nama profil WA (bukan nama tabel `customer`). */
  customer_name: string | null;
  /** Nomor WA format 62... (sudah dinormalisasi zod). */
  customer_phone: string | null;
  /** Chat asli (audit matcher bot); disimpan apa adanya. */
  raw_message: string | null;
  /** Catatan kasir; alasan pembatalan ditumpuk di sini dengan pemisah `' | '`. */
  note: string | null;
  /** Penjualan `COMPLETED` hasil convert (null sampai order DONE). */
  sale_id: number | null;
  created_by: number | null;
  processed_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export type OrderBookCreationAttributes = Optional<
  OrderBookAttributes,
  | 'id'
  | 'status'
  | 'source'
  | 'customer_id'
  | 'customer_name'
  | 'customer_phone'
  | 'raw_message'
  | 'note'
  | 'sale_id'
  | 'created_by'
  | 'processed_by'
  | 'created_at'
  | 'updated_at'
>;

/** Bentuk minimum `order_book_items` untuk include `OrderBook.items`. */
export interface OrderBookItemRef {
  id: number;
  order_book_id: number;
  product_id: number | null;
  product_name: string;
  qty: number;
  unit_price: number;
  matched: boolean;
}

export class OrderBook extends Model<OrderBookAttributes, OrderBookCreationAttributes> {
  declare id: number;
  declare order_no: string;
  declare status: OrderStatus;
  declare source: string;
  declare customer_id: number | null;
  declare customer_name: string | null;
  declare customer_phone: string | null;
  declare raw_message: string | null;
  declare note: string | null;
  declare sale_id: number | null;
  declare created_by: number | null;
  declare processed_by: number | null;
  declare created_at: Date;
  declare updated_at: Date;

  /** Dipasang lewat `OrderBook.belongsTo(UserAccount, { as: 'creator' })`. */
  declare creator?: { id: number; username: string | null } | null;
  /** Dipasang lewat `OrderBook.belongsTo(UserAccount, { as: 'processor' })`. */
  declare processor?: { id: number; username: string | null } | null;
  /** Dipasang lewat `OrderBook.belongsTo(Sale, { as: 'sale' })`. */
  declare sale?: { id: number; sale_no: string | null } | null;
  /** Dipasang lewat `OrderBook.belongsTo(Customer, { as: 'customer' })`. */
  declare customer?: { id: number; name: string | null; phone: string | null } | null;
  /** Dipasang lewat `OrderBook.hasMany(OrderBookItem, { as: 'items' })`. */
  declare items?: OrderBookItemRef[];
}

export function initOrderBook(sequelize: Sequelize): void {
  OrderBook.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      order_no: { type: DataTypes.TEXT, allowNull: false, unique: true },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'PENDING' },
      source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'WHATSAPP' },
      customer_id: { type: DataTypes.INTEGER },
      customer_name: { type: DataTypes.TEXT },
      customer_phone: { type: DataTypes.TEXT },
      raw_message: { type: DataTypes.TEXT },
      note: { type: DataTypes.TEXT },
      sale_id: { type: DataTypes.BIGINT },
      created_by: { type: DataTypes.INTEGER },
      processed_by: { type: DataTypes.INTEGER },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      tableName: 'order_books',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  );
}