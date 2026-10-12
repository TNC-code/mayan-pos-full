import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

/**
 * `order_book_items` — satu baris "barang yang dipesan" per order (MP-7).
 *
 * Yang TIDAK boleh dibalik dari versi raw SQL lama:
 *  - `product_id` NULLABLE = item UNMATCHED: bot boleh mengirim deskripsi hasil
 *    tebakan matcher tanpa produk katalog, dan kasir yang memilihnya nanti lewat
 *    `PATCH /order-books/{id}/items/{itemId}`. defaulted `matched = false` selama
 *    `product_id` masih NULL.
 *  - `product_name` = deskripsi dari AI saat item UNMATCHED, dan diganti NAMA
 *    KATALOG begitu kasir memilih produk (bukan disimpan terpisah) — `raw_text`
 *    potongan chat asli tetap disimpan sebagai jejak tebakan bot.
 *  - `unit_price` NOT NULL default 0: snapshot `product.harga_jual` saat item
 *    di-match (bukan harga saat order di-convert), dan `0` selama belum match.
 *    Kolom `subtotal` TIDAK ada di DB — response API menghitungnya di service
 *    (`qty × unit_price`) persis seperti SELECT versi lama, jadi tidak ada
 *    risiko pembulatan ganda.
 *  - `match_score` numeric(4,3) + CHECK 0..1: confidence fuzzy dari bot (0..1),
 *    disimpan supaya kasir melihat seberapa yakin matcher.
 *
 * Tabel tidak punya kolom waktu -> `timestamps: false`.
 */
export interface OrderBookItemAttributes {
  id: number;
  order_book_id: number;
  /** NULL = UNMATCHED (kasir belum memilih produk). */
  product_id: number | null;
  product_name: string;
  raw_text: string | null;
  qty: number;
  /** Snapshot harga_jual saat di-match; 0 selama item belum match. */
  unit_price: number;
  matched: boolean;
  /** Confidence fuzzy dari bot (0..1); null kalau bot tidak mengirim. */
  match_score: number | null;
}

export type OrderBookItemCreationAttributes = Optional<
  OrderBookItemAttributes,
  'id' | 'product_id' | 'raw_text' | 'unit_price' | 'matched' | 'match_score'
>;

export class OrderBookItem extends Model<OrderBookItemAttributes, OrderBookItemCreationAttributes> {
  declare id: number;
  declare order_book_id: number;
  declare product_id: number | null;
  declare product_name: string;
  declare raw_text: string | null;
  declare qty: number;
  declare unit_price: number;
  declare matched: boolean;
  declare match_score: number | null;

  /** Dipasang lewat `OrderBookItem.belongsTo(OrderBook, { as: 'order' })`. */
  declare order?: { id: number; order_no: string } | null;
  /**
   * Dipasang lewat `OrderBookItem.belongsTo(Product, { as: 'product' })`.
   * Wajib include lewat `Product.scope('withInactive')` kalau produk nonaktif
   * ikut ditampilkan (pola yang sama dengan batch/sale/opname).
   */
  declare product?: { id: number; name: string | null } | null;
}

export function initOrderBookItem(sequelize: Sequelize): void {
  OrderBookItem.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      order_book_id: { type: DataTypes.BIGINT, allowNull: false },
      product_id: { type: DataTypes.INTEGER },
      product_name: { type: DataTypes.TEXT, allowNull: false },
      raw_text: { type: DataTypes.TEXT },
      qty: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
      unit_price: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      matched: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      match_score: { type: DataTypes.DECIMAL(4, 3) },
    },
    {
      sequelize,
      tableName: 'order_book_items',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}