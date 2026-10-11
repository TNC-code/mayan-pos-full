import { Sequelize } from 'sequelize';
import { types } from 'pg';
import { env } from '../config/env.js';

/**
 * KONEKSI ORM (pengganti `pg.Pool` untuk service yang sudah dipindah ke Sequelize).
 *
 * Sumber konfigurasi tetap `env.db` (src/config/env.ts TIDAK diubah), sehingga
 * host/port/database/user/password, ukuran pool, SSL, dan statement_timeout
 * identik dengan pool lama -> perilaku koneksi tidak berubah.
 *
 * Kontrak angka (penting, jangan dihapus):
 *  openapi.yaml mendeklarasikan uang/qty sebagai `type: number`, dan aplikasi lama
 *  (src/config/db.ts) memasang `types.setTypeParser` global supaya `numeric` dan
 *  `bigint` jadi NUMBER, bukan string. Sequelize v6 memasang parser sendiri per
 *  koneksi (DECIMAL -> string), jadi parser yang sama dipasang ulang di sini lewat
 *  `oidParserMap` connection manager. Hasilnya: response ORM identik dengan jalur
 *  raw SQL lama (angka), termasuk di laporan yang masih pakai `sequelize.query`.
 *  Nilai uang TIDAK pernah disimpan lewat ORM (selalu numeric(14,2)/(14,3) di DB),
 *  jadi akurasi tidak terganggu.
 */
const NUMERIC_OID = 1700;
const INT8_OID = 20;

const parseNumeric = (value: string): number | null =>
  value === null ? null : Number.parseFloat(value);
const parseInt8 = (value: string): number | null => (value === null ? null : Number.parseInt(value, 10));

// Berlaku untuk driver `pg` polos (mis. pool lama / script di luar Sequelize).
types.setTypeParser(NUMERIC_OID, parseNumeric);
types.setTypeParser(INT8_OID, parseInt8);

export const sequelize = new Sequelize(env.db.database, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: 'postgres',
  // Log SQL hanya di luar produksi (produksi = diam, sama seperti pool lama).
  logging: env.nodeEnv === 'production' ? false : (sql: string) => console.log(`[sql] ${sql}`),
  pool: {
    max: env.db.max,
    min: 0,
    idle: 30_000,
    acquire: 10_000,
    evict: 10_000,
  },
  dialectOptions: {
    ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
    statement_timeout: env.db.statementTimeout,
    application_name: 'pos-inventory-api-orm',
  },
  define: {
    underscored: true,
    freezeTableName: true,
  },
});

/**
 * Override parser per-oid milik Sequelize (dialect postgres mengoverride
 * `types.getTypeParser` setiap koneksi lewat `oidParserMap` connection manager).
 * Patch dipasang ulang di hook `afterConnect` karena pemuatan OID internal
 * Sequelize (sekali, saat koneksi pertama dibuat) menimpa ulang map itu.
 *
 * Kalau struktur internal berubah di versi Sequelize berikutnya, patch ini dilewati
 * dan angka kembali jadi string -> terlihat sebagai diff response API (kas, bukan
 * crash), jadi aman untuk gagal diam-diam.
 */
function patchNumericParsers(): void {
  const manager = sequelize.connectionManager as unknown as {
    oidParserMap?: Map<number, (value: string) => unknown>;
  };
  if (manager?.oidParserMap instanceof Map) {
    manager.oidParserMap.set(NUMERIC_OID, parseNumeric);
    manager.oidParserMap.set(INT8_OID, parseInt8);
  } else {
    console.warn('[db] parser numeric/int8 Sequelize tidak bisa di-override; angka mungkin jadi string');
  }
}
sequelize.addHook('afterConnect', () => patchNumericParsers());

/** Tutup koneksi ORM (dipanggil di shutdown server & akhir skrip db:*). */
export async function closeSequelize(): Promise<void> {
  await sequelize.close();
}