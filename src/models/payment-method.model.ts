import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

export interface PaymentMethodAttributes {
  id: number;
  code: string;
  name: string;
  is_active: boolean;
  /** TRUE -> `reference_no` wajib diisi saat bayar (dijaga trigger trg_payments_validate). */
  requires_reference: boolean;
  bank_name: string | null;
  account_no: string | null;
  account_name: string | null;
  notes: string | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export type PaymentMethodCreationAttributes = Optional<
  PaymentMethodAttributes,
  'id' | 'created_at' | 'updated_at' | 'is_active' | 'requires_reference' | 'sort_order'
>;

export class PaymentMethod extends Model<PaymentMethodAttributes, PaymentMethodCreationAttributes> {
  declare id: number;
  declare code: string;
  declare name: string;
  declare is_active: boolean;
  declare requires_reference: boolean;
  declare bank_name: string | null;
  declare account_no: string | null;
  declare account_name: string | null;
  declare notes: string | null;
  declare sort_order: number;
  declare created_at: Date;
  declare updated_at: Date;
}

export function initPaymentMethod(sequelize: Sequelize): void {
  PaymentMethod.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      code: { type: DataTypes.STRING(30), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(100), allowNull: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      requires_reference: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      bank_name: { type: DataTypes.STRING(100) },
      account_no: { type: DataTypes.STRING(50) },
      account_name: { type: DataTypes.STRING(100) },
      notes: { type: DataTypes.TEXT },
      sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      tableName: 'payment_methods',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      defaultScope: {
        where: { is_active: true },
      },
      scopes: {
        withInactive: {},
      },
    },
  );
}