import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

/**
 * Kondisi barang yang diretur ke distributor (CHECK `chk_supplier_return_item_condition`).
 * Nilainya sama dengan `refund_items.condition` — barang RUSAK (karantina) yang
 * kembali ke distributor; saat ini service selalu menulis `RUSAK` (barang GOOD
 * tidak pernah diretur ke supplier).
 */
export type SupplierReturnCondition = 'GOOD' | 'RUSAK';

/**
 * `supplier_return_items` — detail barang per batch yang diretur (MP-6).
 *
 *  - `qty` numeric(14,3) + CHECK `qty > 0`, `unit_cost` numeric(14,2) + CHECK
 *    `>= 0` (harga beli; default = `stock_batches.unit_cost` saat retur dibuat).
 *  - `subtotal` TIDAK ada di DB: response API menghitungnya di service
 *    (`qty × unit_cost`) persis seperti SELECT versi lama, jadi tidak ada
 *    risiko pembulatan ganda.
 *  - `batch_id` nullable di DDL, tapi alur UC-B selalu mengisinya (retur merujuk
 *    batch asal barang rusak). `include` batch karena itu `required: false`.
 *
 * Tabel tidak punya kolom waktu -> `timestamps: false`. Item tidak pernah
 * diedit/hapus lewat API (retur == dokumen stok, mirroring `sale_items` yang
 * dijaga trigger `trg_sale_item_guard`).
 */
export interface SupplierReturnItemAttributes {
  id: number;
  return_id: number;
  product_id: number;
  batch_id: number | null;
  qty: number;
  unit_cost: number;
  condition: SupplierReturnCondition;
}

export type SupplierReturnItemCreationAttributes = Optional<SupplierReturnItemAttributes, 'id' | 'batch_id' | 'condition'>;

export class SupplierReturnItem extends Model<SupplierReturnItemAttributes, SupplierReturnItemCreationAttributes> {
  declare id: number;
  declare return_id: number;
  declare product_id: number;
  declare batch_id: number | null;
  declare qty: number;
  declare unit_cost: number;
  declare condition: SupplierReturnCondition;

  /** Dipasang lewat `SupplierReturnItem.belongsTo(SupplierReturn, { as: 'return' })`. */
  declare return?: { id: number; return_no: string } | null;
  /** Dipasang lewat `SupplierReturnItem.belongsTo(Product, { as: 'product' })`. */
  declare product?: { id: number; name: string | null; unit: string | null } | null;
  /** Dipasang lewat `SupplierReturnItem.belongsTo(StockBatch, { as: 'batch' })`. */
  declare batch?: { id: number; batch_code: string | null } | null;
}

export function initSupplierReturnItem(sequelize: Sequelize): void {
  SupplierReturnItem.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      return_id: { type: DataTypes.BIGINT, allowNull: false },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      batch_id: { type: DataTypes.BIGINT },
      qty: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
      unit_cost: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      condition: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'RUSAK' },
    },
    {
      sequelize,
      tableName: 'supplier_return_items',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}