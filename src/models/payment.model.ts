import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import { ApiError } from '../utils/errors.js';

/**
 * `payments` — penerimaan kas per penjualan (DP/pelunasan bisa lebih dari 1 baris).
 *
 * Yang dijaga trigger (bukan aplikasi):
 *  - `trg_payments_validate` (BEFORE INSERT): metode harus ada (422
 *    `PAYMENT_METHOD_NOT_FOUND`), aktif (422 `PAYMENT_METHOD_INACTIVE`), dan
 *    `requires_reference` -> `reference_no` wajib (422 `REFERENCE_NO_REQUIRED`);
 *  - `trg_payments_sync_status` (AFTER INSERT/UPDATE/DELETE): lock baris
 *    `sales ... FOR UPDATE`, wajib `status = 'COMPLETED'`, tolak total bayar >
 *    total penjualan (422 `PAYMENT_OVER_TOTAL`), lalu tulis `payment_status`
 *    = UNPAID/PARTIAL/PAID. Service hanya menambahkan cek ramah lebih dulu.
 *
 * `change_amount` = GENERATED column (`tendered_amount - amount`) -> HANYA BACA
 * (kembalian CASH; NULL bila `tendered_amount` NULL).
 */
export interface PaymentAttributes {
  id: number;
  sale_id: number;
  method_id: number;
  amount: number;
  /** Uang yang diterima fisik (CASH boleh > amount; sisanya jadi `change_amount`). */
  tendered_amount: number | null;
  /** Generated column DB. */
  change_amount: number | null;
  reference_no: string | null;
  paid_at: Date;
  received_by: number | null;
  notes: string | null;
  created_at: Date;
}

export type PaymentCreationAttributes = Optional<
  Omit<PaymentAttributes, 'change_amount'>,
  'id' | 'tendered_amount' | 'reference_no' | 'paid_at' | 'received_by' | 'notes' | 'created_at'
>;

export class Payment extends Model<PaymentAttributes, PaymentCreationAttributes> {
  declare id: number;
  declare sale_id: number;
  declare method_id: number;
  declare amount: number;
  declare tendered_amount: number | null;
  declare change_amount: number | null;
  declare reference_no: string | null;
  declare paid_at: Date;
  declare received_by: number | null;
  declare notes: string | null;
  declare created_at: Date;

  /** Dipasang lewat `Payment.belongsTo(Sale, { as: 'sale' })`. */
  declare sale?: { id: number; sale_no: string } | null;
  /** Dipasang lewat `Payment.belongsTo(PaymentMethod, { as: 'method' })`. */
  declare method?: { id: number; code: string; name: string } | null;
  /** Dipasang lewat `Payment.belongsTo(UserAccount, { as: 'receiver' })`. */
  declare receiver?: { id: number; username: string } | null;
}

export function initPayment(sequelize: Sequelize): void {
  Payment.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      sale_id: { type: DataTypes.BIGINT, allowNull: false },
      method_id: { type: DataTypes.INTEGER, allowNull: false },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      tendered_amount: { type: DataTypes.DECIMAL(14, 2) },
      // GENERATED ALWAYS AS (tendered_amount - amount) STORED -> tidak bisa di-set.
      change_amount: {
        type: DataTypes.DECIMAL(14, 2),
        set(): void {
          throw new ApiError('VALIDATION_ERROR', 'change_amount dihitung otomatis oleh DB dari tendered_amount - amount');
        },
      },
      reference_no: { type: DataTypes.STRING(100) },
      paid_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      received_by: { type: DataTypes.INTEGER },
      notes: { type: DataTypes.TEXT },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      tableName: 'payments',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );
}