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

export const saleCreateSchema = z.object({
  customer_id: id.nullish(),
  note: z.string().trim().max(500).nullish(),
  items: z.array(saleItemSchema).min(1, 'minimal 1 item penjualan'),
  payment: salePaymentSchema.nullish(),
  tax_percent: z.coerce.number().min(0).max(100).nullish(),
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

export const voidSchema = z.object({
  reason: z.string().trim().min(3, 'reason wajib diisi (minimal 3 karakter)').max(500),
});

/* ------------------------------ stock ------------------------------ */
export const stockListSchema = z.object({
  product_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).optional(),
  category_id: z.coerce.number().int().positive().optional(),
  active_only: boolish,
  expiring_in_days: z.coerce.number().int().min(0).max(3650).optional(),
  in_stock_only: boolish,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const movementListSchema = z.object({
  product_id: z.coerce.number().int().positive().optional(),
  batch_id: z.coerce.number().int().positive().optional(),
  type: z.enum(['IN', 'OUT', 'ADJUSTMENT']).optional(),
  reference_type: z.string().trim().min(1).max(24).optional(),
  reference_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ----------------------------- opnames ----------------------------- */
export const opnameCreateSchema = z.object({
  note: z.string().trim().max(500).nullish(),
  items: z
    .array(
      z.object({
        product_id: id,
        physical_qty: z.coerce.number().min(0, 'physical_qty tidak boleh negatif'),
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
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ------------------------------ reports ------------------------------ */
export const pnlQuerySchema = z.object({
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
