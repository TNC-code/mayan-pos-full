import { StoreProfile } from '../models/index.js';
import type { Migration } from '../db/migrator.js';
import { MODULE_CODES } from '../services/modules.js';

/** Masa trial default akun baru: 90 hari (plan §2 / plan-subscription-tiering.md). */
const TRIAL_DAYS = 90;

/**
 * Seed entitlement toko (single row id=1): `account_status='TRIAL'` +
 * `trial_ends_at = now() + 90 hari` dan **seluruh modul aktif sampai trial habis**
 * (`modules` = tiap kode katalog dengan `valid_until = trial_ends_at`) — sesuai
 * plan §2: "Trial: 90 hari, semua fitur aktif (Paket Inventaris + seluruh modul)".
 * Dengan begitu gate modul MP-8 tidak mengunci apa pun selama trial berjalan, dan
 * semuanya terkunci otomatis begitu trial habis (entitlement ikut kadaluwarsa
 * bersamaan dengan status akun EXPIRED).
 *
 * Idempotent & non-destruktif:
 *  - `trial_ends_at` yang sudah terisi TIDAK ditimpa (sisa trial tidak di-reset);
 *  - `modules` hanya diisi untuk kode yang HILANG — modul yang sudah purchased
 *    (ditulis platform/console) tidak diubah;
 *  - `account_status` hanya di-set ke TRIAL saat trial baru dibuat; status lain
 *    (EXPIRED/SUSPENDED hasil scheduler platform) tidak diubah oleh seeder.
 */
export const up: Migration['up'] = async () => {
  const store = await StoreProfile.findByPk(1);
  if (!store) {
    throw new Error('store_profile id=1 belum ada — jalankan `npm run db:migrate` dulu');
  }

  const allModulesFor = (trialEndsAt: Date): Record<string, { valid_until: string }> =>
    Object.fromEntries(MODULE_CODES.map((code) => [code, { valid_until: trialEndsAt.toISOString() }]));

  // Kasus 1: trial belum pernah dibuat -> buat 90 hari + semua modul.
  if (!store.trial_ends_at) {
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000);
    await store.update({
      account_status: 'TRIAL',
      trial_ends_at: trialEndsAt,
      modules: allModulesFor(trialEndsAt),
    });
    console.log(
      `[seed] store trial    : TRIAL ${TRIAL_DAYS} hari (sampai ${trialEndsAt.toISOString()}), ` +
        `${MODULE_CODES.length} modul aktif`,
    );
    return;
  }

  // Kasus 2: trial sudah jalan -> hanya lengkapi kode modul yang belum ada.
  const current = store.modules ?? {};
  const missing = MODULE_CODES.filter((code) => !current[code]);
  if (missing.length === 0) {
    console.log(
      `[seed] store trial    : sudah aktif (status=${store.account_status}, ` +
        `trial_ends_at=${store.trial_ends_at.toISOString()}, ${MODULE_CODES.length} modul terisi)`,
    );
    return;
  }

  const trialEndsAt = new Date(store.trial_ends_at);
  const filled = Object.fromEntries(missing.map((code) => [code, { valid_until: trialEndsAt.toISOString() }]));
  await store.update({ modules: { ...current, ...filled } });
  console.log(
    `[seed] store trial    : lengkapi modul ${missing.join(', ')} sampai ${trialEndsAt.toISOString()} ` +
      `(status tidak diubah: ${store.account_status})`,
  );
};

export const down: Migration['down'] = async () => {
  await StoreProfile.update(
    { account_status: 'TRIAL', trial_ends_at: null, modules: {} },
    { where: { id: 1 } },
  );
};