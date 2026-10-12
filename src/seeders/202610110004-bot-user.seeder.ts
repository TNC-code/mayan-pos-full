import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Op, QueryTypes } from 'sequelize';
import { env } from '../config/env.js';
import { UserAccount, sequelize } from '../models/index.js';
import type { Migration } from '../db/migrator.js';

/**
 * Akun sistem `bot` untuk order book WhatsApp (MP-7) — ganti `ensureBotUser()` yang
 * sebelumnya hidup di `src/db/migrate.ts` raw (retired di MP-9).
 *
 * Kontrak yang TIDAK boleh diubah:
 *  - `is_active = false`: bot TIDAK pernah login. Order dari internal key tidak
 *    butuh sesi kasir, `created_by` order cukup menunjuk user ini supaya audit
 *    tetap punya pelaku (`created_by_name = 'bot'` di response order book).
 *  - Password = hash bcrypt dari 36 byte acak -> 48 karakter base64url, dibuat
 *    SEKALI dan tidak pernah dicatat di mana pun (tidak ada di .env, log, atau
 *    repo) -> tidak ada yang bisa login sebagai bot.
 *  - Idempotent: `user_account` tidak punya UNIQUE(username) (sama seperti seed
 *    user biasa), jadi pola `WHERE NOT EXISTS` dipakai supaya hash tidak di-regenerasi
 *    pada setiap `npm run db:seed` dan barisnya tidak menggandakan.
 */
export const up: Migration['up'] = async () => {
  const existing = await UserAccount.findOne({
    where: { username: { [Op.iLike]: 'bot' } },
    order: [['id', 'ASC']],
  });
  if (existing) {
    console.log(`[seed] user bot      : sudah ada id=${existing.id} (is_active=${existing.is_active})`);
    return;
  }

  // 36 byte -> 48 karakter base64url; hanya dipakai sekali (tidak pernah ditampilkan).
  const randomPassword = randomBytes(36).toString('base64url');
  const hash = await bcrypt.hash(randomPassword, env.bcryptRounds);

  // Satu statement: `WHERE NOT EXISTS` menutup balapan dengan proses db:seed lain
  // (kalau barisnya sudah dibuat proses lain, `created: false` -> ambil id yang ada).
  const [claimed, created] = await UserAccount.findCreateFind({
    where: { username: { [Op.iLike]: 'bot' } },
    defaults: {
      username: 'bot',
      password: hash,
      full_name: 'Bot Order WhatsApp',
      phone: null,
      is_active: false,
      role: 'KASIR',
    },
  });

  if (created) {
    console.log(`[seed] user bot      : dibuat id=${claimed.id} (is_active=false, password acak tidak dicatat)`);
    return;
  }

  // Balapan: baris bot dibuat proses lain dalam microwindow yang sama.
  const again = (await sequelize.query(
    `SELECT id FROM public.user_account WHERE lower(username) = 'bot' ORDER BY id LIMIT 1`,
    { type: QueryTypes.SELECT },
  )) as unknown as Array<{ id: number }>;
  console.log(`[seed] user bot      : dibuat paralel oleh proses lain id=${again[0]?.id ?? '?'}`);
};

export const down: Migration['down'] = async () => {
  // Akun sistem tidak dihapus: `down` hanya memastikan tetap nonaktif.
  await UserAccount.update({ is_active: false }, { where: { username: { [Op.iLike]: 'bot' } } });
};