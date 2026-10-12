import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import { ApiError } from '../utils/errors.js';

/**
 * `stock_batches` — batch barang masuk (satu PO/satu(set) harga).
 *
 * Catatan kontrak angka & tipe (parity dengan jalur raw SQL lama):
 *  - `id` bigserial + parser int8 global di `src/db/sequelize.ts` -> `number`
 *    (bukan string);MP-9: itu satu-satunya tempat parser-nya dipasang —
 *    `src/config/db.ts` (pool `pg` mentah) sudah dihapus.
 *  - `qty_*` numeric(14,3) dan `unit_cost`/`markup_value` numeric(14,2)
 *    dikembalikan NUMBER oleh parser numeric -> response FE tidak bergeser.
 *  - `expired_date` kolom `date`: ditulis apa adanya sebagai string `YYYY-MM-DD`
 *    (`DATEONLY` + `YYYY-MM-DD` dari zod), dibaca dikembalikan string oleh
 *    Sequelize. `services/*` yang mengubahnya ke bentuk ISO milik API lama.
 *  - `suggested_price` = GENERATED column di DB (`unit_cost` + `markup_*`).
 *    HANYA BACA: dideklarasikan tanpa `CreationAttributes` dan setter-nya
 *    melempar ApiError, jadi mustahil service tries to write (PostgreSQL juga
 *    menolak: `428C9 cannot insert a non-DEFAULT value into column …`, yang
 *    tanpa guard ini akan jadi 500).
 *  - Tabel ini tidak punya kolom waktu besides `received_at` -> `timestamps: false`.
 */
export interface StockBatchAttributes {
  id: number;
  /** `GRN-YYYYMMDD-NNN` dari sequence `batch_code_seq` (lihat services/docno.ts). */
  batch_code: string;
  product_id: number;
  qty_received: number;
  /** Ditulis trigger `trg_stock_movement_apply` (dari `qty_change` movement), bukan aplikasi. */
  qty_remaining: number;
  unit_cost: number;
  expired_date: string | null;
  supplier: string | null;
  note: string | null;
  attributes: Record<string, unknown>;
  received_at: Date;
  created_by: number | null;
  /** Barang rusak karantina (void/refund RUSAK, opname) — kolom terpisah dari GOOD. */
  qty_damaged: number;
  /** NULL = batch lama sebelum fitur markup (harga jual = unit_cost). */
  markup_type: 'AMOUNT' | 'PERCENT' | null;
  markup_value: number;
  /** Generated column DB — baca saja. */
  suggested_price: number;
}

/** `suggested_price` dikecualikan: kolom generated, tidak boleh ditulis aplikasi. */
export type StockBatchCreationAttributes = Optional<
  Omit<StockBatchAttributes, 'suggested_price'>,
  | 'id'
  | 'qty_remaining'
  | 'expired_date'
  | 'supplier'
  | 'note'
  | 'attributes'
  | 'received_at'
  | 'created_by'
  | 'qty_damaged'
  | 'markup_type'
  | 'markup_value'
>;

export class StockBatch extends Model<StockBatchAttributes, StockBatchCreationAttributes> {
  declare id: number;
  declare batch_code: string;
  declare product_id: number;
  declare qty_received: number;
  declare qty_remaining: number;
  declare unit_cost: number;
  declare expired_date: string | null;
  declare supplier: string | null;
  declare note: string | null;
  declare attributes: Record<string, unknown>;
  declare received_at: Date;
  declare created_by: number | null;
  declare qty_damaged: number;
  declare markup_type: 'AMOUNT' | 'PERCENT' | null;
  declare markup_value: number;
  declare suggested_price: number;

  /** Dipasang lewat `StockBatch.belongsTo(Product, { as: 'product' })`. */
  declare product?: { id: number; name: string | null; unit: string | null; barcode: string | null } | null;
  /** Dipasang lewat `StockBatch.belongsTo(UserAccount, { as: 'creator' })`. */
  declare creator?: { id: number; username: string } | null;
}

export function initStockBatch(sequelize: Sequelize): void {
  StockBatch.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      batch_code: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      qty_received: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
      qty_remaining: { type: DataTypes.DECIMAL(14, 3), allowNull: false, defaultValue: 0 },
      unit_cost: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      expired_date: { type: DataTypes.DATEONLY },
      supplier: { type: DataTypes.STRING(128) },
      note: { type: DataTypes.TEXT },
      attributes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      received_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      created_by: { type: DataTypes.INTEGER },
      qty_damaged: { type: DataTypes.DECIMAL(14, 3), allowNull: false, defaultValue: 0 },
      markup_type: { type: DataTypes.STRING(10) },
      markup_value: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      // GENERATED ALWAYS AS (...) STORED -> tidak bisa di-set dari aplikasi.
      suggested_price: {
        type: DataTypes.DECIMAL(14, 2),
        set(): void {
          throw new ApiError(
            'VALIDATION_ERROR',
            'suggested_price dihitung otomatis oleh DB dari unit_cost + markup; tidak bisa diisi manual',
          );
        },
      },
    },
    {
      sequelize,
      tableName: 'stock_batches',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}