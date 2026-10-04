## Use case asal (FASE 0–8)
1. owner membeli stok barang
2. beli perdana tri  30pcs 20gb expired 2027-02-02 dengan harga 23000/pcs dan set harga jual 25000/pcs
3. beli voucher kuota 7gb 20 pcs dengan harga 11000/pcs dan set harga jual 15000/pcs
4. customer order membeli kartu perdana tri 11pcs di harga nego 24500/pcs  dan voucher 7gb 5 pcs dengan harga nego 13000/pcs
5. lalu buatkan nota / struk order
6. maka report penjualan, stok produk, dan laporan keuangan akan terupdate, customer yg belum membayar, sisa stok
7. lalu periode laba bersih dan laba netto akan terupdate, owner membuat transaksi untuk pengeluaran operasional bulan ini misalnya dengan komponen gaji karyawan, listrik,internet dll, maka laporan owner juga harus terlihat, dan operasional hanya owner saja yg bisa input dan update

> Catatan RBAC v2: poin 7 berubah — **kasir** yang meng-input operasional; **owner** yang membaca daftar opex + semua `/reports/*`. Owner tidak lagi boleh melakukan mutasi apa pun.

---

## Use case v2 (backend v2 — refund parsial, stok rusak, retur distributor, opname detail)

### UC-A — Refund parsial barang rusak (nota sudah DIBAYAR)
> Nota 3 kartu Tri 30GB @24.500 sudah PAID. Customer balik 1 kartu yang **rusak**.

1. Kasir membuat penjualan 3 pcs, dibayar CASH Rp73.500 → `status=COMPLETED`, `payment_status=PAID`, `is_test=false`.
2. Kasir retur 1 pcs berlabel rusak: `POST /sales/{id}/refund`
   `{ "reason": "kartu rusak", "items": [{ "sale_item_id": 12, "qty": 1, "condition": "RUSAK" }] }`
3. **Harapan:**
   - uang Rp24.500 kembali (baris `refunds` + `refund_items` qty 1, `condition=RUSAK`, `subtotal=24500`)
   - kartu **tidak** kembali ke stok jual: `qty_on_hand` tetap 3 → 0, `qty_damaged` batch +1
   - `stock_movements` dapat 1 baris `IN` `condition=RUSAK` `reference_type=RETURN`
   - status sale **tetap `COMPLETED`** (hanya `refunded_amount` naik) karena masih ada 2 item
4. Pelanggan lalu minta sisanya dikembalikan penuh: `POST /sales/{id}/refund` `{ "reason": "sisa retur", "items": [...] }` atau tanpa `items` (refund penuh).
   - **Harapan:** total direfund Rp73.500, 2 item kembali ke `qty_remaining`, status sale → **`RETURNED`**
5. Kasir mencoba refund 5 pcs dari item yang hanya tersisa 1 → **`422 REFUND_QTY_EXCEEDED`**.
6. Laporan: `total_refund` pada P&L bulan itu naik Rp73.500; session kas (`expected_cash`) berkurang Rp73.500 bila metode refund CASH.

### UC-B — Retur ke distributor → uang masuk atau jadi opex
> 2 pcs barang rusak dari UC-A sudah dikumpulkan di gudang; distributor (= supplier kartunya) dihubungi.

1. Kasir melihat barang yang bisa diretur: `GET /stock/damaged` → per batch: `batch_id`, `qty_damaged`, `unit_cost`, `value`.
2. Kasir membuat retur: `POST /supplier-returns`
   `{ "supplier_name": "Telkomsel Distributor", "items": [{ "batch_id": 41, "qty": 1 }] }`
   - **Harapan:** dokumen `RTR-YYYYMMDD-001`, `status=PENDING`, `total_cost=40000` (harga beli batch),
     `stock_movements` dapat `OUT` `condition=RUSAK` `reference_type=SUPPLIER_RETURN`, dan **`qty_damaged` batch −1**
   - retur melebihi `qty_damaged` → `409 DAMAGED_QTY_INSUFFICIENT`
3. **Distributor membayar balik** (uang refund distributor):
   `POST /supplier-returns/{id}/settle` `{ "result": "REFUNDED", "amount": 40000, "method_id": 1, "reference_no": "TRF-77" }`
   - **Harapan:** status `REFUNDED`, `refunded_at` terisi, `refunded_amount=40000`
   - **Laporan P&L bulan itu:** baris baru **`refund_distributor` = +Rp40.000** (pendapatan lain) →
     `laba_bersih = laba_kotor + refund_distributor − beban_operasional`
   - `/reports/opname` → `stok_rusak_belum_diretur.pending_return_count` turun
4. Settle kedua pada retur yang sama → **`409 SUPPLIER_RETURN_SETTLED`**.
5. **Distributor menolak** retur berikutnya (barang ini tidak layak): settle `{ "result": "WRITTEN_OFF" }`
   - **Harapan:** status `WRITTEN_OFF` + **otomatis** opex di `operational_expenses`:
     `category=BARANG_RUSAK`, `amount=total_cost`, `source=SUPPLIER_RETURN`, `supplier_return_id=<id retur>`,
     muncul di `GET /supplier-returns/{id}` pada field `write_off_expense`
   - Opex itu **ikut memotong laba_bersih** di P&L bulan itu (bukan `refund_distributor`)

### UC-C — Void berlabel (barang kembali dengan kondisi)
> Pembeli batal sebelum bayar, tetapi 1 dari 2 item ditemukan **rusak** saat dibuka.

1. Kasir membuat penjualan 2 Tri 30GB + 1 voucher **tanpa pembayaran** (`UNPAID`), lalu membatalkan:
   `POST /sales/{id}/void`
   `{ "reason": "barang rusak saat terima", "items": [{ "sale_item_id": 30, "condition": "GOOD" }, { "sale_item_id": 31, "condition": "RUSAK" }] }`
2. **Harapan:**
   - `status=VOIDED` dengan alasan & `voided_by` (dari JWT)
   - movement `IN` `reference_type=VOID` **bernama label berbeda**:
     `Void penjualan` (GOOD) vs `Void penjualan - rusak` (RUSAK)
   - item GOOD menambah `qty_remaining` (bisa dijual lagi); item RUSAK menambah `qty_damaged` (karantina)
   - void tanpa `items` (perilaku lama) tetap mengembalikan semua item sebagai GOOD
   - void penjualan yang **sudah dibayar** tetap ditolak `409 VOID_NOT_ALLOWED`
3. Void kedua / `sale_item_id` milik penjualan lain → `409 TRANSITION_NOT_ALLOWED` / `422 VOID_ITEM_MISMATCH`

### UC-D — Opname detail + laporan analisa (OWNER)
> Opname tutup bulan: gudang menemukan 1 kartu hilang, 1 kartu rusak tak tercatat, dan 1 kartu rusak tercatat excess.

1. Kasir menyimpan opname dengan hitungan GOOD **dan** RUSAK:
   `POST /opnames`
   `{ "note": "opname akhir bulan", "items": [{ "product_id": 7, "physical_qty": 29, "physical_qty_damaged": 0, "cause": "HILANG" }] }`
2. **Harapan:**
   - `system_qty` GOOD 30, `difference` −1 → 1 movement `ADJUSTMENT` `condition=GOOD`
   - `system_qty_damaged` 1, `physical_qty_damaged` 0, `damaged_difference` −1 → 1 movement `ADJUSTMENT` `condition=RUSAK`
   - `GET /opnames/{id}` per item: `unit_cost`, `value_difference` = −1 × 23.000 = **−23.000**,
     `value_difference_damaged` = −23.000, `value_difference_total` = **−46.000**, `cause=HILANG`
   - header: `total_value_difference = −46.000`, `total_loss_value = 46.000`, `total_gain_value = 0`
3. Laporan bulanan (khusus **OWNER**): `GET /reports/opname?month=2026-10`
   - rekap total: `opname_count`, `selisih_qty`, `selisih_qty_damaged`, `nilai_selisih`, `nilai_rugi`, `nilai_lebih`
   - rincian `per_cause` (RUSAK / HILANG / SALAH_HITUNG / LAIN) & `per_kategori`
   - `top_produk` 10 produk dengan nilai selisih terbesar, `tren_6_bulan`
   - `stok_rusak_belum_diretur` (qty & nilai stok rusak, plus retur distributor `PENDING`)
4. Kasir mencoba akses `/reports/opname` → **`403 FORBIDDEN`** (laporan hanya OWNER).
