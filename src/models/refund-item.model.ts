import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

/** Kondisi barang saat kembali: GOOD (bisa dijual lagi) / RUSAK (karantina). */
export type ReturnCondition = 'GOOD' | 'RUSAK';

/**
 * `refund_items` — detail barang yang kembali per refund (parsial & bisa berlabel
 * GOOD/RUSAK). `unit_price`/`subtotal` memakai harga jual snapshot `sale_items`
 * (bukan HPP), jadi total refund = nilai barang yang dikembalikan.
 *
 * Immutability (append-only) dijaga aplikasi: tidak ada endpoint edit/hapus,
 * dan `sale_items` sendiri tidak bisa dihapus (trigger `trg_sale_item_guard`),
 * jadi `refund_items` aman lewat FK-nya. Tabel tanpa kolom waktu ->
 * `timestamps: false`.
 */
export interface RefundItemAttributes {
  id: number;
  refund_id: number;
  sale_item_id: number;
  qty: number;
  condition: ReturnCondition;
  unit_price: number;
  subtotal: number;
}

export type RefundItemCreationAttributes = Optional<RefundItemAttributes, 'id' | 'condition'>;

export class RefundItem extends Model<RefundItemAttributes, RefundItemCreationAttributes> {
  declare id: number;
  declare refund_id: number;
  declare sale_item_id: number;
  declare qty: number;
  declare condition: ReturnCondition;
  declare unit_price: number;
  declare subtotal: number;

  /** Dipasang lewat `RefundItem.belongsTo(Refund, { as: 'refund' })`. */
  declare refund?: { id: number; sale_id: number } | null;
  /** Dipasang lewat `RefundItem.belongsTo(SaleItem, { as: 'sale_item' })`. */
  declare sale_item?: { id: number; product_id: number; batch_id: number } | null;
}

export function initRefundItem(sequelize: Sequelize): void {
  RefundItem.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      refund_id: { type: DataTypes.BIGINT, allowNull: false },
      sale_item_id: { type: DataTypes.BIGINT, allowNull: false },
      qty: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
      condition: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'GOOD' },
      unit_price: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      subtotal: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    },
    {
      sequelize,
      tableName: 'refund_items',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}