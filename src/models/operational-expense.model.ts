import { DataTypes, Model, Sequelize, type Optional } from 'sequelize';

/**
 * Sumber baris opex (kolom `operational_expenses.source`, enum di openapi):
 *  - MANUAL         = diinput OWNER lewat `POST /expenses`
 *  - SUPPLIER_RETURN = otomatis dari `settleSupplierReturn` WRITTEN_OFF
 *    (barang rusak ditolak distributor -> rugi jadi opex kategori BARANG_RUSAK).
 * Baris `SUPPLIER_RETURN` ter-link ke returnya lewat `supplier_return_id` dan
 * tidak boleh dikoreksi manual lewat `PATCH /expenses/{id}` (immutable, lihat
 * `expense.service.ts`) supaya pembukuan tetap mengikuti dokumen retur.
 */
export type ExpenseSource = 'MANUAL' | 'SUPPLIER_RETURN';

/**
 * `operational_expenses` — pengeluaran operasional (MP-6).
 *
 * Bentuk & aturan yang dipertahankan persis dari versi raw SQL lama:
 *  - `expense_date` kolom `date` (DATEONLY: tulis string `YYYY-MM-DD`, response
 *    dinormalkan ke bentuk wire lama lewat `utils/dates.ts`). Default-nya tetap
 *    dievaluasi PostgreSQL (`CURRENT_DATE`), sama persis dengan DEFAULT di DDL.
 *  - `category` varchar(50) BEBAS (openapi: "GAJI KARYAWAN / LISTRIK /
 *    INTERNET / lainnya", dinormalisasi UPPERCASE_UNDERSCORE di service) —
 *    DB tidak punya CHECK kategori, hanya `chk_opex_amount_positive (amount > 0)`
 *    yang jadi penjaga resmi nominal.
 *  - `amount` numeric(14,2); `source` default `MANUAL`; `supplier_return_id`
 *    nullable (FK ke `supplier_returns`, ON DELETE RESTRICT) = penanda opex
 *    turunan write-off.
 *  - `is_test` = penanda skrip uji (T9), dikecualikan dari `GET /expenses` dan
 *    P&L kecuali `?include_test=true`.
 *
 * Tabel punya `created_at` + `updated_at` -> `timestamps: true`.
 */
export interface OperationalExpenseAttributes {
  id: number;
  /** Kolom `date`; ditulis/read sebagai string `YYYY-MM-DD` (DATEONLY). */
  expense_date: string;
  category: string;
  description: string | null;
  amount: number;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  source: ExpenseSource;
  supplier_return_id: number | null;
  is_test: boolean;
}

export type OperationalExpenseCreationAttributes = Optional<
  OperationalExpenseAttributes,
  'id' | 'expense_date' | 'description' | 'created_by' | 'created_at' | 'updated_at' | 'source' | 'supplier_return_id' | 'is_test'
>;

export class OperationalExpense extends Model<OperationalExpenseAttributes, OperationalExpenseCreationAttributes> {
  declare id: number;
  declare expense_date: string;
  declare category: string;
  declare description: string | null;
  declare amount: number;
  declare created_by: number | null;
  declare created_at: Date;
  declare updated_at: Date;
  declare source: ExpenseSource;
  declare supplier_return_id: number | null;
  declare is_test: boolean;

  /** Dipasang lewat `OperationalExpense.belongsTo(UserAccount, { as: 'creator' })`. */
  declare creator?: { id: number; username: string } | null;
}

export function initOperationalExpense(sequelize: Sequelize): void {
  OperationalExpense.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      // Default dievaluasi PostgreSQL (CURRENT_DATE) — sama persis dengan DEFAULT
      // di DDL, bukan tanggal dari jam server Node (bisa beda zona waktu).
      expense_date: { type: DataTypes.DATEONLY, allowNull: false, defaultValue: Sequelize.literal('CURRENT_DATE') },
      category: { type: DataTypes.STRING(50), allowNull: false },
      description: { type: DataTypes.TEXT },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      created_by: { type: DataTypes.INTEGER },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'MANUAL' },
      supplier_return_id: { type: DataTypes.BIGINT },
      is_test: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    {
      sequelize,
      tableName: 'operational_expenses',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  );
}