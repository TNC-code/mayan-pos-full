import { Op } from 'sequelize';
import { StoreProfile } from '../models/index.js';
import type { Migration } from '../db/migrator.js';

/** Masa trial default akun baru: 90 hari (plan §D8 / plan-subscription-tiering.md). */
const TRIAL_DAYS = 90;

/**
 * Seed entitlement toko (single row id=1): `account_status='TRIAL'` +
 * `trial_ends_at = now() + 90 hari`, `modules='{}'`.
 *
 * Idempotent dan TIDAK merusak trial yang sedang berjalan: kalau `trial_ends_at`
 * sudah terisi, nilai lama dipertahankan. Gate subscription per modul dipasang
 * di MP-8; seed ini yang memastikan dev selalu punya trial aktif.
 */
export const up: Migration['up'] = async () => {
  const store = await StoreProfile.findByPk(1);
  if (!store) {
    throw new Error('store_profile id=1 belum ada — jalankan `npm run db:migrate` dulu');
  }

  if (store.trial_ends_at) {
    console.log(
      `[seed] store trial    : sudah aktif (status=${store.account_status}, trial_ends_at=${store.trial_ends_at.toISOString()})`,
    );
    return;
  }

  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000);
  await store.update({ account_status: 'TRIAL', trial_ends_at: trialEndsAt });
  console.log(`[seed] store trial    : TRIAL ${TRIAL_DAYS} hari (sampai ${trialEndsAt.toISOString()})`);
};

export const down: Migration['down'] = async () => {
  await StoreProfile.update(
    { account_status: 'TRIAL', trial_ends_at: null },
    { where: { account_status: { [Op.ne]: 'TRIAL' } } },
  );
};