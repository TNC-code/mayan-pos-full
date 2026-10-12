import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

/**
 * Status dokumen retur distributor (CHECK `chk_supplier_return_status`).
 *  - PENDING    : barang rusak sudah keluar dari gudang, distributor belum/< belumBayar
 *  - REFUNDED   : distributor mengembalikan uang (isi `refunded_*`)
 *  - WRITTEN_OFF: distributor menolak -> barang jadi rugi, otomatis jadi opex BARANG_RUSAK
 */
export type SupplierReturnStatus = 'PENDING' | 'REFUNDED' | 'WRITTEN_OFF';

/**
 * Hasil `settleSupplierReturn` (discriminated union di `controllers/schemas.ts`).
 * Sama dengan status dokumen setelah settle, dibedakan agar tipe input service
 * tidak bisa menerima status `PENDING`.
 */
export type SupplierReturnSettleType = 'REFUNDED' | 'WRITTEN_OFF';

/**
 * `supplier_returns` — header retur barang RUSAK ke distributor (MP-6, UC-B).
 *
 * Aturan yang TIDAK BOLEH dibalik (paritas dengan versi raw SQL lama,
 * `git show e33b3b5:src/services/supplier-return.service.ts`):
 *  - `return_no` = `RTR-YYYYMMDD-NNN` dari sequence `supplier_return_no_seq`
 *    (`services/docno.ts`), bukan `max()+1` -> tetap unik saat 2 kasir retur
 *    bersamaan.
 *  - `total_cost` = Σ `supplier_return_items.qty × unit_cost` (harga BELI, bukan
 *    harga jual) — inilah yang jadi HPP barang rusak dan jadi opex saat write-off.
 *  - Stok TIDAK pernah disentuh kolom ini: `qty_damaged` batch dikurangi trigger
 *    `trg_stock_movement_apply` dari movement `OUT` condition `RUSAK`
 *    (`reference_type='SUPPLIER_RETURN'`, `reference_id` = id retur ini).
 *  - Transisi status hanya PENDING -> REFUNDED | WRITTEN_OFF, dijaga aplikasi
 *    (409 `SUPPLIER_RETURN_SETTLED`) karena tidak ada trigger transisi di DB.
 *  - `is_test` = penanda skrip uji (T9); P&L mengecualikannya kecuali
 *    `?include_test=true` (partial index `idx_supplier_returns_is_test`).
 *
 * Kolom waktu: hanya `created_at` -> `updatedAt: false`. `created_by`/`settled_by`
 * adalah FK ke `user_account` (dipasang sebagai association alias `creator`/
 * `settledBy`, bukan nama kolom, supaya tidak menabrak `dataValues`).
 */
export interface SupplierReturnAttributes {
  id: number;
  return_no: string;
  supplier_name: string;
  status: SupplierReturnStatus;
  /** Σ qty × unit_cost item retur (harga beli). */
  total_cost: number;
  refunded_amount: number | null;
  refunded_method_id: number | null;
  refunded_at: Date | null;
  settled_by: number | null;
  note: string | null;
  created_by: number | null;
  created_at: Date;
  refund_reference_no: string | null;
  is_test: boolean;
}

export type SupplierReturnCreationAttributes = Optional<
  SupplierReturnAttributes,
  | 'id'
  | 'status'
  | 'refunded_amount'
  | 'refunded_method_id'
  | 'refunded_at'
  | 'settled_by'
  | 'note'
  | 'created_by'
  | 'created_at'
  | 'refund_reference_no'
  | 'is_test'
>;

/** Bentuk minimum `supplier_return_items` untuk include `SupplierReturn.items`. */
export interface SupplierReturnItemRef {
  id: number;
  return_id: number;
  product_id: number;
  batch_id: number | null;
  qty: number;
  unit_cost: number;
  condition: string;
}

export class SupplierReturn extends Model<SupplierReturnAttributes, SupplierReturnCreationAttributes> {
  declare id: number;
  declare return_no: string;
  declare supplier_name: string;
  declare status: SupplierReturnStatus;
  declare total_cost: number;
  declare refunded_amount: number | null;
  declare refunded_method_id: number | null;
  declare refunded_at: Date | null;
  declare settled_by: number | null;
  declare note: string | null;
  declare created_by: number | null;
  declare created_at: Date;
  declare refund_reference_no: string | null;
  declare is_test: boolean;

  /** Dipasang lewat `SupplierReturn.belongsTo(UserAccount, { as: 'creator' })`. */
  declare creator?: { id: number; username: string } | null;
  /** Dipasang lewat `SupplierReturn.belongsTo(UserAccount, { as: 'settledBy' })`. */
  declare settledBy?: { id: number; username: string } | null;
  /**
   * Dipasang lewat `SupplierReturn.belongsTo(PaymentMethod, { as: 'refundedMethod' })`.
   * Wajib include lewat `PaymentMethod.scope('withInactive')` (default scope
   * `is_active = true` sedangkan JOIN lama tidak memfilternya).
   */
  declare refundedMethod?: { id: number; code: string; name: string } | null;
  /** Dipasang lewat `SupplierReturn.hasMany(SupplierReturnItem, { as: 'items' })`. */
  declare items?: SupplierReturnItemRef[];
}

export function initSupplierReturn(sequelize: Sequelize): void {
  SupplierReturn.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      return_no: { type: DataTypes.TEXT, allowNull: false, unique: true },
      supplier_name: { type: DataTypes.TEXT, allowNull: false },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'PENDING' },
      total_cost: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      refunded_amount: { type: DataTypes.DECIMAL(14, 2) },
      refunded_method_id: { type: DataTypes.INTEGER },
      refunded_at: { type: DataTypes.DATE },
      settled_by: { type: DataTypes.INTEGER },
      note: { type: DataTypes.TEXT },
      created_by: { type: DataTypes.INTEGER },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      refund_reference_no: { type: DataTypes.TEXT },
      is_test: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    {
      sequelize,
      tableName: 'supplier_returns',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );
}