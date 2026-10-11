import type { Sequelize } from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import { initUserAccount, UserAccount } from './user-account.model.js';
import { initRefreshToken, RefreshToken } from './refresh-token.model.js';
import { initProduct, Product } from './product.model.js';
import { initProductCategory, ProductCategory } from './product-category.model.js';
import { initProductType, ProductType } from './product-type.model.js';
import { initCustomer, Customer } from './customer.model.js';
import { initPaymentMethod, PaymentMethod } from './payment-method.model.js';
import { initStoreProfile, StoreProfile } from './store-profile.model.js';
import { initIdempotencyKey, IdempotencyKey } from './idempotency-key.model.js';

/**
 * REGISTRY MODEL (plan §D4).
 *
 * Konvensi yang berlaku untuk SEMUA model di folder ini:
 *  - `tableName` eksplisit + `freezeTableName: true` (schema campur singular/plural:
 *    `product`, `sale_items`, `stock_opnames`, ... — tidak mengandalkan pluralize).
 *  - `underscored: true` dan nama field TS = nama kolom (snake_case), jadi mapping
 *    ke response FE tidak perlu transformer (kecuali alias yang memang ada di
 *    kontrak lama, mis. `desctiption` -> `description`).
 *  - Uang & qty = `DECIMAL(14,2)` / `DECIMAL(14,3)`. Driver `pg` + parser global
 *    (src/db/sequelize.ts) mengembalikannya sebagai NUMBER agar JSON sama dengan
 *    jalur raw SQL lama; `FLOAT/REAL` DILARANG untuk uang.
 *  - `timestamps` per tabel: `false` untuk tabel tanpa kolom waktu
 *    (user_account, product_category, product_type, customer),
 *    `updatedAt: false` untuk tabel yang hanya punya `created_at`
 *    (stock_movements, refresh_tokens, idempotency_keys), `createdAt: false` untuk
 *    `store_profile` (hanya `updated_at`).
 *  - Tidak ada `sync()`/`sync({alter})` di mana pun: skema hanya lewat migration.
 *
 * Association dideklarasikan terpusat di sini (`associate()`) dan bertambah
 * bertahap per fase MP-2 dst.
 */

let initialized = false;
let associated = false;

/** Daftarkan seluruh model ke instance Sequelize (idempotent). */
export function initModels(instance: Sequelize = sequelize): void {
  if (initialized) return;
  initUserAccount(instance);
  initRefreshToken(instance);
  initProduct(instance);
  initProductCategory(instance);
  initProductType(instance);
  initCustomer(instance);
  initPaymentMethod(instance);
  initStoreProfile(instance);
  initIdempotencyKey(instance);
  initialized = true;
}

/** Associations (MP-1 subset inti, MP-2 master data). Foreign key selalu ditulis eksplisit. */
export function associate(): void {
  if (associated) return;
  initModels();

  RefreshToken.belongsTo(UserAccount, { foreignKey: 'user_id', as: 'user' });
  UserAccount.hasMany(RefreshToken, { foreignKey: 'user_id', as: 'refresh_tokens' });

  Product.belongsTo(ProductCategory, { foreignKey: 'category_id', as: 'category' });
  ProductCategory.hasMany(Product, { foreignKey: 'category_id', as: 'products' });

  // Product -> Category -> Type (MP-2.1). `id_type` nullable, jadi include selalu `required: false`.
  ProductCategory.belongsTo(ProductType, { foreignKey: 'id_type', as: 'type' });
  ProductType.hasMany(ProductCategory, { foreignKey: 'id_type', as: 'categories' });

  // Customer <-> Sales ditunda ke MP-4.1 (butuh `sale.model.ts`); sementara ini
  // `sales.customer_id` dibaca lewat kolom FK langsung, sama seperti versi raw SQL.

  associated = true;
}

// Model siap pakai sesaat setelah modul ini diimpor (service cukup import dari sini).
initModels();
associate();

export { sequelize };
export {
  Customer,
  IdempotencyKey,
  PaymentMethod,
  Product,
  ProductCategory,
  ProductType,
  RefreshToken,
  StoreProfile,
  UserAccount,
};
export type { ModuleEntitlement, StoreModules, AccountStatus } from './store-profile.model.js';
export type { UserRole } from './user-account.model.js';
export type { ProductAttributes, ProductCategoryRef } from './product.model.js';
export type { ProductCategoryAttributes } from './product-category.model.js';
export type { ProductTypeAttributes } from './product-type.model.js';
export type { CustomerAttributes } from './customer.model.js';
export type { PaymentMethodAttributes } from './payment-method.model.js';
export type { IdempotencyKeyAttributes } from './idempotency-key.model.js';
export type { RefreshTokenAttributes } from './refresh-token.model.js';
export type { StoreProfileAttributes } from './store-profile.model.js';
export type { UserAccountAttributes } from './user-account.model.js';