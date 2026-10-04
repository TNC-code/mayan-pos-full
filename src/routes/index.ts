import { Router } from 'express';
import { asyncHandler as h, validateBody as vBody, validateQuery as vQuery } from '../middleware/validate.js';
import { requireAuth, requireRole, requireIdempotencyKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import * as authCtrl from '../controllers/auth.controller.js';
import * as masterCtrl from '../controllers/master.controller.js';
import * as pmCtrl from '../controllers/payment-method.controller.js';
import * as stockCtrl from '../controllers/stock.controller.js';
import * as saleCtrl from '../controllers/sale.controller.js';
import * as opnameCtrl from '../controllers/opname.controller.js';
import * as expenseCtrl from '../controllers/expense.controller.js';
import * as cashCtrl from '../controllers/cash-session.controller.js';
import * as storeCtrl from '../controllers/store.controller.js';
import * as S from '../controllers/schemas.js';

export function buildRouter(): Router {
  const r = Router();

  /* ------------------------------- auth ------------------------------- */
  // Satu-satunya endpoint publik (semua endpoint lain wajib token).
  r.post('/auth/login', rateLimit('login', { windowMs: 15 * 60_000, max: 10 }), vBody(S.loginSchema), h(authCtrl.login));
  r.post('/auth/refresh', rateLimit('refresh', { windowMs: 15 * 60_000, max: 30 }), vBody(S.refreshTokenSchema), h(authCtrl.refresh));

  r.use(requireAuth);
  r.get('/auth/me', h(authCtrl.me));
  r.post('/auth/logout', vBody(S.refreshTokenSchema), h(authCtrl.logout));

  /* ----------------------------- products ----------------------------- */
  r.get('/products', vQuery(S.productListSchema), h(masterCtrl.listProducts));
  r.post('/products', vBody(S.productCreateSchema), h(masterCtrl.createProduct));
  r.get('/products/:id', h(masterCtrl.getProduct));
  r.patch('/products/:id', vBody(S.productUpdateSchema), h(masterCtrl.updateProduct));
  r.delete('/products/:id', h(masterCtrl.deleteProduct)); // soft delete (is_active=false)

  /* ---------------------------- categories ---------------------------- */
  r.get('/categories', vQuery(S.categoryListSchema), h(masterCtrl.listCategories));
  r.post('/categories', vBody(S.categoryCreateSchema), h(masterCtrl.createCategory));
  r.patch('/categories/:id', vBody(S.categoryUpdateSchema), h(masterCtrl.updateCategory));
  r.get('/product-types', h(masterCtrl.listProductTypes));
  r.post('/product-types', vBody(S.productTypeCreateSchema), h(masterCtrl.createProductType));

  /* ---------------------------- customers ----------------------------- */
  r.get('/customers', vQuery(S.customerListSchema), h(masterCtrl.listCustomers));
  r.post('/customers', vBody(S.customerSchema), h(masterCtrl.createCustomer));
  r.get('/customers/:id', h(masterCtrl.getCustomer));
  r.patch('/customers/:id', vBody(S.customerUpdateSchema), h(masterCtrl.updateCustomer));

  /* ------------------------- payment methods -------------------------- */
  // Semua role boleh melihat daftar metode (dipakai di layar kasir).
  r.get('/payment-methods', vQuery(S.paymentMethodListSchema), h(pmCtrl.listPaymentMethods));
  r.get('/payment-methods/:id', h(pmCtrl.getPaymentMethod));

  /* ---------------------------- purchases ----------------------------- */
  r.get('/purchases', vQuery(S.purchaseListSchema), h(stockCtrl.listPurchases));
  r.post('/purchases', vBody(S.purchaseSchema), h(stockCtrl.createPurchase));
  r.get('/purchases/batches/:id', h(stockCtrl.getBatch));

  /* ------------------------------- stock ------------------------------ */
  r.get('/stock', vQuery(S.stockListSchema), h(stockCtrl.listStock));
  r.get('/stock/movements', vQuery(S.movementListSchema), h(stockCtrl.listMovements));
  r.get('/stock/products/:id', h(stockCtrl.getProductStock));

  /* ------------------------------- sales ------------------------------ */
  r.get('/sales', vQuery(S.saleListSchema), h(saleCtrl.listSales));
  // Idempotency-Key wajib -> mencegah double submit saat 2 POS / retry jaringan.
  r.post('/sales', requireIdempotencyKey, vBody(S.saleCreateSchema), h(saleCtrl.createSale));
  r.get('/sales/:id', h(saleCtrl.getSale));
  r.get('/sales/:id/receipt', h(storeCtrl.saleReceipt));
  r.get('/sales/:id/payments', h(saleCtrl.listPayments));
  r.post('/sales/:id/payments', requireIdempotencyKey, vBody(S.paymentCreateSchema), h(saleCtrl.createPayment));
  r.post('/sales/:id/void', vBody(S.voidSchema), h(saleCtrl.voidSale));
  r.post('/sales/:id/refund', requireIdempotencyKey, vBody(S.voidSchema), h(saleCtrl.refundSale));

  /* --------------------------- cash sessions --------------------------- */
  r.get('/cash-sessions', vQuery(S.cashListSchema), h(cashCtrl.listSessions));
  r.get('/cash-sessions/:id', h(cashCtrl.getSession));
  r.post('/cash-sessions/open', vBody(S.cashOpenSchema), h(cashCtrl.openSession));
  r.post('/cash-sessions/:id/close', vBody(S.cashCloseSchema), h(cashCtrl.closeSession));

  /* ------------------------------ opnames ----------------------------- */
  r.get('/opnames', vQuery(S.opnameListSchema), h(opnameCtrl.listOpnames));
  r.post('/opnames', vBody(S.opnameCreateSchema), h(opnameCtrl.createOpname));
  r.get('/opnames/:id', h(opnameCtrl.getOpname));

  /* ------------------- OWNER only (RBAC) ------------------- */
  // KASIR tidak boleh mengubah konfigurasi metode pembayaran / master harga beli.
  r.post('/payment-methods', requireRole('OWNER'), vBody(S.paymentMethodSchema), h(pmCtrl.createPaymentMethod));
  r.patch('/payment-methods/:id', requireRole('OWNER'), vBody(S.paymentMethodUpdateSchema), h(pmCtrl.updatePaymentMethod));

  // Pengeluaran operasional & laporan laba-rugi: hanya OWNER (input, update, lihat).
  r.get('/expenses', requireRole('OWNER'), vQuery(S.expenseListSchema), h(expenseCtrl.listExpenses));
  r.post('/expenses', requireRole('OWNER'), vBody(S.expenseCreateSchema), h(expenseCtrl.createExpense));
  r.get('/expenses/:id', requireRole('OWNER'), h(expenseCtrl.getExpense));
  r.patch('/expenses/:id', requireRole('OWNER'), vBody(S.expenseUpdateSchema), h(expenseCtrl.updateExpense));
  r.get('/reports/pnl', requireRole('OWNER'), vQuery(S.pnlQuerySchema), h(expenseCtrl.pnl));
  r.get('/reports/dashboard', requireRole('OWNER'), h(expenseCtrl.dashboard));
  r.get('/alerts', h(expenseCtrl.alerts));

  // Profil toko: semua role boleh baca (dipakai header nota kasir), hanya OWNER boleh ubah.
  r.get('/store', h(storeCtrl.getStore));
  r.patch('/store', requireRole('OWNER'), vBody(S.storeUpdateSchema), h(storeCtrl.updateStore));

  return r;
}
