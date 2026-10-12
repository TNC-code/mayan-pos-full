import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import { ApiError } from '../utils/errors.js';

/** Penyebab selisih opname (CHECK `chk_opname_item_cause` di DB). */
export type OpnameCause = 'RUSAK' | 'HILANG' | 'SALAH_HITUNG' | 'LAIN';

/**
 * `stock_opname_items` — satu baris hasil hitung fisik per produk (opsional per batch).
 *
 * Dua kolom SELISIH adalah GENERATED column DB — HANYA BACA:
 *  - `difference`         = `physical_qty - system_qty`
 *  - `damaged_difference` = `COALESCE(physical_qty_damaged, system_qty_damaged) - system_qty_damaged`
 * Setter-nya melempar ApiError (mengisi manual ditolak PostgreSQL dengan 428C9) —
 * pola yang sama dengan `sale_items.subtotal` dan `stock_batches.suggested_price`.
 *
 * `system_qty` / `system_qty_damaged` = SNAPSHOT stok sistem saat opname
 * (dibaca dari `stock_batches` di dalam transaksi yang sama dengan INSERT item),
 * sehingga laporan bulan lalu tidak ikut berubah karena penjualan sesudahnya.
 * Koreksi stok sendiri TIDAK dilakukan kolom ini, melainkan lewat movement
 * `ADJUSTMENT` (`condition` GOOD -> `qty_remaining`, RUSAK -> `qty_damaged`)
 * yang diproses trigger `trg_stock_movement_apply`.
 *
 * Tabel tidak punya kolom waktu (hanya FK + snapshot) -> `timestamps: false`.
 */
export interface StockOpnameItemAttributes {
  id: number;
  opname_id: number;
  product_id: number;
  /** NULL = opname tingkat produk (agregat semua batch produk tsb). */
  batch_id: number | null;
  /** Snapshot stok GOOD sistem saat opname. */
  system_qty: number;
  /** Hasil hitung fisik GOOD (input kasir). */
  physical_qty: number;
  note: string | null;
  /** Generated column DB (`physical_qty - system_qty`). */
  difference: number;
  /** Hasil hitung fisik barang RUSAK; NULL = dianggap sama dengan sistem. */
  physical_qty_damaged: number | null;
  cause: OpnameCause | null;
  /** Snapshot stok RUSAK sistem saat opname. */
  system_qty_damaged: number;
  /** Generated column DB (COALESCE(physical, system) - system). */
  damaged_difference: number;
}

/** Kolom generated (`difference`, `damaged_difference`) dikecualikan: tidak bisa ditulis aplikasi. */
export type StockOpnameItemCreationAttributes = Optional<
  Omit<StockOpnameItemAttributes, 'difference' | 'damaged_difference'>,
  'id' | 'batch_id' | 'note' | 'physical_qty_damaged' | 'cause' | 'system_qty_damaged'
>;

export class StockOpnameItem extends Model<StockOpnameItemAttributes, StockOpnameItemCreationAttributes> {
  declare id: number;
  declare opname_id: number;
  declare product_id: number;
  declare batch_id: number | null;
  declare system_qty: number;
  declare physical_qty: number;
  declare note: string | null;
  declare difference: number;
  declare physical_qty_damaged: number | null;
  declare cause: OpnameCause | null;
  declare system_qty_damaged: number;
  declare damaged_difference: number;

  /** Dipasang lewat `StockOpnameItem.belongsTo(StockOpname, { as: 'opname' })`. */
  declare opname?: { id: number; opname_no: string } | null;
  /** Dipasang lewat `StockOpnameItem.belongsTo(Product, { as: 'product' })`. */
  declare product?: { id: number; name: string | null; unit: string | null } | null;
  /** Dipasang lewat `StockOpnameItem.belongsTo(StockBatch, { as: 'batch' })`. */
  declare batch?: { id: number; batch_code: string | null } | null;
}

/** Setter generik untuk kolom generated:tolak tulis dengan pesan ramah. */
function generatedOnly(column: string): () => void {
  return () => {
    throw new ApiError(
      'VALIDATION_ERROR',
      `${column} dihitung otomatis oleh DB dari snapshot sistem vs hasil hitung fisik; tidak bisa diisi manual`,
    );
  };
}

export function initStockOpnameItem(sequelize: Sequelize): void {
  StockOpnameItem.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      opname_id: { type: DataTypes.BIGINT, allowNull: false },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      batch_id: { type: DataTypes.BIGINT },
      system_qty: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
      physical_qty: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
      note: { type: DataTypes.TEXT },
      // GENERATED ALWAYS AS (physical_qty - system_qty) STORED -> tidak bisa di-set.
      difference: { type: DataTypes.DECIMAL(14, 3), set: generatedOnly('difference') },
      physical_qty_damaged: { type: DataTypes.DECIMAL(14, 3) },
      cause: { type: DataTypes.STRING(12) },
      system_qty_damaged: { type: DataTypes.DECIMAL(14, 3), allowNull: false, defaultValue: 0 },
      // GENERATED ALWAYS AS (COALESCE(physical_qty_damaged, system_qty_damaged) - system_qty_damaged) STORED
      damaged_difference: { type: DataTypes.DECIMAL(14, 3), set: generatedOnly('damaged_difference') },
    },
    {
      sequelize,
      tableName: 'stock_opname_items',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}