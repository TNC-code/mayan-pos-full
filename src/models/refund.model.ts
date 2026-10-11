import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

/**
 * `refunds` — header retur/refund uang penjualan (parsial atau penuh).
 *
 * Catatan siklus hidup: tabel ini TIDAK punya trigger penjaga. Guard-nya tetap di
 * service (`refundSale`) + trigger yang sudah ada:
 *  - `fn_sales_void` menjaga transisi `COMPLETED -> RETURNED` saat refund penuh
 *    (dan mengisi `voided_at`/`voided_by`/`void_reason` pada baris `sales`);
 *  - `payments` TIDAK disentuh (uang keluar dicatat sebagai pengurangan
 *    `refunded_amount`, bukan baris payment negatif) sehingga `payment_status`
 *    tetap sinkron dengan sisa pembayaran.
 * Tabel tidak punya kolom waktu buat `created_at`/`updated_at` -> `timestamps: false`.
 */
export interface RefundAttributes {
  id: number;
  sale_id: number;
  /** NULL = metode tidak recorded (penjualan tanpa payment tak bisa di-refund). */
  method_id: number | null;
  amount: number;
  reason: string;
  refunded_at: Date;
  refunded_by: number | null;
}

export type RefundCreationAttributes = Optional<RefundAttributes, 'id' | 'method_id' | 'refunded_at' | 'refunded_by'>;

export class Refund extends Model<RefundAttributes, RefundCreationAttributes> {
  declare id: number;
  declare sale_id: number;
  declare method_id: number | null;
  declare amount: number;
  declare reason: string;
  declare refunded_at: Date;
  declare refunded_by: number | null;

  /** Dipasang lewat `Refund.belongsTo(Sale, { as: 'sale' })`. */
  declare sale?: { id: number; sale_no: string } | null;
  /** Dipasang lewat `Refund.belongsTo(PaymentMethod, { as: 'method' })`. */
  declare method?: { id: number; code: string; name: string } | null;
  /** Dipasang lewat `Refund.belongsTo(UserAccount, { as: 'refunder' })`. */
  declare refunder?: { id: number; username: string } | null;
  /** Dipasang lewat `Refund.hasMany(RefundItem, { as: 'items' })`. */
  declare items?: RefundItemRef[];
}

/** Bentuk minimum `refund_items` untuk include `Refund.items`. */
export interface RefundItemRef {
  id: number;
  refund_id: number;
  sale_item_id: number;
  qty: number;
  condition: string;
  unit_price: number;
  subtotal: number;
}

export function initRefund(sequelize: Sequelize): void {
  Refund.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      sale_id: { type: DataTypes.BIGINT, allowNull: false },
      method_id: { type: DataTypes.INTEGER },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      reason: { type: DataTypes.TEXT, allowNull: false },
      refunded_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      refunded_by: { type: DataTypes.INTEGER },
    },
    {
      sequelize,
      tableName: 'refunds',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}