# Tasklist — Asisten Kasir WA (AI Order Parser) v2

> Sumber spec: `plan-wa-order-assistant.md` (v2 — AI translator, bukan menu terpandu) · Bot: `be-quotaku/baileys_wabot` · Status: `[ ]` todo

## Riwayat
- [x] **WA-0** Backend POS: order book + internal key — selesai (DDL9 idempotent 3×, user sistem `bot` id=7, e2e 359 PASS / 0 FAIL, openapi 41 → 46 path / 65 operation)
- [x] **WA-2** Flutter: menu Order WA — selesai (kasir 10 → 11 menu + badge PENDING rail, list + detail editor item, prefill `addBulk` → POS → `convert`, alasan pembatalan wajib; `flutter analyze` 0 · `flutter test` 549 hijau · `build apk --debug` sukses · menu-matrix diperbarui)

## WA-0 — Backend POS: order book + internal key (2d)
- [x] DDL 0009 (idempotent): `order_books` (order_no seq, status PENDING/PROCESSING/DONE/CANCELLED, source, customer, `raw_message`, note, sale_id, created_by/processed_by) + `order_book_items` (product_id NULLABLE, product_name, raw_text, qty, unit_price, matched, match_score) + index
- [x] Seed user sistem `bot` (audit; tidak bisa login interaktif) — `is_active=false` + password bcrypt 48-char acak sekali pakai, tidak dicatat di mana pun; `npm run migrate` mencetak `id=7`
- [x] Middleware `requireInternalKey` (`X-Internal-Key` vs `INTERNAL_API_KEY`) + `INTERNAL_API_KEY` di `.env` (random) + `.env.example` (placeholder)
- [x] Endpoints: `POST /order-books` (validasi produk aktif + snapshot harga bila product_id), `GET` list+filter, `GET /{id}`, `PATCH /{id}/items/{itemId}` (kasir: product/qty, re-snapshot harga, matched=true), `DELETE /{id}/items/{itemId}`, `POST /{id}/status` (CANCELLED alasan wajib / PROCESSING), `POST /{id}/convert` {sale_id} (guard status & sale valid)
- [x] Error codes: `ORDER_NOT_FOUND`, `ORDER_ALREADY_DONE`, `ORDER_ITEM_NOT_FOUND`, `ORDER_CONVERT_INVALID` + map HTTP (tambah `ORDER_STATUS_TRANSITION`, `ORDER_LAST_ITEM`, `INTERNAL_KEY_INVALID`)
- [x] openapi.yaml +5 path / 7 operation (tag `Order Books`, `securitySchemes.internalKeyAuth`, `x-error-codes`); e2e: buat via internal key → edit item → cancel → convert → guard dobel
- [x] Verifikasi: typecheck + build + migrate 3× + backup + e2e 359/0 + restart server :3000

## WA-1 — Bot: AI translator (MiniMax) + matcher (4d)
- [ ] `.env` bot: `POS_API_URL`, `POS_INTERNAL_API_KEY`, `MINIMAX_BASE_URL=https://api.minimax.io/v1`, `MINIMAX_API_KEY`, `MINIMAX_MODEL=MiniMax-M3.1-Flash-Preview`; field UsersClient `pos_enabled` + `pos_tenant_code`
- [ ] `src/modules/posOrder/ai.ts`: SDK `openai` (baseUrl MiniMax) + JSON mode; system prompt skema `{items:[{keterangan, qty, raw}]}` (qty default 1; abaikan sapaan; jangan mengarang); retry 2× timeout 15s; fallback instruksi format manual
- [ ] `catalog.ts`: katalog+stok POS cache 5 mnt + index fuzzy (nama, sku, keyword operator/jenis)
- [ ] `match.ts`: fast-fuzzy + heuristik operator/kuota/masa; ≥0.75 matched; 0.4–0.75 saran; simpan score
- [ ] `api.ts`: create order-book (product_id?, product_name=deskripsi AI/match, raw_text, qty)
- [ ] `flow.ts`: pesan → AI → match → create → balasan ringkasan (✓ match / ⚠ perlu konfirmasi); sapaan singkat → contoh format; append ke order PENDING <10 mnt (konfirmasi ya/tidak)
- [ ] Routing `services/wa.ts`: posOrder untuk client pos_enabled; fallback intent lama untuk lainnya
- [ ] Auto-register customer by phone WA (nama profil)
- [ ] Uji nyata: pairing nomor WA → chat abstrak sampai ORD- terbentuk di POS + item match benar; uji fallback AI down
- [ ] PM2 jalan + log

## WA-2 — Flutter: menu Order WA (2d)
- [x] Branch `/order-books` + menu kasir "Order WA" + badge PENDING di rail
- [x] List (filter status/tanggal) + detail: item matched ✓ / UNMATCHED ⚠ dengan **saran kandidat** + picker produk (reuse) + edit qty + hapus item
- [x] Proses → prefill cart (addBulk) + `activeOrderBookId` → POS checkout normal → sukses `POST convert`
- [x] Batalkan (dialog alasan wajib); guard status; stok kurang saat prefill → warning + koreksi qty
- [x] Widget test + analyze 0 + build APK

### Catatan implementasi WA-2
- **Menu kasir 10 → 11**: `Order WA` setelah `Retur Distributor`, sebelum `Shift`; `ownerOnlyPaths` tidak berubah
  (owner tetap 8 menu; `/order-books` read-only untuk owner lewat guard `sharedRead` + deep-link).
- **Badge rail**: `pendingOrderBookCountProvider` (`GET /order-books?status=PENDING`, tanpa batas tanggal,
  `limit=200`) + `Timer.periodic` 60 detik di shell + invalidate setiap mutasi.
- **Prefill**: `CartController.addBulk(List<CartBulkLine>)` — satu commit draft, qty dijepit ke stok
  (`CartBulkResult.clamped`) → dialog peringatan "Qty dikoreksi karena stok kurang" sebelum pindah ke `/pos`.
- **Hook convert**: di `CheckoutController.submit` **setelah** `POST /sales` sukses (pastikan penjualan
  `COMPLETED`) → `POST /order-books/{id}/convert {sale_id}`; retry 2× hanya untuk error transien; gagal →
  `orderBookConvertNoticeProvider` → snackbar amber di POS "…belum ditandai selesai — buka Order WA untuk
  konversi manual"; checkout tanpa order WA tidak menambah request sama sekali.
- **Aditif pada komponen existing** (kompatibel mundur): `AppConfirmDialog.confirmEnabled/confirmHint/confirmResult`,
  `ProductPickerDialog.initialQuery` (prefill kandidat bot), `ProductApi.getProduct(id)`.
- **Error map** `ORDER_NOT_FOUND`, `ORDER_ITEM_NOT_FOUND`, `ORDER_ALREADY_DONE`, `ORDER_LAST_ITEM`,
  `ORDER_STATUS_TRANSITION`, `ORDER_CONVERT_INVALID` → Bahasa Indonesia di `ApiException.message`.
- Sanity: `flutter analyze` 0 issue · `flutter test` 549 pass / 19 skip (live) · `flutter build apk --debug` OK.

## WA-3 — Polish & regresi (1–2d)
- [ ] Error map FE lengkap; badge live refresh
- [ ] Regresi: e2e backend + flutter test + 1 siklus manual end-to-end (chat abstrak → order → kasir → bayar → DONE)
- [ ] Docs: fase.md seksi baru, menu-matrix (+Order WA), openapi sinkron
- [ ] (backlog fase 2) balasan struk DONE via WA; DP di chat; multi-toko per tenant
