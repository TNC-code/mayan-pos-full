import { QueryTypes, Transaction } from 'sequelize';
import type { PoolClient } from 'pg';

/**
 * Penomoran dokumen dari SEQUENCE DB (bukan max(timestamp)+1) supaya tetap unik
 * ketika 2 terminal POS submit bersamaan (fase.md "Aturan wajib aplikasi" #3).
 * Tanggal bagian diambil dari jam server DB (now()).
 *
 * `nextval()` bersifat atomik dan sequence tidak pernah di-rollback, jadi dua
 * kasir yang submit bersamaan tetap mendapat nomor berbeda (bisa ada selisih
 * nomor saat transaksi rollback — sama seperti versi lama, itu disengaja:
 * nomor tidak boleh dipakai ulang).
 *
 * MP-3: signature menerima DUA jenis runner — `PoolClient` (service yang masih
 * raw SQL: sale, opname, supplier-return, order-book — migrasi bertahap) dan
 * `Transaction` Sequelize (service yang sudah pindah ke ORM, mulai
 * `purchase.service.ts`). SQL-nya sama persis; hanya mekanisme parameterized
 * yang berbeda (`$1` + array `values` untuk pg, `bind` untuk Sequelize).
 *(nextvalue/type tidak pernah digabung ke string -> nol risiko injeksi.)
 */
const PREFIX: Record<string, string> = {
  sale: 'INV',
  batch: 'GRN',
  opname: 'OPN',
  supplierReturn: 'RTR',
  order: 'ORD',
};

const SEQ: Record<string, string> = {
  sale: 'public.sale_no_seq',
  batch: 'public.batch_code_seq',
  opname: 'public.opname_no_seq',
  supplierReturn: 'public.supplier_return_no_seq',
  order: 'public.order_no_seq',
};

export type DocNoKind = keyof typeof PREFIX;

/** Nama sequence & prefix berasal dari peta konstanta di atas — bukan input user. */
function docNoSql(kind: DocNoKind): string {
  return (
    `SELECT '${PREFIX[kind]}' || '-' || to_char(now() AT TIME ZONE $1, 'YYYYMMDD') || '-' || ` +
    `lpad(nextval('${SEQ[kind]}')::text, 3, '0') AS doc_no`
  );
}

export async function nextDocNo(runner: PoolClient | Transaction, kind: DocNoKind, businessTz: string): Promise<string> {
  const sql = docNoSql(kind);

  if (runner instanceof Transaction) {
    // Catatan: `Transaction.query()` TIDAK ada di Sequelize v6 (hanya v4/v5) dan
    // `transaction.sequelize` juga belum masuk typings -> jalur ORM adalah
    // `sequelize.query(sql, { transaction })`, dan reference ke instance
    // Sequelize-nya diambil dari objek transaction itu sendiri.
    const { sequelize } = runner as unknown as {
      sequelize: { query: (sql: string, options: Record<string, unknown>) => Promise<Array<{ doc_no: string }>> };
    };
    const rows = await sequelize.query(sql, {
      bind: [businessTz],
      type: QueryTypes.SELECT,
      transaction: runner,
    });
    return rows[0]!.doc_no;
  }

  const res = await runner.query<{ doc_no: string }>(sql, [businessTz]);
  return res.rows[0]!.doc_no;
}
