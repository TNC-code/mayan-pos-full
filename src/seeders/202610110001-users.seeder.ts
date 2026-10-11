import bcrypt from 'bcrypt';
import { Op } from 'sequelize';
import { env } from '../config/env.js';
import { UserAccount, type UserRole } from '../models/index.js';
import type { Migration } from '../db/migrator.js';

interface SeedUser {
  username: string;
  full_name: string;
  phone: string;
  password: string;
  role: UserRole;
}

/**
 * Seed user awal: `owner` (OWNER) + `kasir1` (KASIR), password dari .env
 * (SEED_OWNER_PASSWORD / SEED_KASIR_PASSWORD).
 *
 * Idempotent: `user_account` TIDAK punya UNIQUE(username) (sama seperti DB lama),
 * jadi tidak bisa pakai ON CONFLICT. Pola `WHERE NOT EXISTS` -> user yang sudah
 * ada di-reset (password/profil/role/is_active), tanpa menggandakan baris.
 */
const USERS: readonly SeedUser[] = [
  {
    username: 'owner',
    full_name: 'Owner Toko',
    phone: '081200000000',
    password: env.seed.ownerPassword,
    role: 'OWNER',
  },
  {
    username: 'kasir1',
    full_name: 'Kasir Satu',
    phone: '081200000010',
    password: env.seed.kasirPassword,
    role: 'KASIR',
  },
];

export const up: Migration['up'] = async () => {
  for (const u of USERS) {
    const hash = await bcrypt.hash(u.password, env.bcryptRounds);
    const [existing] = await UserAccount.findAll({
      where: { username: { [Op.iLike]: u.username } },
      order: [['id', 'ASC']],
      limit: 1,
    });

    if (existing) {
      await existing.update({
        password: hash,
        full_name: u.full_name,
        phone: u.phone,
        is_active: true,
        role: u.role,
      });
      console.log(`[seed] user di-reset : ${u.username.padEnd(7)} role=${u.role.padEnd(5)} id=${existing.id}`);
    } else {
      const created = await UserAccount.create({
        username: u.username,
        password: hash,
        full_name: u.full_name,
        phone: u.phone,
        is_active: true,
        role: u.role,
      });
      console.log(`[seed] user dibuat   : ${u.username.padEnd(7)} role=${u.role.padEnd(5)} id=${created.id}`);
    }
  }
};

export const down: Migration['down'] = async () => {
  // Seed user tidak dihapus: `down` berarti "reset password/profil saja".
  for (const u of USERS) {
    await UserAccount.update({ is_active: true }, { where: { username: u.username } });
  }
};