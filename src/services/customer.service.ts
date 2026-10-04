import { pool } from '../config/db.js';
import { ApiError, notFound } from '../utils/errors.js';

export interface CustomerRow {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  owner_name: string | null;
}

export interface CustomerListQuery {
  q?: string;
  limit: number;
  offset: number;
}

/** Customer opsional untuk walk-in (FASE 1). */
export async function listCustomers(q: CustomerListQuery): Promise<CustomerRow[]> {
  const params: unknown[] = [];
  let where = '';
  if (q.q) {
    params.push(`%${q.q}%`);
    where = `WHERE (c.name ILIKE $1 OR c.phone ILIKE $1 OR c.owner_name ILIKE $1)`;
  }
  params.push(q.limit, q.offset);
  const res = await pool.query<CustomerRow>(
    `SELECT c.id, c.name, c.address, c.phone, c.owner_name
       FROM customer c ${where}
      ORDER BY c.name ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params as never[],
  );
  return res.rows;
}

export interface CustomerInput {
  name: string;
  address?: string | null;
  phone?: string | null;
  owner_name?: string | null;
}

export async function createCustomer(input: CustomerInput): Promise<CustomerRow> {
  const res = await pool.query<CustomerRow>(
    `INSERT INTO customer (name, address, phone, owner_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, address, phone, owner_name`,
    [input.name, input.address ?? null, input.phone ?? null, input.owner_name ?? null],
  );
  return res.rows[0]!;
}

export async function getCustomer(id: number): Promise<CustomerRow> {
  const res = await pool.query<CustomerRow>(
    `SELECT id, name, address, phone, owner_name FROM customer WHERE id = $1`,
    [id],
  );
  if (!res.rows[0]) throw notFound(`Customer id=${id} tidak ditemukan`);
  return res.rows[0];
}

export async function updateCustomer(id: number, patch: Partial<CustomerInput>): Promise<CustomerRow> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.address !== undefined) {
    params.push(patch.address);
    sets.push(`address = $${params.length}`);
  }
  if (patch.phone !== undefined) {
    params.push(patch.phone);
    sets.push(`phone = $${params.length}`);
  }
  if (patch.owner_name !== undefined) {
    params.push(patch.owner_name);
    sets.push(`owner_name = $${params.length}`);
  }
  if (sets.length === 0) throw new ApiError('VALIDATION_ERROR', 'Tidak ada kolom yang akan diubah');

  params.push(id);
  const res = await pool.query(
    `UPDATE customer SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, name, address, phone, owner_name`,
    params as never[],
  );
  if (!res.rows[0]) throw notFound(`Customer id=${id} tidak ditemukan`);
  return res.rows[0];
}
