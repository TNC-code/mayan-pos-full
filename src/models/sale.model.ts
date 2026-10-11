import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

/**
 * Status penjualan (CHECK `chk_sales_status`).
 *  - COMPLETED = selling normal (bisa UNPAID/PARTIAL/PAID);
 *  - VOIDED    = dibatalkan kasir sebelum dibayar (stok balik, `fn_sales_void`);
 *  - RETURNED  = retur/refund penuh (semua item habis).
 */
export type SaleStatus = 'COMPLETED' | 'VOIDED' | 'RETURNED';
/** Status bayar (CHECK `chk_sales_payment_status`); di-sync trigger `trg_payments_sync_status`. */
export type SalePaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

/**
 * `sales` — header penjualan (POS).
 *
 * Perilaku kolom yang TIDAK boleh bocor ke aplikasi:
 *  - `total_amount`/`tax_amount` ditulis service (subtotal item + PPN), bukan
 *    trigger; `payment_status` SELALU ditulis trigger `trg_payments_sync_status`
 *    (INSERT/UPDATE payments) — app tidak pernah menyentuhnya langsung;
 *  - `voided_at` diisi trigger `trg_sales_void` saat status berubah ke
 *    VOIDED/RETURNED (`chk_sales_void_consistency` mengikatnya ke status);
 *  - `status` hanya boleh berubah lewat service void/refund — trigger menolak
 *    transisi lain (`TRANSITION_NOT_ALLOWED`) dan `fn_sales_no_delete` melarang
 *    DELETE (ledger immutable, 405 `IMMUTABLE_RECORD`).
 *
 * Tabel hanya punya `created_at` -> `updatedAt: false`.
 */
export interface SaleAttributes {
  id: number;
  /** `INV-YYYYMMDD-NNN` dari sequence `sale_no_seq` (services/docno.ts). */
  sale_no: string;
  /** NULL = walk-in (tanpa nama); kasbon (tanpa payment) WAJIB punya customer. */
  customer_id: number | null;
  sale_date: Date;
  total_amount: number;
  note: string | null;
  created_by: number | null;
  created_at: Date;
  status: SaleStatus;
  payment_status: SalePaymentStatus;
  voided_at: Date | null;
  voided_by: number | null;
  void_reason: string | null;
  /** Baris data uji (P0 marking) — default-nya disembunyikan dari daftar/laporan. */
  is_test: boolean;
  tax_amount: number;
}

export type SaleCreationAttributes = Optional<
  SaleAttributes,
  | 'id'
  | 'customer_id'
  | 'sale_date'
  | 'note'
  | 'created_by'
  | 'created_at'
  | 'status'
  | 'payment_status'
  | 'voided_at'
  | 'voided_by'
  | 'void_reason'
  | 'is_test'
  | 'total_amount'
  | 'tax_amount'
>;

export class Sale extends Model<SaleAttributes, SaleCreationAttributes> {
  declare id: number;
  declare sale_no: string;
  declare customer_id: number | null;
  declare sale_date: Date;
  declare total_amount: number;
  declare note: string | null;
  declare created_by: number | null;
  declare created_at: Date;
  declare status: SaleStatus;
  declare payment_status: SalePaymentStatus;
  declare voided_at: Date | null;
  declare voided_by: number | null;
  declare void_reason: string | null;
  declare is_test: boolean;
  declare tax_amount: number;

  /** Dipasang lewat `Sale.belongsTo(Customer, { as: 'customer' })`. */
  declare customer?: { id: number; name: string | null; address: string | null } | null;
  /** Dipasang lewat `Sale.belongsTo(UserAccount, { as: 'creator' })`. */
  declare creator?: { id: number; username: string } | null;
  /** Dipasang lewat `Sale.hasMany(SaleItem, { as: 'items' })`. */
  declare items?: SaleItemRef[];
  /** Dipasang lewat `Sale.hasMany(Payment, { as: 'payments' })`. */
  declare payments?: PaymentRef[];
  /** Dipasang lewat `Sale.hasMany(Refund, { as: 'refunds' })`. */
  declare refunds?: RefundRef[];
}

/** Bentuk minimum `sale_items` untuk include `Sale.items` (lihat sale-item.model.ts). */
export interface SaleItemRef {
  id: number;
  sale_id: number;
  product_id: number;
  batch_id: number;
  qty: number;
  unit_price: number;
  unit_cost: number;
  subtotal: number;
  note: string | null;
}
/** Bentuk minimum `payments` untuk include `Sale.payments`. */
export interface PaymentRef {
  id: number;
  sale_id: number;
  method_id: number;
  amount: number;
  tendered_amount: number | null;
  change_amount: number | null;
  reference_no: string | null;
  paid_at: Date;
  received_by: number | null;
  notes: string | null;
}
/** Bentuk minimum `refunds` untuk include `Sale.refunds`. */
export interface RefundRef {
  id: number;
  sale_id: number;
  method_id: number | null;
  amount: number;
  reason: string;
  refunded_at: Date;
  refunded_by: number | null;
}

export function initSale(sequelize: Sequelize): void {
  Sale.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      sale_no: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      customer_id: { type: DataTypes.INTEGER },
      sale_date: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      total_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      note: { type: DataTypes.TEXT },
      created_by: { type: DataTypes.INTEGER },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'COMPLETED' },
      payment_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'UNPAID' },
      voided_at: { type: DataTypes.DATE },
      voided_by: { type: DataTypes.INTEGER },
      void_reason: { type: DataTypes.TEXT },
      is_test: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      tax_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    },
    {
      sequelize,
      tableName: 'sales',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );
}