import path from 'node:path';
import { Sequelize } from 'sequelize';
import { SequelizeStorage, Umzug } from 'umzug';
import type { RunnableMigration } from 'umzug';
import { sequelize } from './sequelize.js';

/**
 * Runner migration (Umzug) - pengganti `npm run migrate` raw SQL lama
 * (plan §D2 & §D7).
 *
 * - Tabel log: `sequelize_meta` (dibuat sendiri oleh SequelizeStorage).
 * - Lokasi file: `src/migrations/*.ts` saat dev (tsx) dan `dist/migrations/*.js`
 *   saat produksi -> ekstensi diambil dari `__filename` supaya keduanya jalan.
 * - `sync()` DILARANG: skema hanya berubah lewat `npm run db:migrate`.
 * - Perintah: `up` (default) | `down` | `status`.
 *
 * Perintah CLI:
 *   npm run db:migrate         -> jalankan semua migration pending
 *   npm run db:migrate:undo    -> rollback 1 langkah
 *   npm run db:migrate:status  -> daftar applied/pending
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const MIGRATION_EXT = path.extname(__filename); // '.ts' (tsx dev) | '.js' (dist produksi)

type MigrationModule = {
  up?: RunnableMigration<Sequelize>['up'];
  down?: RunnableMigration<Sequelize>['down'];
};

/**
 * Resolver custom (setara default resolver umzug, tapi tanpa ekstensi di nama).
 *
 * Default resolver umzug memakai nama file apa adanya sebagai identitas
 * migration, sehingga file yang sama punya 2 nama ('....ts' saat dev via tsx,
 * '....js' saat produksi dari `dist/`) dan `sequelize_meta` menganggapnya
 * migration yang belum jalan begitu aplikasi dijalankan dari `dist/`.
 * Nama dilepas ekstensinya supaya identitasnya sama di dev & produksi.
 *
 * Resolver WAJIB sinkron (umzug tidak menunggu promise), jadi modul dimuat lewat
 * `require`: output build adalah CommonJS, dan di dev tsx memasang hook
 * `require` untuk berkas `.ts`.
 */
function resolveMigration({ name, path: filepath }: { name: string; path?: string }): RunnableMigration<Sequelize> {
  if (!filepath) throw new Error(`Migration tanpa path: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(filepath) as MigrationModule;
  if (typeof loaded.up !== 'function') throw new Error(`Migration ${name} tidak mengekspor fungsi up()`);
  return {
    name: name.slice(0, -path.extname(name).length),
    path: filepath,
    up: loaded.up,
    down: loaded.down,
  };
}

export const migrator = new Umzug<Sequelize>({
  migrations: {
    glob: path.join(MIGRATIONS_DIR, `*${MIGRATION_EXT}`),
    resolve: resolveMigration,
  },
  context: sequelize,
  storage: new SequelizeStorage({ sequelize, tableName: 'sequelize_meta' }),
  logger: console,
});

/** Tipe konteks migration: instance Sequelize (bukan QueryInterface). */
export type MigrationContext = Sequelize;

/** Bentuk file migration: helper di `src/db/migrator.ts` akan memanggil `up`/`down` di dalamnya. */
export type Migration = RunnableMigration<MigrationContext>;

const COMMANDS = ['up', 'down', 'status'] as const;
type Command = (typeof COMMANDS)[number];

function parseCommand(argv: string[]): Command {
  const raw = (argv[0] ?? 'up').toLowerCase();
  if ((COMMANDS as readonly string[]).includes(raw)) return raw as Command;
  throw new Error(`Perintah tidak dikenal: "${raw}". Pilihan: ${COMMANDS.join(', ')}`);
}

/** Jalankan migration sesuai perintah; dipakai juga oleh npn script & CI. */
export async function run(command: Command): Promise<void> {
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(
        applied.length === 0
          ? '[migrate] tidak ada migration pending (skema sudah final)'
          : `[migrate] ${applied.length} migration dijalankan: ${applied.map((m) => m.name).join(', ')}`,
      );
      return;
    }
    case 'down': {
      const reverted = await migrator.down();
      console.log(
        reverted.length === 0
          ? '[migrate] tidak ada migration untuk di-rollback'
          : `[migrate] rollback: ${reverted.map((m) => m.name).join(', ')}`,
      );
      return;
    }
    case 'status': {
      const executed = await migrator.executed();
      const pending = await migrator.pending();
      console.log('── migration applied ──');
      if (executed.length === 0) console.log('  (belum ada)');
      for (const m of executed) console.log(`  [x] ${m.name}`);
      console.log('── migration pending ──');
      if (pending.length === 0) console.log('  (tidak ada)');
      for (const m of pending) console.log(`  [ ] ${m.name}`);
      return;
    }
  }
}

async function main(): Promise<void> {
  try {
    await run(parseCommand(process.argv.slice(2)));
  } catch (err) {
    console.error('[migrate] GAGAL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  void main();
}