import { DataTypes, Model, Sequelize, type Optional } from 'sequelize';

/**
 * `stock_opnames` — header hasil opname stok harian (MP-5).
 *
 * Baris item + `cause` ada di `stock_opname_items` (`stock-opname-item.model.ts`),
 * dan koreksi stok SELALU lewat movement `ADJUSTMENT` bertanda
 * `reference_type='OPNAME'` + `reference_id` = id opname ini (ledger tetap
 * append-only; trigger `trg_stock_movement_apply` yang benar-benar mengubah
 * `qty_remaining`/`qty_damaged`).
 *
 * `opname_no` = `OPN-YYYYMMDD-NNN` dari sequence `opname_no_seq`
 * (`services/docno.ts`), bukan `max()+1` — tetap unik saat 2 kasir opname
 * bersamaan. `opname_date` kolom `date` (DATEONLY: tulis/baca string
 * `YYYY-MM-DD`, response dinormalkan lewat `utils/dates.ts`).
 *
 * Tabel hanya punya `created_at` -> `updatedAt: false`.
 */
export interface StockOpnameAttributes {
  id: number;
  opname_no: string;
  opname_date: string;
  note: string | null;
  created_by: number | null;
  created_at: Date;
}

export type StockOpnameCreationAttributes = Optional<
  StockOpnameAttributes,
  'id' | 'opname_date' | 'note' | 'created_by' | 'created_at'
>;

export class StockOpname extends Model<StockOpnameAttributes, StockOpnameCreationAttributes> {
  declare id: number;
  declare opname_no: string;
  declare opname_date: string;
  declare note: string | null;
  declare created_by: number | null;
  declare created_at: Date;

  /** Dipasang lewat `StockOpname.belongsTo(UserAccount, { as: 'creator' })`. */
  declare creator?: { id: number; username: string } | null;
  /** Dipasang lewat `StockOpname.hasMany(StockOpnameItem, { as: 'items' })`. */
  declare items?: StockOpnameItemRef[];
}

/** Bentuk minimum `stock_opname_items` untuk include `StockOpname.items`. */
export interface StockOpnameItemRef {
  id: number;
  opname_id: number;
  product_id: number;
  batch_id: number | null;
  system_qty: number;
  physical_qty: number;
  difference: number;
  physical_qty_damaged: number | null;
  system_qty_damaged: number;
  damaged_difference: number;
  cause: string | null;
  note: string | null;
}

export function initStockOpname(sequelize: Sequelize): void {
  StockOpname.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      opname_no: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      // Default-nya dievaluasi PostgreSQL (`CURRENT_DATE`), sama persis dengan DEFAULT
      // di DDL — bukan tanggal dari jam server Node (bisa beda zona waktu).
      opname_date: { type: DataTypes.DATEONLY, allowNull: false, defaultValue: Sequelize.literal('CURRENT_DATE') },
      note: { type: DataTypes.TEXT },
      created_by: { type: DataTypes.INTEGER },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      tableName: 'stock_opnames',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );
}