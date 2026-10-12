import { env } from '../config/env.js';
import type { AccountStatus, ModuleEntitlement, StoreModules } from '../models/store-profile.model.js';

/**
 * Katalog modul subscription (MP-8) — spec: `plan-subscription-tiering.md` §2 & §3.
 *
 * MODEL: tidak ada tier berjenjang. Satu "paket inti" (Paket Inventaris, selalu
 * ikut saat aktif) + modul à la carte. Trial 3 bulan = semua modul aktif
 * (saya seeder trial yang menulis `valid_until = trial_ends_at` untuk setiap kode).
 *
 * SUMBER KEBENARAN entitlement = kolom `store_profile.modules` jsonb di tenant DB
 * (ditulis platform/console nanti, dibaca API tenant ini). Modul aktif bila
 * `valid_until >= hari ini` pada zona waktu bisnis (`env.businessTz`).
 *
 * Catatan_gate: `isModuleActive` SENGAJA murni entitlement — tidak ada bypass
 * "TRIAL buka semua". Sisa trial dilindungi karena `valid_until` modul trial
 * disamakan dengan `trial_ends_at`, jadi saat trial habis semua modul ikut terkunci
 * bersamaan dengan status akun yang berubah EXPIRED (grace read-only).
 */

export const MODULE_CODES = [
  'reports',
  'shift',
  'wa_order',
  'retur',
  'outlet',
  'api',
  'history',
] as const;

export type ModuleCode = (typeof MODULE_CODES)[number];

export interface ModuleMeta {
  /** Nama tampilan untuk FE (judul menu terkunci & halaman upsell). */
  name: string;
  description: string;
  /** Harga usulan per bulan (final ditentukan owner di console). */
  price_monthly: number;
}

export const MODULES_META: Record<ModuleCode, ModuleMeta> = {
  reports: {
    name: 'Laporan',
    description: 'P&L, laporan penjualan per produk + rata-rata/hari, filter bulan lampau, export CSV',
    price_monthly: 35000,
  },
  shift: {
    name: 'Multi-kasir & Shift',
    description: 'Kasir lebih dari satu, buka/tutup shift + selisih kas',
    price_monthly: 25000,
  },
  wa_order: {
    name: 'WA Bot & Order Book',
    description: 'Asisten kasir WhatsApp (AI order parser) + layar Order WA',
    price_monthly: 75000,
  },
  retur: {
    name: 'Retur Distributor',
    description: 'Retur stok rusak ke supplier + settle dana',
    price_monthly: 25000,
  },
  outlet: {
    name: 'Multi-outlet',
    description: 'Cabang + konsolidasi laporan antar outlet',
    price_monthly: 99000,
  },
  api: {
    name: 'API Access',
    description: 'Integrasi pihak ketiga (token API)',
    price_monthly: 149000,
  },
  history: {
    name: 'Riwayat Luas',
    description: 'Riwayat lebih dari 12 bulan (tanpa batas)',
    price_monthly: 19000,
  },
};

/**
 * Paket minimal (paket inti): master data + POS penuh + barang masuk + kasbon/
 * piutang + void/refund + stok ledger/alert + opname + 1 kasir + riwayat bulan
 * berjalan. TIDAK digate sebagai modul (menurut plan §2) — karena itu semua
 * endpoint inti tetap terbuka begitu akun tidak SUSPENDED/EXPIRED.
 */
export const PAKET_INVENTARIS = {
  code: 'inventaris',
  name: 'Paket Inventaris',
  price_monthly: 49000,
} as const;

const MS_PER_DAY = 86_400_000;

/** `true` bila `value` adalah tanggal kalender (YYYY-MM-DD) atau ISO ber-waktu. */
function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Tanggal kalender (YYYY-MM-DD) sebuah nilai `valid_until` pada zona waktu bisnis.
 * Nilai bisa date-only ("2026-12-05") maupun timestamptz ISO (dilewatkan dari DB
 * sebagai timestamptz); yang kedua dikonversi ke zona bisnis supaya perbandingan
 * "sampai tanggal berapa" sama dengan cara orang membaca kalender.
 */
function toBusinessDate(value: string, tz: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (isDateOnly(raw)) return raw;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  // en-CA memberi format YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ts),
  );
}

/** Hari ini pada zona waktu bisnis aplikasi (`BUSINESS_TZ`, default Asia/Jakarta). */
export function todayInBusinessTz(tz: string = env.businessTz): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

/**
 * Modul aktif bila entitlement-nya ada DAN `valid_until >= today` (zonanya
 * `tz`). Modul yang tidak ada di jsonb (belum dibeli / sudah dilepas) = tidak aktif.
 */
export function isModuleActive(
  modules: StoreModules | null | undefined,
  code: ModuleCode,
  today: string = todayInBusinessTz(),
  tz: string = env.businessTz,
): boolean {
  const entitlement = modules?.[code] as ModuleEntitlement | undefined;
  if (!entitlement) return false;
  const validUntil = entitlement.valid_until;
  if (!validUntil) return false;
  const date = toBusinessDate(String(validUntil), tz);
  if (!date) return false;
  // Perbandingan string aman: format YYYY-MM-DD zero-padded & berurutan kronologis.
  return date >= today;
}

export interface ModuleSummaryEntry {
  /** Tanggal aktif terakhir modul (YYYY-MM-DD atau ISO, apa adanya dari DB). */
  valid_until: string | null;
  /** Turunan dari `valid_until` vs hari ini — dipakai FE untuk ikon gembok/upsell. */
  active: boolean;
}

/**
 * Ringkasan entitlement untuk `/auth/me`: hanya kode yang dikenal di katalog
 * (entitlement tak dikenal diabaikan agar data platform tak bisa membocorkan
 * field liar ke FE), masing-masing `{ valid_until, active }`.
 */
export function moduleSummary(
  modules: StoreModules | null | undefined,
  today: string = todayInBusinessTz(),
  tz: string = env.businessTz,
): Record<string, ModuleSummaryEntry> {
  const out: Record<string, ModuleSummaryEntry> = {};
  for (const code of MODULE_CODES) {
    const raw = modules?.[code]?.valid_until;
    out[code] = {
      valid_until: raw ? String(raw) : null,
      active: isModuleActive(modules, code, today, tz),
    };
  }
  return out;
}

export interface SubscriptionPayload {
  modules: Record<string, ModuleSummaryEntry>;
  account: {
    status: AccountStatus;
    trial_ends_at: string | null;
    /** Sisa trial dalam hari (null bila bukan TRIAL / `trial_ends_at` kosong). */
    trial_days_left: number | null;
  };
  hosting_mode: 'shared';
}

/**
 * Payload additive untuk `GET /auth/me` (plan §7): bentuk `user` TIDAK berubah,
 * FE lama aman. `hosting_mode` selalu `'shared'` — mode dedikasi (hosting paket
 * Business/Enterprise) belum ada di tenant API ini.
 */
export function subscriptionPayload(
  modules: StoreModules | null | undefined,
  accountStatus: AccountStatus,
  trialEndsAt: Date | string | null,
  now: Date = new Date(),
): SubscriptionPayload {
  const trialIso = trialEndsAt ? new Date(trialEndsAt).toISOString() : null;
  const trialDaysLeft =
    accountStatus === 'TRIAL' && trialEndsAt
      ? Math.ceil((new Date(trialEndsAt).getTime() - now.getTime()) / MS_PER_DAY)
      : null;
  return {
    modules: moduleSummary(modules),
    account: { status: accountStatus, trial_ends_at: trialIso, trial_days_left: trialDaysLeft },
    hosting_mode: 'shared',
  };
}

/** Detail error 403 `MODULE_NOT_ACTIVE` (dipakai FE untuk halaman upsell). */
export function moduleUpsellDetails(code: ModuleCode): {
  module: ModuleCode;
  name: string;
  description: string;
  price_monthly: number;
} {
  const meta = MODULES_META[code];
  return { module: code, name: meta.name, description: meta.description, price_monthly: meta.price_monthly };
}