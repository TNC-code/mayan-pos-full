/**
 * Bentuk nilai tanggal di response API.
 *
 * Kolom `date` (dan timestamptz) pada jalur raw SQL lama dibaca driver `pg`
 * sebagai objek `Date` (`parseDate` = `Date.UTC` dari komponen tanggal), jadi
 * JSON yang selama ini diterima `fe/` berbentuk:
 *
 *   "2026-12-31" -> "2026-12-31T00:00:00.000Z"
 *
 * Model Sequelize memakai `DATEONLY` (tulis: string `YYYY-MM-DD` apa adanya,
 * bebas dari konversi zona waktu server) dan membacanya kembali sebagai string.
 * Agar bentuk wire TIDAK bergeser saat migrasi MP-3, helper ini mengubahnya
 * ke format yang sama dengan jalur lama. received_at/created_at (timestamptz)
 * sudah `Date` di kedua jalur dan langsung dipakai `toJSON()`.
 */
export function isoDateOnly(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return `${value}T00:00:00.000Z`;
}