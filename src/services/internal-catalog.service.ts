import { pool } from '../config/db.js';

/**
 * Katalog ringkas untuk integrasi server-to-server (bot WA `internal/catalog`).
 *
 * Tidak sama dengan `GET /products`:
 *  - tidak butuh JWT, hanya `X-Internal-Key` (bot tidak punya akun kasir),
 *  - digabung dengan stok (`stock_batches`) supaya bot bisa clamp qty saat order,
 *  - **tidak** mengirim `harga_beli` (harga beli tidak boleh keluar ke integrasi luar POS).
 *
 * Hanya produk AKTIF. Query mengikuti pola wajib di stock.service.ts (fase.md §0):
 * stok dihitung dari `SUM(qty_remaining)` per batch (angka murni hasil trigger DB).
 */
export interface InternalCatalogItem {
  id: number;
  sku: string | null;
  barcode: string | null;
  name: string;
  unit: string | null;
  category_name: string | null;
  harga_jual: number | null;
  /** Barang GOOD yang boleh terjual (qty_remaining semua batch). */
  qty_on_hand: number;
  /** Barang rusak karantina (bukan untuk dijual; informatif). */
  qty_damaged: number;
  /** Konversi satuan ringkas, mis. { pcs: 1, lusin: 10 } - null kalau tidak diisi. */
  unit_conversions: Record<string, number> | null;
}

export async function getInternalCatalog(): Promise<InternalCatalogItem[]> {
  const res = await pool.query<InternalCatalogItem>(
    `SELECT p.id, p.sku, p.barcode, p.name, p.unit, c.name AS category_name,
            p.harga_jual, p.unit_conversions,
            COALESCE(SUM(b.qty_remaining), 0)::numeric(14,3) AS qty_on_hand,
            COALESCE(SUM(b.qty_damaged), 0)::numeric(14,3) AS qty_damaged
       FROM product p
       LEFT JOIN stock_batches b ON b.product_id = p.id
       LEFT JOIN product_category c ON c.id = p.category_id
      WHERE p.is_active = true
      GROUP BY p.id, c.name
      ORDER BY p.name ASC`,
  );
  return res.rows;
}