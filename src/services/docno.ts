import { QueryTypes, Transaction } from 'sequelize';

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
 * MP-9: pemanggilnya semua service ber-ORM, jadi satu-satunya runner yang
 * diterima adalah `Transaction` Sequelize. Jalur `pg.PoolClient` lama dihapus
 * bersama `config/db.ts`; SQL-nya sendiri tidak berubah sama sekali.
 *(prefix & nama sequence berasal dari konstanta di bawah — bukan input user —
 *  jadi nol risiko injeksi.)
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

export async function nextDocNo(runner: Transaction, kind: DocNoKind, businessTz: string): Promise<string> {
  const sql = docNoSql(kind);

  // `Transaction.query()` TIDAK ada di Sequelize v6 (hanya v4/v5) dan
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
