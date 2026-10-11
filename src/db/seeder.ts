import path from 'node:path';
import { Sequelize } from 'sequelize';
import { Umzug, memoryStorage } from 'umzug';
import { sequelize } from './sequelize.js';

/**
 * Runner seeders (Umzug) - pengganti `npm run seed` raw SQL lama.
 *
 * Berbeda dari migrator: seeder TIDAK memakai tabel log. `npm run db:seed`
 * selalu menjalankan seluruh seeder ("up all") dan idempotensi dijamin oleh
 * guard di dalam masing-masing seeder (mis. `WHERE NOT EXISTS` untuk user yang
 * tidak punya UNIQUE(username), `ON CONFLICT DO NOTHING` untuk payment method).
 * Jadi aman mengulang `npm run db:seed` aman & tidak menggandakan data.
 *
 * Lokasi file: `src/seeders/*.ts` (dev/tsx) atau `dist/seeders/*.js` (produksi).
 */
const SEEDERS_DIR = path.resolve(__dirname, '..', 'seeders');
const SEEDER_EXT = path.extname(__filename);

export const seeder = new Umzug<Sequelize>({
  migrations: { glob: path.join(SEEDERS_DIR, `*${SEEDER_EXT}`) },
  context: sequelize,
  // Sengaja tanpa storage persisten: seluruh seeder dieksekusi setiap kali
  // dan ke-idempotent-an dijaga di dalam file seeder.
  storage: memoryStorage(),
  logger: console,
});

async function main(): Promise<void> {
  try {
    const applied = await seeder.up();
    console.log(`[seed] ${applied.length} seeder selesai: ${applied.map((m) => m.name).join(', ')}`);
  } catch (err) {
    console.error('[seed] GAGAL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  void main();
}