import type { DatabaseError } from 'pg';
import { ApiError, type ErrorCode } from './errors.js';

/**
 * Pemetaan pesan trigger/constraint PostgreSQL -> HTTP API.
 * Sumber: fase.md section 3 + definisi trigger di DB.
 * Aplikasi TIDAK memvalidasi ulang aturan stok/harga; DB yang menolak,
 * kita hanya menerjemahkan penolakannya ke status HTTP + kode stabil.
 */
const MESSAGE_RULES: Array<{ match: RegExp; code: ErrorCode }> = [
  // --- sale_items / stok / harga ---
  { match: /stok tidak cukup/i, code: 'INSUFFICIENT_STOCK' },
  { match: /stok rusak .* tidak cukup/i, code: 'DAMAGED_QTY_INSUFFICIENT' },
  { match: /tidak boleh di bawah harga beli/i, code: 'PRICE_BELOW_COST' },
  { match: /batch_id wajib diisi/i, code: 'BATCH_ID_REQUIRED' },
  { match: /batch .* tidak ditemukan/i, code: 'BATCH_NOT_FOUND' },

  // --- payments ---
  { match: /melebihi total penjualan/i, code: 'PAYMENT_OVER_TOTAL' },
  { match: /reference_no wajib/i, code: 'REFERENCE_NO_REQUIRED' },
  { match: /metode pembayaran tidak aktif/i, code: 'PAYMENT_METHOD_INACTIVE' },
  { match: /metode pembayaran tidak ditemukan/i, code: 'PAYMENT_METHOD_NOT_FOUND' },
  { match: /tidak dapat menambah pembayaran pada penjualan berstatus/i, code: 'PAYMENT_NOT_ALLOWED' },
  { match: /chk_payment_tendered_ge_amount|tendered/i, code: 'VALIDATION_ERROR' },

  // --- void ---
  { match: /tidak dapat void penjualan yang sudah dibayar/i, code: 'VOID_NOT_ALLOWED' },
  { match: /void_reason wajib/i, code: 'VOID_REASON_REQUIRED' },
  { match: /voided_by wajib/i, code: 'VOIDED_BY_REQUIRED' },
  // Pesan trigger `fn_sales_void` (baseline MP-1.2) memakai bentuk berikut; tanpa
  // aturan ini penolakan transisi status jatuh ke 500 INTERNAL_ERROR.
  { match: /voided_by dan void_reason wajib diisi/i, code: 'VOIDED_BY_REQUIRED' },
  { match: /hanya penjualan completed yang dapat di-void/i, code: 'TRANSITION_NOT_ALLOWED' },
  { match: /transisi .* -> .* tidak diizinkan/i, code: 'TRANSITION_NOT_ALLOWED' },
  { match: /metadata void tidak boleh diubah/i, code: 'TRANSITION_NOT_ALLOWED' },
  { match: /transisi status penjualan/i, code: 'TRANSITION_NOT_ALLOWED' },

  // --- immutability ---
  { match: /tidak boleh dihapus; gunakan void/i, code: 'IMMUTABLE_RECORD' },
  { match: /hanya boleh mengubah kolom note/i, code: 'IMMUTABLE_RECORD' },
  { match: /append-only ledger/i, code: 'IMMUTABLE_RECORD' },
];

/** Kode error PG yang layak di-retry (hanya koneksi/serialisasi, bukan business error). */
const RETRYABLE_PG_CODES = new Set(['40001', '40P01', '55P03', '57P01']);

export function isRetryableDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ApiError) return false;
  // Error Sequelize membungkus error `pg` asli di `parent`/`original`, jadi kode
  // SQLSTATE harus dibaca dari sana juga — tanpa ini, retry policy `fase.md`
  // tidak pernah aktif untuk service yang sudah pindah ke ORM (MP-2 dst).
  const sources: Array<{ code?: unknown } | undefined> = [
    err as { code?: unknown },
    (err as { parent?: { code?: unknown } }).parent,
    (err as { original?: { code?: unknown } }).original,
  ];
  for (const source of sources) {
    if (typeof source?.code === 'string' && RETRYABLE_PG_CODES.has(source.code)) return true;
  }
  // Error jaringan: ECONNREFUSED / ETIMEDOUT / socket hang up / server closed
  const message = `${err.message} ${String((err as { parent?: unknown }).parent ?? '')} ${
    (sources[1] as Error | undefined)?.message ?? ''
  }`;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|terminating connection|Client has encountered a connection error/i.test(
    message,
  );
}

export function mapDbError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  if (isRetryableDbError(err)) {
    return new ApiError('DB_UNAVAILABLE', 'Koneksi database bermasalah, silakan coba ulang');
  }

  const pgErr = err as Partial<DatabaseError> & { detail?: string; constraint?: string };
  const message = err instanceof Error ? err.message : String(err);

  for (const rule of MESSAGE_RULES) {
    if (rule.match.test(message)) {
      return new ApiError(rule.code, message);
    }
  }

  switch (pgErr?.code) {
    case '23505': // unique_violation
      return new ApiError('DUPLICATE', message);
    case '23503': // foreign_key_violation
      return new ApiError('VALIDATION_ERROR', message);
    case '23514': // check_violation
      return new ApiError('VALIDATION_ERROR', message);
    case '23502': // not_null_violation
      return new ApiError('VALIDATION_ERROR', message);
    case '22P02': // invalid_text_representation
      return new ApiError('VALIDATION_ERROR', message);
    case '08P01':
    case '08006':
      return new ApiError('DB_UNAVAILABLE', 'Koneksi database terputus');
    // MP-9: `statement_timeout` (env DB_STATEMENT_TIMEOUT_MS, default 15 detik) dan
    // `lock_timeout` membatalkan query dari sisi server. Itu BUKAN bug aplikasi:
    // database tidak menjawab dalam batas waktu -> 503 + retry, bukan 500.
    case '57014': // query_canceled
    case '55P03': // lock_not_available (di-handle retry policy; sampai sini tetap 503)
      return new ApiError('DB_UNAVAILABLE', 'Query terlalu lama diproses / terkunci, silakan coba ulang');
    default:
      return new ApiError('INTERNAL_ERROR', message || 'Terjadi kesalahan internal');
  }
}
