import { z } from 'zod';

const id = z.coerce.number().int().positive();
const money = z.coerce.number().min(0, 'harga tidak boleh negatif');
const qty = z.coerce.number().positive('qty harus lebih besar dari 0');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format tanggal harus YYYY-MM-DD');

const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    return ['true', '1', 'yes'].includes(v.toLowerCase());
  });

/* ------------------------------- auth ------------------------------- */
export const loginSchema = z.object({
  username: z.string().min(1, 'username wajib diisi').trim(),
  password: z.string().min(1, 'password wajib diisi'),
});

/* ----------------------------- products ----------------------------- */
export const productCreateSchema = z.object({
  sku: z.string().trim().min(1).max(64).nullish(),
  barcode: z.string().trim().min(1).max(64).nullish(),
  name: z.string().trim().min(1, 'name wajib diisi').max(200),
  unit: z.string().trim().min(1).max(16).default('pcs'),
  category_id: id.nullish(),
  description: z.string().trim().max(500).nullish(),
  harga_beli: money.nullish(),
  harga_jual: money.nullish(),
  attributes: z.record(z.string(), z.unknown()).nullish(),
  min_stock: z.coerce.number().min(0).nullish(),
  unit_conversions: z.record(z.string(), z.coerce.number().positive()).nullish(),
  is_active: z.boolean().optional(),
});

export const productUpdateSchema = productCreateSchema.partial();

export const productListSchema = z.object({
  q: z.string().trim().min(1).optional(),
  category_id: z.coerce.number().int().positive().optional(),
  active: boolish,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ---------------------------- categories ---------------------------- */
export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1, 'name wajib diisi').max(100),
  type_id: id.nullish(),
});

export const categoryUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type_id: id.nullish(),
  is_active: z.boolean().optional(),
});

export const categoryListSchema = z.object({
  active_only: boolish,
});

export const productTypeCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

/* ------------------------- payment methods ------------------------- */
export const paymentMethodSchema = z.object({
  code: z.string().trim().min(2).max(30),
  name: z.string().trim().min(1, 'name wajib diisi').max(100),
  is_active: z.boolean().default(true),
  requires_reference: z.boolean().default(false),
  bank_name: z.string().trim().max(100).nullish(),
  account_no: z.string().trim().max(50).nullish(),
  account_name: z.string().trim().max(100).nullish(),
  notes: z.string().trim().max(500).nullish(),
  sort_order: z.coerce.number().int().min(0).max(9999).optional(),
});

export const paymentMethodUpdateSchema = paymentMethodSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'body tidak boleh kosong',
});

export const paymentMethodListSchema = z.object({
  active_only: boolish.default(true),
});

/* ---------------------------- customers ---------------------------- */
export const customerSchema = z.object({
  name: z.string().trim().min(1, 'name wajib diisi').max(200),
  address: z.string().trim().max(500).nullish(),
  phone: z.string().trim().max(50).nullish(),
  owner_name: z.string().trim().max(200).nullish(),
});

export const customerUpdateSchema = customerSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'body tidak boleh kosong',
});

export const customerListSchema = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ---------------------------- purchases ---------------------------- */
export const purchaseSchema = z.object({
  product_id: id,
  qty,
  unit_cost: money,
  expired_date: dateStr.nullish(),
  supplier: z.string().trim().max(128).nullish(),
  notes: z.string().trim().max(500).nullish(),
});

export const purchaseListSchema = z.object({
  product_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).optional(),
  active_only: boolish,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ------------------------------ sales ------------------------------ */
const saleItemSchema = z.object({
  product_id: id,
  batch_id: z.coerce.number().int().positive().nullish(),
  qty,
  unit_price: money,
  unit: z.string().trim().min(1).max(16).nullish(),
  note: z.string().trim().max(500).nullish(),
});

const salePaymentSchema = z.object({
  method_id: id,
  amount: money.positive('amount pembayaran harus lebih besar dari 0'),
  tendered_amount: money.nonnegative().nullish(),
  reference_no: z.string().trim().max(100).nullish(),
  notes: z.string().trim().max(500).nullish(),
});

export const saleCreateSchema = z
  .object({
    customer_id: id.nullish(),
    note: z.string().trim().max(500).nullish(),
    items: z.array(saleItemSchema).min(1, 'minimal 1 item penjualan'),
    payment: salePaymentSchema.nullish(),
    tax_percent: z.coerce.number().min(0).max(100).nullish(),
  })
  .superRefine((val, ctx) => {
    // Kasbon (tanpa pembayaran awal) wajib atas nama customer — piutang tanpa
    // nama tidak bisa ditagih dan tidak muncul rapi di layar Piutang.
    if (val.payment == null && val.customer_id == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['customer_id'],
        message: 'Penjualan tanpa pembayaran awal (kasbon) wajib menyertakan customer_id',
      });
    }
  });

export const saleListSchema = z.object({
  date_from: dateStr.optional(),
  date_to: dateStr.optional(),
  payment_status: z.enum(['UNPAID', 'PARTIAL', 'PAID']).optional(),
  status: z.enum(['COMPLETED', 'VOIDED', 'RETURNED']).optional(),
  customer_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).optional(),
  include_test: boolish,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const paymentCreateSchema = z.object({
  method_id: id,
  amount: money.positive('amount pembayaran harus lebih besar dari 0'),
  tendered_amount: money.nonnegative().nullish(),
  reference_no: z.string().trim().max(100).nullish(),
  notes: z.string().trim().max(500).nullish(),
});

const conditionSchema = z.enum(['GOOD', 'RUSAK']);

/**
 * Item pengembalian barang (void / retur).
 * - `qty` dipakai oleh refund parsial; void mengabaikan nilainya (void selalu utuh),
 *   jadi opsional di sini karena kedua endpoint berbagi schema yang sama.
 * - `condition` menentukan kolom stok mana yang bertambah (GOOD -> qty_remaining,
 *   RUSAK -> qty_damaged / karantina). Default GOOD = perilaku lama.
 */
const returnItemSchema = z.object({
  sale_item_id: id,
  qty: qty.optional(),
  condition: conditionSchema.default('GOOD'),
});

export const voidSchema = z.object({
  reason: z.string().trim().min(3, 'reason wajib diisi (minimal 3 karakter)').max(500),
  // Opsional: tanpa items = void penuh semua item dengan kondisi GOOD.
  items: z.array(returnItemSchema).min(1, 'minimal 1 item void').optional(),
  // Opsional (dipakai refund): tanpa method_id = metode pembayaran terakhir.
  method_id: id.optional(),
});

/* ------------------------------ stock ------------------------------ */
export const stockListSchema = z.object({
  product_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).optional(),
  category_id: z.coerce.number().int().positive().optional(),
  active_only: boolish,
  expiring_in_days: z.coerce.number().int().min(0).max(3650).optional(),
  in_stock_only: boolish,
  damaged_only: boolish,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const damagedStockListSchema = z.object({
  product_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const movementListSchema = z.object({
  product_id: z.coerce.number().int().positive().optional(),
  batch_id: z.coerce.number().int().positive().optional(),
  type: z.enum(['IN', 'OUT', 'ADJUSTMENT']).optional(),
  reference_type: z.string().trim().min(1).max(24).optional(),
  reference_id: z.coerce.number().int().positive().optional(),
  condition: conditionSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ------------------ retur distributor (UC-B) ------------------ */
const supplierReturnItemSchema = z.object({
  batch_id: id,
  qty,
  // Default = unit_cost batch (harga beli saat barang masuk).
  unit_cost: money.nullish(),
});

export const supplierReturnCreateSchema = z.object({
  supplier_name: z.string().trim().min(1, 'supplier_name wajib diisi').max(200),
  items: z.array(supplierReturnItemSchema).min(1, 'minimal 1 item retur'),
  note: z.string().trim().max(500).nullish(),
  // Tanda data uji (default false = retur produksi). Dikecualikan dari `refund_distributor`
  // di P&L; `?include_test=true` memunculkan lagi nilainya.
  is_test: z.boolean().nullish(),
});

/**
 * Settle retur distributor: discriminated union dua hasil yang TIDAK boleh tertukar.
 *  - REFUNDED   -> wajib `amount` (+ method_id bila mau dicatat lewat kanal pembayaran)
 *  - WRITTEN_OFF-> otomatis jadi opex BARANG_RUSAK, tanpa nominal
 */
export const supplierReturnSettleSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('REFUNDED'),
    amount: money.positive('amount refund distributor harus lebih besar dari 0'),
    method_id: id.nullish(),
    reference_no: z.string().trim().max(100).nullish(),
    note: z.string().trim().max(500).nullish(),
  }),
  z.object({
    result: z.literal('WRITTEN_OFF'),
    note: z.string().trim().max(500).nullish(),
  }),
]);

export const supplierReturnListSchema = z.object({
  status: z.enum(['PENDING', 'REFUNDED', 'WRITTEN_OFF']).optional(),
  supplier_name: z.string().trim().min(1).max(200).optional(),
  date_from: dateStr.optional(),
  date_to: dateStr.optional(),
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ----------------------------- opnames ----------------------------- */
/** Penyebab selisih opname (wajib diisi kalau kasir tahu penyebabnya). */
const opnameCauseSchema = z.enum(['RUSAK', 'HILANG', 'SALAH_HITUNG', 'LAIN']);

export const opnameCreateSchema = z.object({
  note: z.string().trim().max(500).nullish(),
  items: z
    .array(
      z.object({
        product_id: id,
        physical_qty: z.coerce.number().min(0, 'physical_qty tidak boleh negatif'),
        // Jumlah fisik barang RUSAK. Tidak diisi = dianggap sama dengan sistem
        // (tidak ada adjustment barang rusak; kolomnya diisi nilai sistem).
        physical_qty_damaged: z.coerce.number().min(0, 'physical_qty_damaged tidak boleh negatif').nullish(),
        cause: opnameCauseSchema.nullish(),
        batch_id: z.coerce.number().int().positive().nullish(),
        note: z.string().trim().max(500).nullish(),
      }),
    )
    .min(1, 'minimal 1 item opname'),
});

export const opnameListSchema = z.object({
  date: dateStr.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ------------------------ operational expenses ------------------------ */
export const expenseCreateSchema = z.object({
  expense_date: dateStr.optional(),
  category: z
    .string()
    .trim()
    .min(2, 'category wajib diisi')
    .max(50)
    .regex(/^[A-Za-z0-9_ ]+$/, 'category hanya huruf/angka/spasi/underscore')
    .transform((v) => v.replace(/\s+/g, '_')),
  description: z.string().trim().max(500).nullish(),
  amount: z.coerce.number().positive('amount harus lebih besar dari 0'),
});

export const expenseUpdateSchema = expenseCreateSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'minimal satu field untuk update',
});

export const expenseListSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'format month harus YYYY-MM').optional(),
  category: z.string().trim().min(1).max(50).optional(),
  // Opex dari skrip uji disembunyikan secara default (padanan sales.include_test).
  include_test: boolish,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ------------------------------ reports ------------------------------ */
export const pnlQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'format month harus YYYY-MM'),
  // Data uji (sales / opex / retur distributor) dikecualikan default; OWNER boleh melihat
  // semuanya sekaligus (padanan GET /expenses?include_test).
  include_test: boolish,
});

/** Laporan analisa opname bulanan (OWNER). */
export const opnameReportQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'format month harus YYYY-MM'),
});

/* --------------------------- auth (refresh/logout) --------------------------- */
export const refreshTokenSchema = z.object({
  refresh_token: z.string().min(32, 'refresh_token tidak valid'),
});

/* ----------------------------- cash sessions ----------------------------- */
export const cashOpenSchema = z.object({
  opening_cash: z.coerce.number().min(0, 'opening_cash tidak boleh negatif'),
  note: z.string().trim().max(500).nullish(),
});

export const cashCloseSchema = z.object({
  closing_cash: z.coerce.number().min(0, 'closing_cash tidak boleh negatif'),
  note: z.string().trim().max(500).nullish(),
});

export const cashListSchema = z.object({
  user_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ----------------------------- store profile ----------------------------- */
export const storeUpdateSchema = z.object({
  name: z.string().trim().min(1, 'name toko wajib diisi').max(150).optional(),
  address: z.string().trim().max(500).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().max(100).nullish(),
  npwp: z.string().trim().max(40).nullish(),
  receipt_footer: z.string().trim().max(500).nullish(),
  logo_url: z.string().trim().max(500).nullish(),
}).refine((v) => Object.keys(v).length > 0, { message: 'minimal satu field untuk update' });
