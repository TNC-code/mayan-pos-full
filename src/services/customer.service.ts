import { Op } from 'sequelize';
import { ApiError, notFound } from '../utils/errors.js';
import { mapOrmError } from '../utils/orm-errors.js';
import { Customer } from '../models/index.js';

/**
 * Customer di atas Sequelize (MP-2).
 *
 * Paritas dengan versi raw SQL lama (`git show HEAD~1:src/services/customer.service.ts`):
 *  - list: filter `q` ILIKE atas `name`/`phone`/`owner_name`, urutan `name ASC`,
 *    `limit`/`offset` (default dari zod: 50/0);
 *  - create: kolom kosong -> NULL;
 *  - patch kosong -> `VALIDATION_ERROR` "Tidak ada kolom yang akan diubah";
 *  - id tak ada -> `NOT_FOUND` 404 ("Customer id=… tidak ditemukan").
 *
 * Customer opsional untuk walk-in (FASE 1): tidak ada `is_active`, jadi daftar
 * tidak pernah disaring.
 */

export interface CustomerRow {
  id: number;
  name: string | null;
  address: string | null;
  phone: string | null;
  owner_name: string | null;
}

export interface CustomerListQuery {
  q?: string;
  limit: number;
  offset: number;
}

function toCustomerRow(row: Customer): CustomerRow {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    phone: row.phone,
    owner_name: row.owner_name,
  };
}

export async function listCustomers(q: CustomerListQuery): Promise<CustomerRow[]> {
  const rows = await Customer.findAll({
    where: q.q
      ? {
          [Op.or]: [
            { name: { [Op.iLike]: `%${q.q}%` } },
            { phone: { [Op.iLike]: `%${q.q}%` } },
            { owner_name: { [Op.iLike]: `%${q.q}%` } },
          ],
        }
      : undefined,
    order: [['name', 'ASC']],
    limit: q.limit,
    offset: q.offset,
  });
  return rows.map(toCustomerRow);
}

export interface CustomerInput {
  name: string;
  address?: string | null;
  phone?: string | null;
  owner_name?: string | null;
}

export async function createCustomer(input: CustomerInput): Promise<CustomerRow> {
  try {
    const created = await Customer.create({
      name: input.name,
      address: input.address ?? null,
      phone: input.phone ?? null,
      owner_name: input.owner_name ?? null,
    });
    return toCustomerRow(created);
  } catch (err) {
    throw mapOrmError(err);
  }
}

export async function getCustomer(id: number): Promise<CustomerRow> {
  const row = await Customer.findByPk(id);
  if (!row) throw notFound(`Customer id=${id} tidak ditemukan`);
  return toCustomerRow(row);
}

/** Patch semantics: hanya kolom yang dikirim yang diubah. */
export async function updateCustomer(id: number, patch: Partial<CustomerInput>): Promise<CustomerRow> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.address !== undefined) values.address = patch.address;
  if (patch.phone !== undefined) values.phone = patch.phone;
  if (patch.owner_name !== undefined) values.owner_name = patch.owner_name;

  if (Object.keys(values).length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Tidak ada kolom yang akan diubah');
  }

  const row = await Customer.findByPk(id);
  if (!row) throw notFound(`Customer id=${id} tidak ditemukan`);
  await row.update(values);
  return toCustomerRow(row);
}
