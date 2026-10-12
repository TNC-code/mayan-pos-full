import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../utils/errors.js';
import { StoreProfile } from '../models/index.js';
import type { AccountStatus, StoreModules } from '../models/store-profile.model.js';
import { PAKET_INVENTARIS } from '../services/modules.js';

/**
 * Lapis gate #1 — status siklus akun (MP-8; plan-subscription-tiering.md §2b & §7).
 *
 * Sumber kebenaran: baris tunggal `store_profile` id=1 (kolom entitlement yang
 * dibuat baseline migration MP-1). Satu query per request, di-cache di
 * `req.account` supaya `requireModule` di route berikutnya tidak query ulang.
 *
 * Perilaku:
 *  - `SUSPENDED`  -> SEMUA endpoint 403 `AKUN_SUSPENDED` (data tetap tersimpan).
 *  - `EXPIRED`    -> read-only: GET/HEAD/OPTIONS tetap jalan, mutasi
 *                    (POST/PATCH/PUT/DELETE) 403 `TRIAL_EXPIRED` + meta paket.
 *  - `TRIAL`/`ACTIVE` -> lolos penuh (gate modul yang berlaku kalau perlu).
 *
 * Dipasang di router SETELAH `/auth/me` & `/auth/logout` supaya app tetap bisa
 * membaca status akun dan logout saat akun kedaluwarsa/di-suspend.
 * Endpoint publik (`/auth/login`, `/auth/refresh`) berada sebelum middleware ini
 * dan TIDAK diblok saat SUSPENDED — sesuai keputusan scope MP-8 (login tetap 200,
 * penolakan terjadi di semua endpoint tenant).
 */

export interface AccountContext {
  id: number;
  account_status: AccountStatus;
  modules: StoreModules;
  trial_ends_at: string | null;
  suspended_at: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Cache baris `store_profile` id=1 (satu query per request). */
      account?: AccountContext;
    }
  }
}

const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** `true` untuk method yang mengubah data (EXPIRED = read-only). */
export function isMutationMethod(method: string): boolean {
  return MUTATION_METHODS.has(method.toUpperCase());
}

function toAccountContext(row: StoreProfile): AccountContext {
  return {
    id: row.id,
    account_status: row.account_status,
    modules: row.modules ?? {},
    trial_ends_at: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
    suspended_at: row.suspended_at ? new Date(row.suspended_at).toISOString() : null,
  };
}

/**
 * Baca `store_profile` id=1 lalu cache di `req.account`.
 *
 * Aman dipanggil TANPA JWT: gate ini hanya membaca baris toko, bukan user —
 * itulah sebabnya `requireModule` tetap bisa dipasang di jalur pra-auth
 * (`POST /order-books` via X-Internal-Key dan `GET /internal/catalog`).
 * Cache hanya hidup selama satu request (tanpa cache lintas-request supaya
 * penulisan dari platform/console langsung terlihat di request berikutnya).
 */
export async function loadAccount(req: Request): Promise<AccountContext> {
  const cached = req.account;
  if (cached) return cached;

  const row = await StoreProfile.findByPk(1);
  if (!row) {
    throw new ApiError('INTERNAL_ERROR', 'Profil toko belum diinisialisasi (jalankan migrasi)');
  }
  const account = toAccountContext(row);
  req.account = account;
  return account;
}

/**
 * INTI guard status akun: melempar `ApiError` kalau request tidak boleh
 * dilanjutkan. Sinkron & murni — TIDAK menyentuh DB, hanya membaca cache
 * `req.account` yang sudah di-isi `loadAccount`.
 *
 * Dipakai dari dua tempat supaya tidak ada jalur yang bisa lolos:
 *  1. `requireActiveAccount` (middleware global, jalur pasca-auth);
 *  2. awal `requireModule` — jalur PRA-auth (`POST /order-books` via
 *     `X-Internal-Key` & `GET /internal/catalog`) didaftarkan sebelum
 *     `requireActiveAccount`, jadi tanpa ini akun SUSPENDED masih bisa baca
 *     katalog & EXPIRED masih bisa mutasi lewat bot WA.
 *     `loadAccount` men-cache di `req.account`, jadi panggil kedua ini gratis
 *     dan idempoten.
 */
export function guardAccountStatus(req: Request): void {
  const account = req.account;
  if (!account) {
    // Penjaga pemrograman: guard hanya sah setelah `loadAccount` (atau
    // `requireActiveAccount`, yang memanggilnya sendiri).
    throw new ApiError('INTERNAL_ERROR', 'Guard status akun dipanggil sebelum store_profile dimuat');
  }

  if (account.account_status === 'SUSPENDED') {
    throw new ApiError('AKUN_SUSPENDED', 'Akun toko disuspend. Hubungi admin untuk mengaktifkan kembali', {
      account_status: account.account_status,
      suspended_at: account.suspended_at,
    });
  }

  if (account.account_status === 'EXPIRED' && isMutationMethod(req.method)) {
    throw new ApiError(
      'TRIAL_EXPIRED',
      'Masa trial berakhir — akun dalam mode baca saja. Aktifkan langganan untuk melanjutkan',
      {
        account_status: account.account_status,
        trial_ends_at: account.trial_ends_at,
        paket: {
          code: PAKET_INVENTARIS.code,
          name: PAKET_INVENTARIS.name,
          price_monthly: PAKET_INVENTARIS.price_monthly,
        },
      },
    );
  }
}

/**
 * Guard global siklus akun. Async karena harus memuat baris toko; error
 * diteruskan ke `next` supaya (format `{error, code, details?}`) sama dengan
 * middleware lain.
 */
export const requireActiveAccount: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await loadAccount(req);
    guardAccountStatus(req);
    next();
  } catch (err) {
    next(err as Error);
  }
};