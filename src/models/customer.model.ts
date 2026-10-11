import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

export interface CustomerAttributes {
  id: number;
  name: string | null;
  address: string | null;
  phone: string | null;
  owner_name: string | null;
}

export type CustomerCreationAttributes = Optional<CustomerAttributes, 'id'>;

/**
 * `customer` — opsional untuk walk-in (kasbon wajib memilih customer).
 * Tabel WITHOUT ROWS waktu -> `timestamps: false`.
 *
 * Association ke `sales.customer_id` baru bisa dideklarasikan setelah
 * `sale.model.ts` ada (MP-4.1); sampai saat itu tabel dipakai lewat kolom FK
 * langsung, sama seperti versi raw SQL.
 */
export class Customer extends Model<CustomerAttributes, CustomerCreationAttributes> {
  declare id: number;
  declare name: string | null;
  declare address: string | null;
  declare phone: string | null;
  declare owner_name: string | null;
}

export function initCustomer(sequelize: Sequelize): void {
  Customer.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(200) },
      address: { type: DataTypes.STRING(500) },
      phone: { type: DataTypes.STRING(50) },
      owner_name: { type: DataTypes.STRING(200) },
    },
    {
      sequelize,
      tableName: 'customer',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}
