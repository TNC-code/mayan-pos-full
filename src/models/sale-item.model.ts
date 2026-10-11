import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import { ApiError } from '../utils/errors.js';

/**
 * `sale_items` — baris item penjualan.
 *
 * Tidak bisa diedit/delete setelah masuk (trigger `trg_sale_item_guard`:
 * hanya kolom `note` boleh diubah, DELETEditolak `IMMUTABLE_RECORD`/405), jadi
 * model ini hanya dipakai `create()` + `find*`.
 *
 * Yang dijaga trigger (bukan aplikasi):
 *  - `trg_sale_item_validate` (BEFORE INSERT): `batch_id` wajib, batch di-lock
 *    `FOR UPDATE`, `unit_price >= unit_cost` batch (422 `PRICE_BELOW_COST`),
 *    `qty_remaining >= qty` (409 `INSUFFICIENT_STOCK`), lalu **menimpa
 *    `unit_cost` dengan harga beli batch** (snapshot HPP);
 *  - `trg_sale_item_apply_movement` (AFTER INSERT): menulis movement `OUT`
 *    (`reference_type = 'SALE'`) sehingga `qty_remaining` turun via
 *    `trg_stock_movement_apply` — service tidak pernah menghitung stok sendiri.
 *
 * `subtotal` = GENERATED column (`qty * unit_price`) -> HANYA BACA, setter-nya
 * melempar ApiError (mengisi manual akan ditolak PostgreSQL dengan 428C9).
 */
export interface SaleItemAttributes {
  id: number;
  sale_id: number;
  product_id: number;
  /** WAJIB — item selalu terikat batch (FIFO memilihkan, atau kasir eksplisit). */
  batch_id: number;
  qty: number;
  unit_price: number;
  /** Snapshot harga beli batch saat sold; ditulis trigger validate. */
  unit_cost: number;
  note: string | null;
  created_at: Date;
  /** Generated column DB (`qty * unit_price`). */
  subtotal: number;
}

/** `subtotal` dikecualikan: kolom generated, tidak boleh ditulis aplikasi. */
export type SaleItemCreationAttributes = Optional<Omit<SaleItemAttributes, 'subtotal'>, 'id' | 'note' | 'created_at'>;

export class SaleItem extends Model<SaleItemAttributes, SaleItemCreationAttributes> {
  declare id: number;
  declare sale_id: number;
  declare product_id: number;
  declare batch_id: number;
  declare qty: number;
  declare unit_price: number;
  declare unit_cost: number;
  declare note: string | null;
  declare created_at: Date;
  declare subtotal: number;

  /** Dipasang lewat `SaleItem.belongsTo(Sale, { as: 'sale' })`. */
  declare sale?: { id: number; sale_no: string } | null;
  /** Dipasang lewat `SaleItem.belongsTo(Product, { as: 'product' })`. */
  declare product?: { id: number; name: string | null; unit: string | null } | null;
  /** Dipasang lewat `SaleItem.belongsTo(StockBatch, { as: 'batch' })`. */
  declare batch?: { id: number; batch_code: string | null } | null;
}

export function initSaleItem(sequelize: Sequelize): void {
  SaleItem.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      sale_id: { type: DataTypes.BIGINT, allowNull: false },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      batch_id: { type: DataTypes.BIGINT, allowNull: false },
      qty: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
      unit_price: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      unit_cost: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      note: { type: DataTypes.TEXT },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      // GENERATED ALWAYS AS (qty * unit_price) STORED -> tidak bisa di-set.
      subtotal: {
        type: DataTypes.DECIMAL(16, 2),
        set(): void {
          throw new ApiError('VALIDATION_ERROR', 'subtotal dihitung otomatis oleh DB dari qty x unit_price');
        },
      },
    },
    {
      sequelize,
      tableName: 'sale_items',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );
}