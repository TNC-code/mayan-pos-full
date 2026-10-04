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
  const code = (err as DatabaseError).code;
  if (typeof code === 'string' && RETRYABLE_PG_CODES.has(code)) return true;
  // Error jaringan: ECONNREFUSED / ETIMEDOUT / socket hang up / server closed
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|terminating connection|Client has encountered a connection error/i.test(
    err.message,
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
    default:
      return new ApiError('INTERNAL_ERROR', message || 'Terjadi kesalahan internal');
  }
}
