import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

export type MovementType = 'IN' | 'OUT' | 'ADJUSTMENT';
/** GOOD = barang sellable; RUSAK = karantina (retur customer/void/supplier return). */
export type MovementCondition = 'GOOD' | 'RUSAK';

/**
 * `stock_movements` — LEDGER append-only.
 *
 * Sifat immutable ditegakkan oleh DB (`trg_stock_movement_immutable` BEFORE
 * DELETE OR UPDATE -> `IMMUTABLE_RECORD`/405 lewat `utils/db-errors.ts`), jadi
 * model ini sengaja TIDAK punya `updatedAt` dan tidak pernah dipakai untuk
 * `update()`/`destroy()` di service mana pun. Satu-satunya operasi yang boleh
 * adalah `create()` (movement `IN`/`ADJUSTMENT` dari pembelian & koreksi batch)
 * dan `find*` untuk dibaca.
 *
 * `condition` menentukan trigger `trg_stock_movement_apply` mengarahkan
 * `qty_change` ke kolom mana: GOOD -> `qty_remaining`, RUSAK -> `qty_damaged`.
 */
export interface StockMovementAttributes {
  id: number;
  product_id: number;
  /** NULL = movement tanpa batch (koreksi manual tingkat produk, bukan per batch). */
  batch_id: number | null;
  movement_type: MovementType;
  qty_change: number;
  unit_cost: number;
  /** PURCHASE | BATCH_EDIT | SALE | OPNAME | SUPPLIER_RETURN | MANUAL | … */
  reference_type: string;
  reference_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: Date;
  condition: MovementCondition;
}

export type StockMovementCreationAttributes = Optional<
  StockMovementAttributes,
  'id' | 'batch_id' | 'unit_cost' | 'reference_type' | 'reference_id' | 'note' | 'created_by' | 'created_at' | 'condition'
>;

export class StockMovement extends Model<StockMovementAttributes, StockMovementCreationAttributes> {
  declare id: number;
  declare product_id: number;
  declare batch_id: number | null;
  declare movement_type: MovementType;
  declare qty_change: number;
  declare unit_cost: number;
  declare reference_type: string;
  declare reference_id: number | null;
  declare note: string | null;
  declare created_by: number | null;
  declare created_at: Date;
  declare condition: MovementCondition;

  /** Dipasang lewat `StockMovement.belongsTo(Product, { as: 'product' })`. */
  declare product?: { id: number; name: string | null } | null;
  /** Dipasang lewat `StockMovement.belongsTo(StockBatch, { as: 'batch' })`. */
  declare batch?: { id: number; batch_code: string } | null;
  /** Dipasang lewat `StockMovement.belongsTo(UserAccount, { as: 'creator' })`. */
  declare creator?: { id: number; username: string } | null;
}

export function initStockMovement(sequelize: Sequelize): void {
  StockMovement.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      batch_id: { type: DataTypes.BIGINT },
      movement_type: { type: DataTypes.STRING(16), allowNull: false },
      qty_change: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
      unit_cost: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      reference_type: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'MANUAL' },
      reference_id: { type: DataTypes.BIGINT },
      note: { type: DataTypes.TEXT },
      created_by: { type: DataTypes.INTEGER },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      condition: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'GOOD' },
    },
    {
      sequelize,
      tableName: 'stock_movements',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );
}