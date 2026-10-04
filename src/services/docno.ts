import type { PoolClient } from 'pg';

/**
 * Penomoran dokumen dari SEQUENCE DB (bukan max(timestamp)+1) supaya tetap unik
 * ketika 2 terminal POS submit bersamaan (fase.md "Aturan wajib aplikasi" #3).
 * Tanggal bagian diambil dari jam server DB (now()).
 */
const PREFIX: Record<string, string> = {
  sale: 'INV',
  batch: 'GRN',
  opname: 'OPN',
  supplierReturn: 'RTR',
};

const SEQ: Record<string, string> = {
  sale: 'public.sale_no_seq',
  batch: 'public.batch_code_seq',
  opname: 'public.opname_no_seq',
  supplierReturn: 'public.supplier_return_no_seq',
};

export async function nextDocNo(client: PoolClient, kind: keyof typeof PREFIX, businessTz: string): Promise<string> {
  const prefix = PREFIX[kind]!;
  const seq = SEQ[kind]!;
  const res = await client.query<{ doc_no: string }>(
    `SELECT '${prefix}-' || to_char(now() AT TIME ZONE $1, 'YYYYMMDD') || '-' || lpad(nextval('${seq}')::text, 3, '0') AS doc_no`,
    [businessTz],
  );
  return res.rows[0]!.doc_no;
}
