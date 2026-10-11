import { QueryTypes } from 'sequelize';
import { env } from '../config/env.js';
import { sequelize } from './sequelize.js';

/**
 * Verifikasi skema FINAL (penerus `verifyBaseline` dari `src/db/migrate.ts`).
 * Tidak membuat / mengubah / membatalkan apa pun — hanya membaca.
 *
 * Yang diperiksa (rencana MP-1.2):
 *  - 24 tabel final
 *  - 11 trigger penjaga (D3: trigger tetap di DB, bukan di aplikasi)
 *  - 5 sequence penomoran dokumen
 *  - 4 kolom entitlement di `store_profile` (+ CHECK status)
 *  - baris default `store_profile` id=1
 *
 * Jalankan: npm run db:check
 */

export const REQUIRED_TABLES = [
  'cash_sessions',
  'customer',
  'idempotency_keys',
  'operational_expenses',
  'order_book_items',
  'order_books',
  'payment_methods',
  'payments',
  'product',
  'product_category',
  'product_type',
  'refresh_tokens',
  'refund_items',
  'refunds',
  'sale_items',
  'sales',
  'stock_batches',
  'stock_movements',
  'stock_opname_items',
  'stock_opnames',
  'store_profile',
  'supplier_return_items',
  'supplier_returns',
  'user_account',
] as const;

export const REQUIRED_TRIGGERS = [
  'trg_batch_update_product_cost',
  'trg_payments_sync_status',
  'trg_payments_validate',
  'trg_sale_item_apply_movement',
  'trg_sale_item_guard',
  'trg_sale_item_validate',
  'trg_sales_no_delete',
  'trg_sales_void',
  'trg_sales_void_apply',
  'trg_stock_movement_apply',
  'trg_stock_movement_immutable',
] as const;

export const REQUIRED_SEQUENCES = [
  'sale_no_seq',
  'batch_code_seq',
  'opname_no_seq',
  'supplier_return_no_seq',
  'order_no_seq',
] as const;

/** Kolom gate subscription per modul (plan §D8). */
export const ENTITLEMENT_COLUMNS = ['modules', 'trial_ends_at', 'suspended_at', 'account_status'] as const;

export interface SchemaCheck {
  ok: boolean;
  missingTables: string[];
  missingTriggers: string[];
  missingSequences: string[];
  missingEntitlementColumns: string[];
  hasStoreRow: boolean;
}

export async function verifySchema(): Promise<SchemaCheck> {
  // CATATAN: kolom dibungkus alias `AS name`. Dialect postgres Sequelize punya
  // hack warisan: query yang TEPAKTS diawali "SELECT table_name FROM
  // information_schema.tables" otomatis di-return sebagai array nilai (bukan
  // objek) sehingga barisnya tidak bisa dibaca lewat `row.table_name`.
  const tables = (await sequelize.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    { bind: [REQUIRED_TABLES], type: QueryTypes.SELECT },
  )) as unknown as Array<{ name: string }>;

  const triggers = (await sequelize.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[])`,
    { bind: [REQUIRED_TRIGGERS], type: QueryTypes.SELECT },
  )) as unknown as Array<{ tgname: string }>;

  const sequences = (await sequelize.query<{ sequencename: string }>(
    `SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' AND sequencename = ANY($1::text[])`,
    { bind: [REQUIRED_SEQUENCES], type: QueryTypes.SELECT },
  )) as unknown as Array<{ sequencename: string }>;

  const entitlement = (await sequelize.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'store_profile'
        AND column_name = ANY($1::text[])`,
    { bind: [ENTITLEMENT_COLUMNS], type: QueryTypes.SELECT },
  )) as unknown as Array<{ column_name: string }>;

  const store = (await sequelize.query<{ id: number; account_status: string; trial_ends_at: Date | null }>(
    `SELECT id, account_status, trial_ends_at FROM public.store_profile WHERE id = 1`,
    { type: QueryTypes.SELECT },
  )) as unknown as Array<{ id: number; account_status: string; trial_ends_at: Date | null }>;

  const haveTables = new Set(tables.map((r) => r.name));
  const haveTriggers = new Set(triggers.map((r) => r.tgname));
  const haveSequences = new Set(sequences.map((r) => r.sequencename));
  const haveEntitlement = new Set(entitlement.map((r) => r.column_name));

  const missingTables = REQUIRED_TABLES.filter((x) => !haveTables.has(x));
  const missingTriggers = REQUIRED_TRIGGERS.filter((x) => !haveTriggers.has(x));
  const missingSequences = REQUIRED_SEQUENCES.filter((x) => !haveSequences.has(x));
  const missingEntitlementColumns = ENTITLEMENT_COLUMNS.filter((x) => !haveEntitlement.has(x));
  const hasStoreRow = store.length > 0;

  return {
    ok:
      missingTables.length === 0 &&
      missingTriggers.length === 0 &&
      missingSequences.length === 0 &&
      missingEntitlementColumns.length === 0 &&
      hasStoreRow,
    missingTables,
    missingTriggers,
    missingSequences,
    missingEntitlementColumns,
    hasStoreRow,
  };
}

interface ConnectionInfo {
  server_version: string;
  db_name: string;
  db_user: string;
  db_now: Date;
  db_tz: string;
}

async function main(): Promise<void> {
  const [info] = (await sequelize.query<ConnectionInfo>(
    `SELECT current_setting('server_version') AS server_version,
            current_database()               AS db_name,
            current_user                     AS db_user,
            now()                            AS db_now,
            current_setting('TimeZone')      AS db_tz`,
    { type: QueryTypes.SELECT },
  )) as unknown as ConnectionInfo[];

  console.log('── koneksi DB ──');
  console.log(`  host      : ${env.db.host}:${env.db.port}`);
  console.log(`  database  : ${info?.db_name} (user ${info?.db_user})`);
  console.log(`  version   : ${info?.server_version}`);
  console.log(`  db now()  : ${info?.db_now.toISOString()}   [waktu server = sumber kebenaran]`);
  console.log(`  timezone  : ${info?.db_tz}`);

  const check = await verifySchema();
  console.log('── skema (hasil db:migrate) ──');
  console.log(`  tabel     : ${REQUIRED_TABLES.length - check.missingTables.length}/${REQUIRED_TABLES.length}`);
  console.log(`  trigger   : ${REQUIRED_TRIGGERS.length - check.missingTriggers.length}/${REQUIRED_TRIGGERS.length}`);
  console.log(`  sequence  : ${REQUIRED_SEQUENCES.length - check.missingSequences.length}/${REQUIRED_SEQUENCES.length}`);
  console.log(
    `  entitlement: ${ENTITLEMENT_COLUMNS.length - check.missingEntitlementColumns.length}/${ENTITLEMENT_COLUMNS.length} kolom store_profile`,
  );
  console.log(`  store_profile id=1: ${check.hasStoreRow ? 'ada' : 'HILANG'}`);

  if (!check.ok) {
    if (check.missingTables.length > 0) console.log(`  TABEL HILANG    : [${check.missingTables.join(', ')}]`);
    if (check.missingTriggers.length > 0) console.log(`  TRIGGER HILANG   : [${check.missingTriggers.join(', ')}]`);
    if (check.missingSequences.length > 0) console.log(`  SEQUENCE HILANG  : [${check.missingSequences.join(', ')}]`);
    if (check.missingEntitlementColumns.length > 0) {
      console.log(`  KOLOM HILANG     : [${check.missingEntitlementColumns.join(', ')}]`);
    }
    if (!check.hasStoreRow) console.log('  BARIS store_profile id=1 HILANG');
    process.exitCode = 1;
  } else {
    console.log('  OK: skema final + trigger penjaga + entitlement LENGKAP');
  }

  const counts = (await sequelize.query<{ label: string; n: number }>(
    `SELECT 'product' AS label, count(*)::int AS n FROM product
     UNION ALL SELECT 'stock_batches', count(*)::int FROM stock_batches
     UNION ALL SELECT 'sales', count(*)::int FROM sales
     UNION ALL SELECT 'payments', count(*)::int FROM payments
     UNION ALL SELECT 'user_account', count(*)::int FROM user_account
     UNION ALL SELECT 'payment_methods', count(*)::int FROM payment_methods
     UNION ALL SELECT 'idempotency_keys', count(*)::int FROM idempotency_keys`,
    { type: QueryTypes.SELECT },
  )) as unknown as Array<{ label: string; n: number }>;
  console.log('── isi tabel ──');
  for (const c of counts) console.log(`  ${c.label.padEnd(16)}: ${c.n}`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('GAGAL:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => sequelize.close());
}