import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

export interface IdempotencyKeyAttributes {
  /** UUID dari header `Idempotency-Key` (PK -> klaim anti double-submit multi POS). */
  key: string;
  /** Response POST yang disimpan supaya retry mengembalikan hasil yang sama. */
  response: Record<string, unknown>;
  created_at: Date;
}

export type IdempotencyCreationAttributes = Optional<IdempotencyKeyAttributes, 'created_at'>;

/** `idempotency_keys` — hanya ada `created_at` (tabel lampiran, tidak pernah di-update). */
export class IdempotencyKey extends Model<IdempotencyKeyAttributes, IdempotencyCreationAttributes> {
  declare key: string;
  declare response: Record<string, unknown>;
  declare created_at: Date;
}

export function initIdempotencyKey(sequelize: Sequelize): void {
  IdempotencyKey.init(
    {
      key: { type: DataTypes.TEXT, primaryKey: true },
      response: { type: DataTypes.JSONB, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      tableName: 'idempotency_keys',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );
}