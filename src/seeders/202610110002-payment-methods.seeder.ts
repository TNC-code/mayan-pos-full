import { PaymentMethod } from '../models/index.js';
import type { Migration } from '../db/migrator.js';

/**
 * Metode pembayaran bawaan: CASH / BANK_TRANSFER (wajib `reference_no`) / QRIS.
 * Idempotent lewat `findOrCreate` pada `code` (UNIQUE di DB) — kalau sudah ada
 * datanya TIDAK ditimpa, persis seperti `ON CONFLICT DO NOTHING` di seed lama.
 */
const PAYMENT_METHODS = [
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
] as const;

export const up: Migration['up'] = async () => {
  for (const m of PAYMENT_METHODS) {
    const [, created] = await PaymentMethod.scope('withInactive').findOrCreate({
      where: { code: m.code },
      defaults: {
        code: m.code,
        name: m.name,
        is_active: true,
        requires_reference: m.requires_reference,
        bank_name: 'bank_name' in m ? m.bank_name : null,
        account_no: 'account_no' in m ? m.account_no : null,
        account_name: 'account_name' in m ? m.account_name : null,
        sort_order: m.sort_order,
      },
    });
    console.log(`[seed] payment_method: ${created ? 'dibuat  ' : 'sudah ada'} ${m.code}`);
  }
};