import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

/** Entitlement satu modul, mis. `{ "reports": { "valid_until": "2026-12-05", "price_monthly": 49000 } }`. */
export interface ModuleEntitlement {
  valid_until?: string | null;
  price_monthly?: number | null;
  paket_aktif?: string | null;
}

export type StoreModules = Record<string, ModuleEntitlement>;

export type AccountStatus = 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'SUSPENDED';

export interface StoreProfileAttributes {
  /** Selalu 1 (CHECK chk_store_single_row). */
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  npwp: string | null;
  receipt_footer: string | null;
  logo_url: string | null;
  updated_at: Date;
  updated_by: number | null;
  /** Entitlement subscription per modul (gate MP-8). */
  modules: StoreModules;
  trial_ends_at: Date | null;
  suspended_at: Date | null;
  account_status: AccountStatus;
}

export type StoreProfileCreationAttributes = Optional<
  StoreProfileAttributes,
  'id' | 'updated_at' | 'updated_by' | 'modules' | 'trial_ends_at' | 'suspended_at' | 'account_status'
>;

/** `store_profile` — single row id=1; hanya ada `updated_at` -> `createdAt: false`. */
export class StoreProfile extends Model<StoreProfileAttributes, StoreProfileCreationAttributes> {
  declare id: number;
  declare name: string;
  declare address: string | null;
  declare phone: string | null;
  declare email: string | null;
  declare npwp: string | null;
  declare receipt_footer: string | null;
  declare logo_url: string | null;
  declare updated_at: Date;
  declare updated_by: number | null;
  declare modules: StoreModules;
  declare trial_ends_at: Date | null;
  declare suspended_at: Date | null;
  declare account_status: AccountStatus;

  /** Sisa trial dalam hari (null bila sudah bukan TRIAL / trial_ends_at kosong). */
  get trialDaysLeft(): number | null {
    if (!this.trial_ends_at) return null;
    const ms = this.trial_ends_at.getTime() - Date.now();
    return Math.ceil(ms / 86_400_000);
  }
}

export function initStoreProfile(sequelize: Sequelize): void {
  StoreProfile.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
      name: { type: DataTypes.STRING(150), allowNull: false, defaultValue: 'Toko Saya' },
      address: { type: DataTypes.TEXT },
      phone: { type: DataTypes.STRING(30) },
      email: { type: DataTypes.STRING(100) },
      npwp: { type: DataTypes.STRING(40) },
      receipt_footer: { type: DataTypes.TEXT },
      logo_url: { type: DataTypes.TEXT },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updated_by: { type: DataTypes.INTEGER },
      // Getter typed: jsonb dari driver dibaca sebagai objek modul.
      modules: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        get(this: StoreProfile): StoreModules {
          const raw = this.getDataValue('modules') as unknown;
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as StoreModules;
          return {};
        },
      },
      trial_ends_at: { type: DataTypes.DATE },
      suspended_at: { type: DataTypes.DATE },
      account_status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'TRIAL' },
    },
    {
      sequelize,
      tableName: 'store_profile',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: false,
      updatedAt: 'updated_at',
    },
  );
}