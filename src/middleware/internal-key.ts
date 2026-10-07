import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../config/env.js';
import { ApiError, forbidden } from '../utils/errors.js';
import { requireAuth } from './auth.js';

const HEADER = 'x-internal-key';

/** Perbandingan waktu-tetap supaya panjang/isi kunci tidak bocor lewat timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Auth integrasi server-to-server: header `X-Internal-Key` harus sama persis dengan
 * env `INTERNAL_API_KEY` (lihat .env / .env.example).
 *
 * 401 `INTERNAL_KEY_INVALID` bila:
 *  - header tidak dikirim (untuk endpoint yang hanya menerima internal key), atau
 *  - nilainya salah, atau
 *  - env `INTERNAL_API_KEY` belum diisi (fitur dimatikan, bukan dibiarkan terbuka).
 */
export function requireInternalKey(req: Request, _res: Response, next: NextFunction): void {
  const configured = env.internalApiKey;
  if (!configured) {
    next(new ApiError('INTERNAL_KEY_INVALID', 'INTERNAL_API_KEY belum diset di server POS'));
    return;
  }

  const provided = req.header(HEADER)?.trim();
  if (!provided) {
    next(new ApiError('INTERNAL_KEY_INVALID', 'Header X-Internal-Key wajib diisi untuk endpoint ini'));
    return;
  }
  if (!safeEqual(provided, configured)) {
    next(new ApiError('INTERNAL_KEY_INVALID', 'X-Internal-Key tidak valid'));
    return;
  }

  req.internalCaller = true;
  next();
}

/**
 * Dua jalur auth untuk `POST /order-books`:
 *   1. `X-Internal-Key` valid            -> bot WA (created_by = user sistem 'bot')
 *   2. tanpa header itu                  -> JWT biasa, role KASIR (kasir buat manual)
 *
 * Header yang ADA tapi SALAH tidak jatuh ke jalur JWT (supaya mis-konfigurasi kunci
 * bot tidak diam-diam lolos lewat sesi kasir) -> 401 INTERNAL_KEY_INVALID.
 * Tanpa header sama sekali dan tanpa JWT -> 401 UNAUTHORIZED dari requireAuth.
 */
export function requireInternalKeyOrKasir(): RequestHandler {
  return (req, res, next) => {
    if (req.header(HEADER)?.trim()) {
      requireInternalKey(req, res, next);
      return;
    }
    requireAuth(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      if (req.user?.role !== 'KASIR') {
        next(forbidden('Endpoint ini hanya untuk role KASIR (atau X-Internal-Key untuk bot WA)'));
        return;
      }
      next();
    });
  };
}
