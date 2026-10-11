export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INSUFFICIENT_STOCK'
  | 'VOID_NOT_ALLOWED'
  | 'PAYMENT_NOT_ALLOWED'
  | 'TRANSITION_NOT_ALLOWED'
  | 'DUPLICATE'
  | 'CONCURRENT_CONFLICT'
  | 'PRICE_BELOW_COST'
  | 'PAYMENT_OVER_TOTAL'
  | 'REFERENCE_NO_REQUIRED'
  | 'PAYMENT_METHOD_INACTIVE'
  | 'PAYMENT_METHOD_NOT_FOUND'
  | 'BATCH_ID_REQUIRED'
  | 'BATCH_NOT_FOUND'
  | 'VOID_REASON_REQUIRED'
  | 'VOIDED_BY_REQUIRED'
  | 'IMMUTABLE_RECORD'
  | 'DB_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'EXPENSE_NOT_FOUND'
  | 'TOO_MANY_REQUESTS'
  | 'REFUND_NOT_ALLOWED'
  | 'REFUND_QTY_EXCEEDED'
  | 'REFUND_AMOUNT_EXCEEDED'
  | 'VOID_ITEM_MISMATCH'
  | 'DAMAGED_QTY_INSUFFICIENT'
  | 'SUPPLIER_RETURN_SETTLED'
  | 'INTERNAL_KEY_INVALID'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_ITEM_NOT_FOUND'
  | 'ORDER_ALREADY_DONE'
  | 'ORDER_STATUS_TRANSITION'
  | 'ORDER_CONVERT_INVALID'
  | 'ORDER_LAST_ITEM'
  | 'MODULE_NOT_ACTIVE'
  | 'TRIAL_EXPIRED'
  | 'AKUN_SUSPENDED';

/**
 * Peta error -> HTTP.
 * Kolom "error DB" mengikuti pesan trigger di DB (fase.md section 3).
 */
const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHORIZED: 401,
  INTERNAL_KEY_INVALID: 401,
  FORBIDDEN: 403,
  // Gate subscription per modul (plan §D8 — dipasang di MP-8, kode didaftarkan
  // dari MP-1 supaya peta code->HTTP lengkap sebelum middleware gate hidup).
  MODULE_NOT_ACTIVE: 403,
  TRIAL_EXPIRED: 403,
  AKUN_SUSPENDED: 403,
  NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  ORDER_ITEM_NOT_FOUND: 404,
  CONCURRENT_CONFLICT: 409,

  // 409 CONFLICT
  INSUFFICIENT_STOCK: 409,
  DAMAGED_QTY_INSUFFICIENT: 409,
  SUPPLIER_RETURN_SETTLED: 409,
  VOID_NOT_ALLOWED: 409,
  PAYMENT_NOT_ALLOWED: 409,
  TRANSITION_NOT_ALLOWED: 409,
  ORDER_ALREADY_DONE: 409,
  ORDER_STATUS_TRANSITION: 409,
  DUPLICATE: 409,

  // 422 UNPROCESSABLE_ENTITY - aturan bisnis dari trigger DB
  PRICE_BELOW_COST: 422,
  PAYMENT_OVER_TOTAL: 422,
  REFERENCE_NO_REQUIRED: 422,
  PAYMENT_METHOD_INACTIVE: 422,
  PAYMENT_METHOD_NOT_FOUND: 422,
  BATCH_ID_REQUIRED: 422,
  BATCH_NOT_FOUND: 422,
  VOID_REASON_REQUIRED: 422,
  VOIDED_BY_REQUIRED: 422,
  REFUND_QTY_EXCEEDED: 422,
  REFUND_AMOUNT_EXCEEDED: 422,
  VOID_ITEM_MISMATCH: 422,
  ORDER_CONVERT_INVALID: 422,
  ORDER_LAST_ITEM: 422,

  // 405 METHOD_NOT_ALLOWED - ledger/transaksi immutable
  IMMUTABLE_RECORD: 405,
  EXPENSE_NOT_FOUND: 404,

  // 429 TOO MANY REQUESTS
  TOO_MANY_REQUESTS: 429,
  REFUND_NOT_ALLOWED: 409,

  DB_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new ApiError('VALIDATION_ERROR', msg, details);
export const notFound = (msg = 'Data tidak ditemukan') => new ApiError('NOT_FOUND', msg);
export const unauthorized = (msg = 'Token tidak valid atau sudah kedaluwarsa') => new ApiError('UNAUTHORIZED', msg);
export const forbidden = (msg = 'Akses ditolak untuk role ini') => new ApiError('FORBIDDEN', msg);
