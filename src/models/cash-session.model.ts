import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

/** Status shift kasir (CHECK `chk_cash_session_status`). */
export type CashSessionStatus = 'OPEN' | 'CLOSED';

/**
 * `cash_sessions` — satu shift kasir (MP-5).
 *
 * Hitungan kas (parity dengan jalur raw SQL lama, dipindah apa adanya):
 *  - `opening_cash` = saldo awal fisik yang tercatat kasir saat buka shift;
 *  - `expected_cash` = `opening_cash` + Σ payment CASH kasir ini sejak
 *    `opened_at` − Σ refund CASH kasir ini sejak `opened_at`
 *    (dihitung service `closeSession`, BUKAN trigger — DB hanya menjaga CHECK
 *    `chk_opening_cash_nonneg` dan `chk_cash_session_status`);
 *  - `difference` = `closing_cash` − `expected_cash` (selisih kas fisik vs sistem);
 *  - `closing_cash`/`expected_cash`/`difference` NULL selama masih OPEN.
 *
 * Kolom waktu: `opened_at` (default DB) + `closed_at` (diisi saat close) — bukan
 * kolom `created_at`/`updated_at`, jadi `timestamps: false`.
 */
export interface CashSessionAttributes {
  id: number;
  /** Kasir pemilik shift (FK `cash_sessions_user_id_fkey` -> `user_account.id`). */
  user_id: number;
  opening_cash: number;
  opened_at: Date;
  closed_at: Date | null;
  /** Hasil hitung fisik kas (isi saat close). */
  closing_cash: number | null;
  /** opening + CASH masuk − refund CASH (isi saat close). */
  expected_cash: number | null;
  /** closing − expected (isi saat close). */
  difference: number | null;
  status: CashSessionStatus;
  note: string | null;
}

export type CashSessionCreationAttributes = Optional<
  CashSessionAttributes,
  'id' | 'opened_at' | 'closed_at' | 'closing_cash' | 'expected_cash' | 'difference' | 'status' | 'note'
>;

export class CashSession extends Model<CashSessionAttributes, CashSessionCreationAttributes> {
  declare id: number;
  declare user_id: number;
  declare opening_cash: number;
  declare opened_at: Date;
  declare closed_at: Date | null;
  declare closing_cash: number | null;
  declare expected_cash: number | null;
  declare difference: number | null;
  declare status: CashSessionStatus;
  declare note: string | null;

  /** Dipasang lewat `CashSession.belongsTo(UserAccount, { as: 'user' })`. */
  declare user?: { id: number; username: string } | null;
}

export function initCashSession(sequelize: Sequelize): void {
  CashSession.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      opening_cash: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      opened_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      closed_at: { type: DataTypes.DATE },
      closing_cash: { type: DataTypes.DECIMAL(14, 2) },
      expected_cash: { type: DataTypes.DECIMAL(14, 2) },
      difference: { type: DataTypes.DECIMAL(14, 2) },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'OPEN' },
      note: { type: DataTypes.TEXT },
    },
    {
      sequelize,
      tableName: 'cash_sessions',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}