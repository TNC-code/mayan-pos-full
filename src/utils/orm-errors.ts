import {
  ForeignKeyConstraintError,
  UniqueConstraintError,
  ValidationError,
} from 'sequelize';
import { ApiError } from './errors.js';
import { mapDbError } from './db-errors.js';

/**
 * Jembatan error Sequelize -> kontrak error API (`{error, code, details?}`).
 *
 * `middleware/error-handler.ts` memetakan error non-ApiError lewat
 * `utils/db-errors.ts`, yang membaca `err.code` milik driver `pg`. Error
 * Sequelize justru membungkus error asli di `err.parent`/`err.original`, jadi
 * tanpa jembatan ini `23505` (mis. SKU/barcode kembar) akan jatuh ke 500.
 *
 * Dipakai service yang sudah pindah ke ORM; service yang masih raw SQL
 * tidak berubah.
 */
export function mapOrmError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  if (err instanceof UniqueConstraintError) {
    // Pesan asli PostgreSQL yang dipakai (parity dengan jalur raw SQL lama),
    // mis. `duplicate key value violates unique constraint "uq_product_sku"`.
    const message = err.parent?.message ?? err.errors[0]?.message ?? err.message;
    return new ApiError('DUPLICATE', message);
  }
  if (err instanceof ForeignKeyConstraintError) {
    return new ApiError('VALIDATION_ERROR', err.parent?.message ?? err.message);
  }
  if (err instanceof ValidationError) {
    const message = err.errors.map((e: { message: string }) => e.message).join('; ') || err.message;
    return new ApiError('VALIDATION_ERROR', message);
  }

  // Error lain (termasuk yang membawa kode PG di `parent`) tetap lewat peta lama.
  const parent = (err as { parent?: unknown; original?: unknown } | null)?.parent ?? err;
  return mapDbError(parent);
}