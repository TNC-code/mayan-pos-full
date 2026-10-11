import bcrypt from 'bcrypt';
import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

export type UserRole = 'OWNER' | 'KASIR';

export interface UserAccountAttributes {
  id: number;
  username: string | null;
  password: string | null;
  full_name: string | null;
  phone: string | null;
  is_active: boolean | null;
  /** Kolom DB (CHECK OWNER/KASIR) = sumber kebenaran RBAC. */
  role: UserRole;
}

export type UserAccountCreationAttributes = Optional<UserAccountAttributes, 'id'>;

/**
 * `user_account` (tanpa kolom waktu buat) -> `timestamps: false`.
 * Password = hash bcrypt (BCRYPT_ROUNDS dari .env).
 */
export class UserAccount extends Model<UserAccountAttributes, UserAccountCreationAttributes> {
  declare id: number;
  declare username: string | null;
  declare password: string | null;
  declare full_name: string | null;
  declare phone: string | null;
  declare is_active: boolean | null;
  declare role: UserRole;

  /** Cocokkan password polos dengan hash bcrypt tersimpan. */
  async verifyPassword(plain: string): Promise<boolean> {
    if (!this.password) return false;
    return bcrypt.compare(plain, this.password);
  }
}

export function initUserAccount(sequelize: Sequelize): void {
  UserAccount.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      username: { type: DataTypes.STRING },
      password: { type: DataTypes.STRING },
      full_name: { type: DataTypes.STRING },
      phone: { type: DataTypes.STRING },
      is_active: { type: DataTypes.BOOLEAN },
      role: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'KASIR' },
    },
    {
      sequelize,
      tableName: 'user_account',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}