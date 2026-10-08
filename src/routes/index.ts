import { Router } from 'express';
import { asyncHandler as h, validateBody as vBody, validateQuery as vQuery } from '../middleware/validate.js';
import { requireAuth, requireRole, requireIdempotencyKey } from '../middleware/auth.js';
import { requireInternalKey, requireInternalKeyOrKasir } from '../middleware/internal-key.js';
import { rateLimit } from '../middleware/rate-limit.js';
import * as authCtrl from '../controllers/auth.controller.js';
import * as masterCtrl from '../controllers/master.controller.js';
import * as pmCtrl from '../controllers/payment-method.controller.js';
import * as stockCtrl from '../controllers/stock.controller.js';
import * as saleCtrl from '../controllers/sale.controller.js';
import * as supplierReturnCtrl from '../controllers/supplier-return.controller.js';
import * as opnameCtrl from '../controllers/opname.controller.js';
import * as expenseCtrl from '../controllers/expense.controller.js';
import * as cashCtrl from '../controllers/cash-session.controller.js';
import * as storeCtrl from '../controllers/store.controller.js';
import * as orderBookCtrl from '../controllers/order-book.controller.js';
import * as internalCatalogCtrl from '../controllers/internal-catalog.controller.js';
import * as S from '../controllers/schemas.js';

/**
 * RBAC v2 (plan-backend-v2 §3 + §8.1) **+ amandemen FE-11 (keputusan user)**.
 *
 *   KASIR = operator  -> semua mutasi (input master, pembelian, POS, opname, konfigurasi)
 *   OWNER = monitor   -> semua GET, termasuk seluruh `/reports/*` dan daftar opex
 *
 * Konsekuensi: OWNER tidak lagi bisa POST/PATCH/DELETE apa pun; kasir boleh input
 * operasional biasa tapi tidak boleh membacanya (`GET /expenses` & `/reports/*` OWNER).
 * GET lain (sales, stock, opnames, ledger, alerts, cash-sessions, dst.) terbuka untuk semua role.
 *
 * **Amandemen (revisi user, FE-11):** pengeluaran operasional jadi **OWNER sepenuhnya** —
 * input (`POST`/`PATCH /expenses`) ikut pindah ke OWNER. Kasir tidak punya menu/kapasitas
 * pengeluaran apa pun (list, input, ubah) → 403 di ketiga endpoint. Semua mutasi lain tetap KASIR.
 */
const KASIR = requireRole('KASIR');
const OWNER = requireRole('OWNER');

export function buildRouter(): Router {
  const r = Router();

  /* ------------------------------- auth ------------------------------- */
  // Satu-satunya endpoint publik (semua endpoint lain wajib token).
  r.post('/auth/login', rateLimit('login', { windowMs: 15 * 60_000, max: 10 }), vBody(S.loginSchema), h(authCtrl.login));
  r.post('/auth/refresh', rateLimit('refresh', { windowMs: 15 * 60_000, max: 30 }), vBody(S.refreshTokenSchema), h(authCtrl.refresh));

  /* ------------------- order books (bot WA) - jalur auth ganda ------------------- */
  // POST /order-books HARUS didaftarkan SEBELUM `r.use(requireAuth)` di bawah: endpoint ini
  // punya dua jalur auth - header `X-Internal-Key` (bot WhatsApp) ATAU login kasir.
  // Middleware requireInternalKeyOrKasir() yang menentukannya (lihat middleware/internal-key.ts).
  r.post('/order-books', requireInternalKeyOrKasir(), vBody(S.orderBookCreateSchema), h(orderBookCtrl.createOrderBook));

  /* ------------------- katalog internal (bot WA, WA-1) ------------------- */
  // Bot matcher butuh daftar produk + stok, tapi tidak punya JWT kasir -> endpoint ini
  // HANYA menerima `X-Internal-Key` (tidak dibuka ke sesi kasir) dan tidak mengirim harga beli.
  r.get('/internal/catalog', requireInternalKey, h(internalCatalogCtrl.getCatalog));

  r.use(requireAuth);
  r.get('/auth/me', h(authCtrl.me));
  r.post('/auth/logout', vBody(S.refreshTokenSchema), h(authCtrl.logout));

  /* ----------------------------- products ----------------------------- */
  r.get('/products', vQuery(S.productListSchema), h(masterCtrl.listProducts));
  r.post('/products', KASIR, vBody(S.productCreateSchema), h(masterCtrl.createProduct));
  r.get('/products/:id', h(masterCtrl.getProduct));
  r.patch('/products/:id', KASIR, vBody(S.productUpdateSchema), h(masterCtrl.updateProduct));
  r.delete('/products/:id', KASIR, h(masterCtrl.deleteProduct)); // soft delete (is_active=false)

  /* ---------------------------- categories ---------------------------- */
  r.get('/categories', vQuery(S.categoryListSchema), h(masterCtrl.listCategories));
  r.post('/categories', KASIR, vBody(S.categoryCreateSchema), h(masterCtrl.createCategory));
  r.patch('/categories/:id', KASIR, vBody(S.categoryUpdateSchema), h(masterCtrl.updateCategory));
  r.get('/product-types', h(masterCtrl.listProductTypes));
  r.post('/product-types', KASIR, vBody(S.productTypeCreateSchema), h(masterCtrl.createProductType));

  /* ---------------------------- customers ----------------------------- */
  r.get('/customers', vQuery(S.customerListSchema), h(masterCtrl.listCustomers));
  r.post('/customers', KASIR, vBody(S.customerSchema), h(masterCtrl.createCustomer));
  r.get('/customers/:id', h(masterCtrl.getCustomer));
  r.patch('/customers/:id', KASIR, vBody(S.customerUpdateSchema), h(masterCtrl.updateCustomer));

  /* ------------------------- payment methods -------------------------- */
  // Semua role boleh melihat daftar metode (dipakai di layar kasir); mutasi = kasir.
  r.get('/payment-methods', vQuery(S.paymentMethodListSchema), h(pmCtrl.listPaymentMethods));
  r.get('/payment-methods/:id', h(pmCtrl.getPaymentMethod));
  r.post('/payment-methods', KASIR, vBody(S.paymentMethodSchema), h(pmCtrl.createPaymentMethod));
  r.patch('/payment-methods/:id', KASIR, vBody(S.paymentMethodUpdateSchema), h(pmCtrl.updatePaymentMethod));

  /* ---------------------------- purchases ----------------------------- */
  r.get('/purchases', vQuery(S.purchaseListSchema), h(stockCtrl.listPurchases));
  r.post('/purchases', KASIR, vBody(S.purchaseSchema), h(stockCtrl.createPurchase));
  // Koreksi salah input barang masuk (guard: batch belum terpakai — lihat
  // purchase.service.updateBatch). Terdaftar SEBELUM GET /purchases/batches/:id
  // tidak masalah karena method berbeda; pattern sama namun Express cocokkan
  // method + path berpasangan.
  r.patch('/purchases/batches/:id', KASIR, vBody(S.batchUpdateSchema), h(stockCtrl.updateBatch));
  r.get('/purchases/batches/:id', h(stockCtrl.getBatch));

  /* ------------------------------- stock ------------------------------ */
  // Picker batch per produk untuk layar kasir (baruplan.md req #1).
  r.get('/products/:id/batches', vQuery(S.productBatchListSchema), h(stockCtrl.listProductBatches));

  /* ------------------------------- stock ------------------------------ */
  r.get('/stock', vQuery(S.stockListSchema), h(stockCtrl.listStock));
  r.get('/stock/movements', vQuery(S.movementListSchema), h(stockCtrl.listMovements));
  r.get('/stock/products/:id', h(stockCtrl.getProductStock));
  // Stok rusak karantina per batch - bahan baku layar "retur ke distributor" (semua role).
  r.get('/stock/damaged', vQuery(S.damagedStockListSchema), h(supplierReturnCtrl.listDamagedStock));

  /* ------------------------------- sales ------------------------------ */
  r.get('/sales', vQuery(S.saleListSchema), h(saleCtrl.listSales));
  // Idempotency-Key wajib -> mencegah double submit saat 2 POS / retry jaringan.
  r.post('/sales', KASIR, requireIdempotencyKey, vBody(S.saleCreateSchema), h(saleCtrl.createSale));
  r.get('/sales/:id', h(saleCtrl.getSale));
  r.get('/sales/:id/receipt', h(storeCtrl.saleReceipt));
  r.get('/sales/:id/payments', h(saleCtrl.listPayments));
  r.post('/sales/:id/payments', KASIR, requireIdempotencyKey, vBody(S.paymentCreateSchema), h(saleCtrl.createPayment));
  r.post('/sales/:id/void', KASIR, vBody(S.voidSchema), h(saleCtrl.voidSale));
  r.post('/sales/:id/refund', KASIR, requireIdempotencyKey, vBody(S.voidSchema), h(saleCtrl.refundSale));

  /* --------------------------- cash sessions --------------------------- */
  r.get('/cash-sessions', vQuery(S.cashListSchema), h(cashCtrl.listSessions));
  r.get('/cash-sessions/:id', h(cashCtrl.getSession));
  r.post('/cash-sessions/open', KASIR, vBody(S.cashOpenSchema), h(cashCtrl.openSession));
  r.post('/cash-sessions/:id/close', KASIR, vBody(S.cashCloseSchema), h(cashCtrl.closeSession));

  /* ------------------------------ opnames ----------------------------- */
  r.get('/opnames', vQuery(S.opnameListSchema), h(opnameCtrl.listOpnames));
  r.post('/opnames', KASIR, vBody(S.opnameCreateSchema), h(opnameCtrl.createOpname));
  r.get('/opnames/:id', h(opnameCtrl.getOpname));

  /* ------------------------- retur distributor ------------------------ */
  // Input retur + settle = operasi kasir (RBAC KASIR); daftar/detail dibaca semua role.
  r.post('/supplier-returns', KASIR, requireIdempotencyKey, vBody(S.supplierReturnCreateSchema), h(supplierReturnCtrl.createSupplierReturn));
  r.get('/supplier-returns', vQuery(S.supplierReturnListSchema), h(supplierReturnCtrl.listSupplierReturns));
  r.get('/supplier-returns/:id', h(supplierReturnCtrl.getSupplierReturn));
  r.post('/supplier-returns/:id/settle', KASIR, requireIdempotencyKey, vBody(S.supplierReturnSettleSchema), h(supplierReturnCtrl.settleSupplierReturn));

  /* ------------- OWNER only (RBAC) =------------ */
  // Pengeluaran operasional = OWNER penuh (amandemen FE-11): kasir tidak boleh
  // melihat maupun menginput opex; seluruh `/reports/*` juga khusus OWNER.
  r.get('/expenses', OWNER, vQuery(S.expenseListSchema), h(expenseCtrl.listExpenses));
  r.get('/expenses/:id', OWNER, h(expenseCtrl.getExpense));
  r.get('/reports/pnl', OWNER, vQuery(S.pnlQuerySchema), h(expenseCtrl.pnl));
  r.get('/reports/dashboard', OWNER, h(expenseCtrl.dashboard));
  r.get('/reports/opname', OWNER, vQuery(S.opnameReportQuerySchema), h(expenseCtrl.opnameReport));
  // Semua role boleh baca (dipakai layar kasir untuk monitoring stok & expiring).
  r.get('/alerts', h(expenseCtrl.alerts));

  /* --------- input opex (OWNER, amandemen FE-11) + konfigurasi (KASIR) --------- */
  r.post('/expenses', OWNER, vBody(S.expenseCreateSchema), h(expenseCtrl.createExpense));
  r.patch('/expenses/:id', OWNER, vBody(S.expenseUpdateSchema), h(expenseCtrl.updateExpense));

  // Profil toko: semua role boleh baca (dipakai header nota kasir), hanya kasir boleh ubah.
  r.get('/store', h(storeCtrl.getStore));
  r.patch('/store', KASIR, vBody(S.storeUpdateSchema), h(storeCtrl.updateStore));

  /* ----------------------------- order books ----------------------------- */
  // Daftar/detail dibuka semua role (dipakai layar kasir "Order WA");
  // mutasi item/status/convert = KASIR. POST-nya sudah didaftarkan di atas
  // (butuh jalur auth ganda: internal key ATAU kasir).
  r.get('/order-books', vQuery(S.orderBookListSchema), h(orderBookCtrl.listOrderBooks));
  r.get('/order-books/:id', h(orderBookCtrl.getOrderBook));
  r.patch('/order-books/:id/items/:itemId', KASIR, vBody(S.orderBookItemPatchSchema), h(orderBookCtrl.patchOrderBookItem));
  r.delete('/order-books/:id/items/:itemId', KASIR, h(orderBookCtrl.deleteOrderBookItem));
  r.post('/order-books/:id/status', KASIR, vBody(S.orderBookStatusSchema), h(orderBookCtrl.setOrderBookStatus));
  r.post('/order-books/:id/convert', KASIR, vBody(S.orderBookConvertSchema), h(orderBookCtrl.convertOrderBook));

  return r;
}
