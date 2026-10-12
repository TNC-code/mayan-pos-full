import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../utils/errors.js';
import {
  MODULE_CODES,
  isModuleActive,
  moduleUpsellDetails,
  todayInBusinessTz,
  type ModuleCode,
} from '../services/modules.js';
import { guardAccountStatus, loadAccount } from './account.js';

/**
 * Lapis gate #2 — entitlement modul (MP-8; plan-subscription-tiering.md §3 & §7).
 *
 * `requireModule('reports')` -> 403 `MODULE_NOT_ACTIVE` +
 * `details {module, name, description, price_monthly}` yang dipakai FE untuk
 * halaman upsell modul (ikon gembok di nav, CTA "Aktifkan via WhatsApp").
 *
 * Modul aktif bila `store_profile.modules[code].valid_until >= hari ini`
 * (zona `env.businessTz`). Modul yang tak ada di jsonb = belum dibeli = terkunci.
 * Data yang sudah pernah ada TIDAK hilang saat modul terkunci (plan §5).
 *
 * URUTAN WAJIB (plan §7): trial/akun (`requireActiveAccount`) -> modul -> role RBAC.
 * Jadi di router modul ini selalu ditulis SEBELUM `KASIR`/`OWNER`.
 *
 * Bisa dipasang di jalur pra-auth: `loadAccount` hanya membaca `store_profile`
 * (bukan user), jadi `X-Internal-Key` pun tetap bisa kena gate modul. Konsekuensinya
 * middleware ini juga memanggil `guardAccountStatus` (gate trial/expired/suspend) —
 * dua route pra-auth lolos dari `requireActiveAccount` global, jadi tanpa itu
 * SUSPENDED masih bisa baca katalog dan EXPIRED masih bisa mutasi order book.
 */

const KNOWN_CODES = new Set<string>(MODULE_CODES);

/**
 * Varian >1 kode berarti "boleh salah satu aktif" (siap dipakai kalau suatu saat
 * satu endpoint dilayani beberapa modul; kasus umum tetap satu kode).
 */
export function requireModule(...codes: ModuleCode[]): RequestHandler {
  const list = codes.length > 0 ? codes : (['reports'] as ModuleCode[]);

  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        // Penjaga pemrograman: kode di luar katalog = konfigurasi salah, bukan
        // keputusan tenant — jawab 500 supaya tidak disalahartikan sebagai "modul habis".
        if (!list.every((code) => KNOWN_CODES.has(code))) {
          next(new ApiError('INTERNAL_ERROR', `Kode modul tidak dikenal: ${list.join(', ')}`));
          return;
        }

        const account = await loadAccount(req);

        // Gate status akun ikut dipasang di sini (bukan hanya di middleware
        // global): dua route pra-auth — `POST /order-books` (X-Internal-Key) dan
        // `GET /internal/catalog` — didaftarkan SEBELUM `r.use(requireActiveAccount)`,
        // jadi tanpa baris ini akun SUSPENDED masih bisa baca katalog & akun EXPIRED
        // masih bisa mutasi order book lewat bot WA. `loadAccount` cache di
        // `req.account`, jadi pemanggilan kedua ini tanpa query tambahan.
        // `catch` di bawah meneruskan ApiError-nya ke `next` (403 AKUN_SUSPENDED /
        // TRIAL_EXPIRED) dengan bentuk `{error, code, details?}` yang sama.
        guardAccountStatus(req);

        const today = todayInBusinessTz();

        const activeCode = list.find((code) => isModuleActive(account.modules, code, today));
        if (activeCode) {
          next();
          return;
        }

        // Detail memakai kode pertama (kode utama endpoint) supaya FE tidak
        // perlu memilih halaman upsell mana yang ditampilkan.
        next(
          new ApiError(
            'MODULE_NOT_ACTIVE',
            `Modul ${list[0]} belum aktif. Aktifkan lewat WhatsApp untuk memakai fitur ini`,
            moduleUpsellDetails(list[0]!),
          ),
        );
      } catch (err) {
        next(err as Error);
      }
    })();
  };
}