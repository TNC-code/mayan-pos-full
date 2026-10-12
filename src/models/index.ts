import type { Sequelize } from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import { initUserAccount, UserAccount } from './user-account.model.js';
import { initRefreshToken, RefreshToken } from './refresh-token.model.js';
import { initProduct, Product } from './product.model.js';
import { initProductCategory, ProductCategory } from './product-category.model.js';
import { initProductType, ProductType } from './product-type.model.js';
import { initCustomer, Customer } from './customer.model.js';
import { initPaymentMethod, PaymentMethod } from './payment-method.model.js';
import { initStockBatch, StockBatch } from './stock-batch.model.js';
import { initStockMovement, StockMovement } from './stock-movement.model.js';
import { initSale, Sale } from './sale.model.js';
import { initSaleItem, SaleItem } from './sale-item.model.js';
import { initPayment, Payment } from './payment.model.js';
import { initRefund, Refund } from './refund.model.js';
import { initRefundItem, RefundItem } from './refund-item.model.js';
import { initStoreProfile, StoreProfile } from './store-profile.model.js';
import { initIdempotencyKey, IdempotencyKey } from './idempotency-key.model.js';
import { initCashSession, CashSession } from './cash-session.model.js';
import { initStockOpname, StockOpname } from './stock-opname.model.js';
import { initStockOpnameItem, StockOpnameItem } from './stock-opname-item.model.js';
import { initSupplierReturn, SupplierReturn } from './supplier-return.model.js';
import { initSupplierReturnItem, SupplierReturnItem } from './supplier-return-item.model.js';
import { initOperationalExpense, OperationalExpense } from './operational-expense.model.js';

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
 *    (user_account, product_category, product_type, customer, refunds,
 *    refund_items),
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
  initStockBatch(instance);
  initStockMovement(instance);
  initSale(instance);
  initSaleItem(instance);
  initPayment(instance);
  initRefund(instance);
  initRefundItem(instance);
  initStoreProfile(instance);
  initIdempotencyKey(instance);
  initCashSession(instance);
  initStockOpname(instance);
  initStockOpnameItem(instance);
  initSupplierReturn(instance);
  initSupplierReturnItem(instance);
  initOperationalExpense(instance);
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

  // Customer <-> Sales (MP-4.1). Dipakai `GET /sales` & `GET /sales/:id`
  // untuk nama/alamat customer pada response (sebelumnya JOIN di raw SQL).
  Customer.hasMany(Sale, { foreignKey: 'customer_id', as: 'sales' });
  Sale.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });

  /* ------------------------- stok & pembelian (MP-3) -------------------------
   * Alias dipilih agar tidak menabrak nama kolom FK yang sama persis
   * (`created_by` sudah jadi `dataValues` kolom, jadi association memakai
   * alias `creator`, bukan `created_by`).
   *
   * PENTING saat `include` model `Product` dari service mana pun: model ini
   * punya default scope `is_active = true` (soft delete). Query lama
   * (`JOIN product p ON p.id = …`) TIDAK memfilter itu — batch/ledger produk
   * nonaktif tetap harus terbaca. Karena itu semua include wajib lewat
   * `Product.scope('withInactive')`.
   */
  Product.hasMany(StockBatch, { foreignKey: 'product_id', as: 'batches' });
  StockBatch.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });

  StockBatch.belongsTo(UserAccount, { foreignKey: 'created_by', as: 'creator' });

  Product.hasMany(StockMovement, { foreignKey: 'product_id', as: 'movements' });
  StockMovement.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });

  StockBatch.hasMany(StockMovement, { foreignKey: 'batch_id', as: 'movements' });
  StockMovement.belongsTo(StockBatch, { foreignKey: 'batch_id', as: 'batch' });

  StockMovement.belongsTo(UserAccount, { foreignKey: 'created_by', as: 'creator' });

  /* --------------------- transaksi penjualan (MP-4) ---------------------
   * Alias `creator` dipakai ulang agar tidak menabrak nama kolom FK
   * `created_by` di `dataValues` (lihat catatan stok di atas).
   *
   * PENTING: `PaymentMethod` punya default scope `is_active = true`, sedangkan
   * JOIN lama `JOIN payment_methods m ON m.id = p.method_id` TIDAK memfilternya
   * -> riwayat pembayaran/refund metode yang lalu dinonaktifkan tetap harus
   * terbaca. Semua include `method` wajib lewat `PaymentMethod.scope('withInactive')`
   * (sudah diterapkan di `sale.service.ts`).
   */
  Sale.belongsTo(UserAccount, { foreignKey: 'created_by', as: 'creator' });
  Sale.belongsTo(UserAccount, { foreignKey: 'voided_by', as: 'voidedBy' });

  Sale.hasMany(SaleItem, { foreignKey: 'sale_id', as: 'items' });
  SaleItem.belongsTo(Sale, { foreignKey: 'sale_id', as: 'sale' });

  SaleItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
  SaleItem.belongsTo(StockBatch, { foreignKey: 'batch_id', as: 'batch' });

  Sale.hasMany(Payment, { foreignKey: 'sale_id', as: 'payments' });
  Payment.belongsTo(Sale, { foreignKey: 'sale_id', as: 'sale' });
  Payment.belongsTo(PaymentMethod, { foreignKey: 'method_id', as: 'method' });
  Payment.belongsTo(UserAccount, { foreignKey: 'received_by', as: 'receiver' });

  Sale.hasMany(Refund, { foreignKey: 'sale_id', as: 'refunds' });
  Refund.belongsTo(Sale, { foreignKey: 'sale_id', as: 'sale' });
  Refund.belongsTo(PaymentMethod, { foreignKey: 'method_id', as: 'method' });
  Refund.belongsTo(UserAccount, { foreignKey: 'refunded_by', as: 'refunder' });

  Refund.hasMany(RefundItem, { foreignKey: 'refund_id', as: 'items' });
  RefundItem.belongsTo(Refund, { foreignKey: 'refund_id', as: 'refund' });
  RefundItem.belongsTo(SaleItem, { foreignKey: 'sale_item_id', as: 'sale_item' });

  /* ---------------------- shift kasir & opname (MP-5) ----------------------
   * `cash_sessions` hanya punya SATU FK ke user (`user_id` = kasir pemilik
   * shift; tidak ada kolom opened_by/closed_by terpisah di baseline), jadi
   * alias-nya `user` supaya tidak menabrak nama kolom `user_id` di dataValues.
   * Opname: header -> items, dibuat oleh kasir (`created_by` -> `creator`,
   * alias yang sama seperti batch/sale/movement di atas).
   */
  CashSession.belongsTo(UserAccount, { foreignKey: 'user_id', as: 'user' });

  StockOpname.hasMany(StockOpnameItem, { foreignKey: 'opname_id', as: 'items' });
  StockOpnameItem.belongsTo(StockOpname, { foreignKey: 'opname_id', as: 'opname' });
  StockOpname.belongsTo(UserAccount, { foreignKey: 'created_by', as: 'creator' });
  StockOpnameItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
  StockOpnameItem.belongsTo(StockBatch, { foreignKey: 'batch_id', as: 'batch' });

  /* ------------------- retur distributor & opex (MP-6) -------------------
   * Alias association memakai nama BEDA dari kolom FK-nya, supaya tidak
   * menabrak `dataValues` (pola yang sama seperti batch/sale/opname di atas):
   *   `created_by` -> `creator`, `settled_by` -> `settledBy`,
   *   `refunded_method_id` -> `refundedMethod`.
   *
   * PENTING saat include `SupplierReturn.refundedMethod` dan
   * `SupplierReturnItem.product`: keduanya punya default scope
   * `is_active = true` sedangkan JOIN lama TIDAK memfilternya -> riwayat retur
   * dari metode/produk yang lalu dinonaktifkan tetap harus terbaca, jadi include
   * wajib lewat `.scope('withInactive')` (pola yang sama dengan `sale.service.ts`).
   */
  SupplierReturn.hasMany(SupplierReturnItem, { foreignKey: 'return_id', as: 'items' });
  SupplierReturnItem.belongsTo(SupplierReturn, { foreignKey: 'return_id', as: 'return' });

  SupplierReturnItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
  SupplierReturnItem.belongsTo(StockBatch, { foreignKey: 'batch_id', as: 'batch' });

  SupplierReturn.belongsTo(UserAccount, { foreignKey: 'created_by', as: 'creator' });
  SupplierReturn.belongsTo(UserAccount, { foreignKey: 'settled_by', as: 'settledBy' });
  SupplierReturn.belongsTo(PaymentMethod, { foreignKey: 'refunded_method_id', as: 'refundedMethod' });

  OperationalExpense.belongsTo(UserAccount, { foreignKey: 'created_by', as: 'creator' });

  associated = true;
}

// Model siap pakai sesaat setelah modul ini diimpor (service cukup import dari sini).
initModels();
associate();

export { sequelize };
export {
  CashSession,
  Customer,
  IdempotencyKey,
  OperationalExpense,
  Payment,
  PaymentMethod,
  Product,
  ProductCategory,
  ProductType,
  RefreshToken,
  Refund,
  RefundItem,
  Sale,
  SaleItem,
  StockBatch,
  StockMovement,
  StockOpname,
  StockOpnameItem,
  StoreProfile,
  SupplierReturn,
  SupplierReturnItem,
  UserAccount,
};
export type { ModuleEntitlement, StoreModules, AccountStatus } from './store-profile.model.js';
export type { UserRole } from './user-account.model.js';
export type { ProductAttributes, ProductCategoryRef } from './product.model.js';
export type { ProductCategoryAttributes } from './product-category.model.js';
export type { ProductTypeAttributes } from './product-type.model.js';
export type { CustomerAttributes } from './customer.model.js';
export type { PaymentMethodAttributes } from './payment-method.model.js';
export type { SaleAttributes, SaleCreationAttributes, SaleStatus, SalePaymentStatus } from './sale.model.js';
export type { SaleItemAttributes, SaleItemCreationAttributes } from './sale-item.model.js';
export type { PaymentAttributes, PaymentCreationAttributes } from './payment.model.js';
export type { RefundAttributes, RefundCreationAttributes } from './refund.model.js';
export type { RefundItemAttributes, RefundItemCreationAttributes, ReturnCondition } from './refund-item.model.js';
export type { IdempotencyKeyAttributes } from './idempotency-key.model.js';
export type { RefreshTokenAttributes } from './refresh-token.model.js';
export type { StoreProfileAttributes } from './store-profile.model.js';
export type { UserAccountAttributes } from './user-account.model.js';
export type { StockBatchAttributes, StockBatchCreationAttributes } from './stock-batch.model.js';
export type {
  StockMovementAttributes,
  StockMovementCreationAttributes,
  MovementType,
  MovementCondition,
} from './stock-movement.model.js';
export type { CashSessionAttributes, CashSessionCreationAttributes, CashSessionStatus } from './cash-session.model.js';
export type { StockOpnameAttributes, StockOpnameCreationAttributes } from './stock-opname.model.js';
export type {
  StockOpnameItemAttributes,
  StockOpnameItemCreationAttributes,
  OpnameCause,
} from './stock-opname-item.model.js';
export type {
  SupplierReturnAttributes,
  SupplierReturnCreationAttributes,
  SupplierReturnStatus,
  SupplierReturnSettleType,
  SupplierReturnItemRef,
} from './supplier-return.model.js';
export type {
  SupplierReturnItemAttributes,
  SupplierReturnItemCreationAttributes,
  SupplierReturnCondition,
} from './supplier-return-item.model.js';
export type {
  OperationalExpenseAttributes,
  OperationalExpenseCreationAttributes,
  ExpenseSource,
} from './operational-expense.model.js';
