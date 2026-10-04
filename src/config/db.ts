import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { env } from './env.js';

// numeric/decimal dikirim sebagai string oleh pg secara default agar presisi tidak hilang.
// Di API kita selalu mau number (qty 3 desimal, uang 2 desimal) -> parse di sini.
const NUMERIC_OID = 1700;
const INT8_OID = 20;

types.setTypeParser(NUMERIC_OID, (v) => (v === null ? null : Number.parseFloat(v)));
types.setTypeParser(INT8_OID, (v) => (v === null ? null : Number.parseInt(v, 10)));

export const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.database,
  user: env.db.user,
  password: env.db.password,
  max: env.db.max,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: env.db.statementTimeout,
  application_name: 'pos-inventory-api',
  ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] error pada koneksi idle pool:', err.message);
});

export type Db = Pick<PoolClient, 'query'>;

/**
 * Jalankan `fn` di dalam satu transaksi DB (ACID).
 * Rollback total bila fn melempar error -> stok/tagihan tetap konsisten.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* koneksi sudah putus - tidak ada transaksi aktif untuk di-rollback */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
