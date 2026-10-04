import { closePool, query, queryOne } from '../config/db.js';
import { env } from '../config/env.js';
import { verifyBaseline } from './migrate.js';

/**
 * Pengecek koneksi +baseline (FASE 0). Tidak mengubah data apa pun.
 * Jalankan: npm run db:check
 */
async function main(): Promise<void> {
  const res = await queryOne<{ server_version: string; db_name: string; db_user: string; db_now: Date; db_tz: string }>(
    `SELECT current_setting('server_version') AS server_version,
            current_database()             AS db_name,
            current_user                   AS db_user,
            now()                          AS db_now,
            current_setting('TimeZone')    AS db_tz`,
  );

  console.log('── koneksi DB ──');
  console.log(`  host      : ${env.db.host}:${env.db.port}`);
  console.log(`  database  : ${res?.db_name} (user ${res?.db_user})`);
  console.log(`  version   : ${res?.server_version}`);
  console.log(`  db now()  : ${res?.db_now.toISOString()}   [waktu server = sumber kebenaran]`);
  console.log(`  timezone  : ${res?.db_tz}`);

  const baseline = await verifyBaseline();
  console.log('── baseline ──');
  if (baseline.ok) {
    console.log('  schema final + trigger penjaga: LENGKAP');
  } else {
    console.log(`  TIDAK LENGKAP. Tabel hilang: [${baseline.missingTables}] Trigger hilang: [${baseline.missingTriggers}]`);
    process.exitCode = 1;
  }

  const counts = await query<{ label: string; n: number }>(`
    SELECT 'product' AS label, count(*)::int AS n FROM product
    UNION ALL SELECT 'stock_batches', count(*)::int FROM stock_batches
    UNION ALL SELECT 'sales', count(*)::int FROM sales
    UNION ALL SELECT 'payments', count(*)::int FROM payments
    UNION ALL SELECT 'user_account', count(*)::int FROM user_account
    UNION ALL SELECT 'payment_methods', count(*)::int FROM payment_methods
  `);
  console.log('── isi tabel ──');
  for (const c of counts) console.log(`  ${c.label.padEnd(16)}: ${c.n}`);

  const idem = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM idempotency_keys`);
  console.log(`  idempotency_keys${' '.repeat(2)}: ${idem?.n ?? 0} (dibuat oleh npm run migrate)`);
}

main()
  .catch((err) => {
    console.error('GAGAL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
