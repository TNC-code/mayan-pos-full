import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

export interface RefreshTokenAttributes {
  /** SHA-256 dari refresh token yang diberikan ke klien (token asli tidak disimpan). */
  token_hash: string;
  user_id: number;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export type RefreshTokenCreationAttributes = Optional<RefreshTokenAttributes, 'created_at' | 'revoked_at'>;

/** `refresh_tokens` (PK text = token_hash, FK user_id CASCADE). Hanya ada `created_at`. */
export class RefreshToken extends Model<RefreshTokenAttributes, RefreshTokenCreationAttributes> {
  declare token_hash: string;
  declare user_id: number;
  declare expires_at: Date;
  declare revoked_at: Date | null;
  declare created_at: Date;
  /** Hasil include `as: 'user'` (lihat association di src/models/index.ts). */
  declare user?: UserAccountRef | null;

  get isUsable(): boolean {
    return this.revoked_at === null && this.expires_at.getTime() > Date.now();
  }
}

/** Bentuk ringkas user hasil join (cukup untuk constructing AuthUser). */
export interface UserAccountRef {
  id: number;
  username: string | null;
  full_name: string | null;
  is_active: boolean | null;
  role: string;
}

export function initRefreshToken(sequelize: Sequelize): void {
  RefreshToken.init(
    {
      token_hash: { type: DataTypes.TEXT, primaryKey: true },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked_at: { type: DataTypes.DATE },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      tableName: 'refresh_tokens',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );
}