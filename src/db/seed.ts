import bcrypt from 'bcrypt';
import { closePool, pool } from '../config/db.js';
import { env } from '../config/env.js';

/**
 * Seed minimal (FASE 0): 2 user_account (owner + kasir) dengan password bcrypt,
 * plus pastikan payment_methods CASH / BANK_TRANSFER / QRIS ada.
 *
 * Catatan schema: `user_account` = (id, username, password, full_name, phone, is_active).
 * Tidak ada kolom `role` dan tidak ada UNIQUE(username) pada schema final, sehingga:
 *  - role dipetakan di layer aplikasi (src/config/env.ts -> OWNER_USERNAMES/KASIR_USERNAMES)
 *  - seeding idempotent dicek manual per username (upsert), bukan ON CONFLICT
 */
interface SeedUser {
  username: string;
  full_name: string;
  phone: string;
  password: string;
  role: 'OWNER' | 'KASIR';
}

const USERS: SeedUser[] = [
  { username: 'owner', full_name: 'Owner Toko', phone: '081200000000', password: env.seed.ownerPassword, role: 'OWNER' },
  { username: 'kasir1', full_name: 'Kasir Satu', phone: '081200000010', password: env.seed.kasirPassword, role: 'KASIR' },
];

const PAYMENT_METHODS: Array<{
  code: string;
  name: string;
  requires_reference: boolean;
  bank_name?: string;
  account_no?: string;
  account_name?: string;
  sort_order: number;
}> = [
  { code: 'CASH', name: 'Tunai', requires_reference: false, sort_order: 1 },
  {
    code: 'BANK_TRANSFER',
    name: 'Transfer Bank',
    requires_reference: true,
    bank_name: 'Bank',
    account_no: '0000000000',
    account_name: 'Owner',
    sort_order: 2,
  },
  { code: 'QRIS', name: 'QRIS', requires_reference: false, sort_order: 3 },
];

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const u of USERS) {
      const hash = await bcrypt.hash(u.password, env.bcryptRounds);
      const existing = await client.query<{ id: number }>(
        `SELECT id FROM user_account WHERE lower(username) = lower($1) ORDER BY id LIMIT 1`,
        [u.username],
      );

      if (existing.rows.length > 0) {
        const id = existing.rows[0]?.id;
        await client.query(
          `UPDATE user_account SET password = $2, full_name = $3, phone = $4, is_active = true, role = $5 WHERE id = $1`,
          [id, hash, u.full_name, u.phone, u.role],
        );
        console.log(`[seed] user di-reset: ${u.username.padEnd(7)} role=${u.role.padEnd(5)} id=${id}`);
      } else {
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO user_account (username, password, full_name, phone, is_active, role)
           VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
          [u.username, hash, u.full_name, u.phone, u.role],
        );
        console.log(`[seed] user dibuat   : ${u.username.padEnd(7)} role=${u.role.padEnd(5)} id=${rows[0]?.id}`);
      }
    }

    for (const m of PAYMENT_METHODS) {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO payment_methods
           (code, name, is_active, requires_reference, bank_name, account_no, account_name, sort_order, updated_at)
         VALUES ($1, $2, true, $3, $4, $5, $6, $7, now())
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [m.code, m.name, m.requires_reference, m.bank_name ?? null, m.account_no ?? null, m.account_name ?? null, m.sort_order],
      );
      console.log(`[seed] payment_method: ${rows.length > 0 ? 'dibuat' : 'sudah ada'} ${m.code}`);
    }

    await client.query('COMMIT');
    console.log(`[seed] login owner -> username=owner  password=${env.seed.ownerPassword}`);
    console.log(`[seed] login kasir -> username=kasir1 password=${env.seed.kasirPassword}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[seed] GAGAL:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await closePool();
  }
}

main();
