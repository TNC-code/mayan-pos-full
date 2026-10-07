# Plan — Asisten Kasir WhatsApp (AI Order Parser via Baileys) · v2

> **Status: 🟢 AKTIF** · Bot: `/Users/dhimassg/Documents/WORK/HOUSE/be-quotaku/baileys_wabot` (Baileys 7 + Express :5010 + Mongo, multi-client)
> POS: `inventory_quot` (Tenant API :3000 / `https://invcash.quotaku.com/api/v1`) · FE Flutter tablet
>
> **Use case v2**: customer chat **abstrak** — `"sp tri 30gb 60hr 30pcs vc tlkm 40gb 5hr 40"` → **AI (MiniMax via OpenAI-compatible, seperti konfig opencode) menerjemahkan ke JSON item** → fuzzy match katalog → **ORDER BOOK langsung masuk menu "Order WA" kasir** untuk diproses jadi penjualan.

---

## 1. Alur Lengkap (v2 — tanpa menu terpandu)

### 1.1 Sisi customer
```
Customer: "sp tri 30gb 60hr 30pcs vc tlkm 40gb 5hr 40"
   │
   ▼ AI TRANSLATOR (MiniMax, JSON mode)
{ "items": [
   {"jenis":"kartu","operator":"tri","kuota":"30gb","masa":"60hr","qty":30,"raw":"sp tri 30gb 60hr 30pcs"},
   {"jenis":"voucher","operator":"telkomsel","kuota":"40gb","masa":"5hr","qty":40,"raw":"vc tlkm 40gb 5hr 40"} ],
  "customer_note": null }
   │
   ▼ FUZZY MATCH katalog POS (fast-fuzzy: "tri 30gb 60 hari" ~ "Kartu Perdana Tri 30GB 60hr")
   ├─ match yakin  → product_id + harga snapshot
   └─ ragu/tidak ketemu → item tetap masuk, flag UNMATCHED (kasir pilih manual)
   │
   ▼ ORDER BOOK dibuat (PENDING) — ORD-YYYYMMDD-NNN
Bot: "✅ Order diterima: ORD-20261005-001
      1. Kartu Perdana Tri 30GB 60hr × 30
      2. Voucher Telkomsel 40GB 5hr × 40 (perlu konfirmasi)
      Pesanan sedang diproses kasir."
```
Tidak ada state machine panjang — **satu chat = satu order**. Chat lanjutan dari nomor sama dalam 10 menit & ada order PENDING → ditawarkan "tambahkan ke order terakhir? (ya/tidak)" (satu-satunya state).

### 1.2 Sisi kasir (Flutter)
```
Menu "Order WA" (badge PENDING) → detail order:
  • item MATCHED   → centang hijau + harga
  • item UNMATCHED → ⚠ pilih produk via picker (reuse) / ubah qty / hapus
  • [Proses jadi Penjualan] → prefill keranjang POS → bayar normal → DONE
  • [Batalkan] (alasan wajib)
```

## 2. Desain Data — POS backend (migration 0009)
```sql
CREATE TABLE order_books (
  id bigserial PRIMARY KEY,
  order_no text UNIQUE,                    -- ORD-YYYYMMDD-NNN (seq order_no_seq)
  status varchar(12) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','DONE','CANCELLED')),
  source varchar(10) NOT NULL DEFAULT 'WHATSAPP',
  customer_id integer REFERENCES customer(id),
  customer_name text, customer_phone text,
  raw_message text,                        -- chat asli PESTRUKTUR (audit AI)
  note text,
  sale_id bigint REFERENCES sales(id),
  created_by integer REFERENCES user_account(id),   -- akun sistem 'bot'
  processed_by integer REFERENCES user_account(id),
  created_at/updated_at timestamptz
);
CREATE TABLE order_book_items (
  id bigserial PRIMARY KEY,
  order_book_id bigint NOT NULL REFERENCES order_books(id) ON DELETE RESTRICT,
  product_id integer REFERENCES product(id),        -- NULL = UNMATCHED (kasir pilih)
  product_name text NOT NULL,              -- hasil AI/match (deskriptif)
  raw_text text,                            -- potongan chat asal item ini
  qty numeric(14,3) NOT NULL CHECK (qty > 0),
  unit_price numeric(14,2) NOT NULL DEFAULT 0,      -- 0 bila belum match
  matched boolean NOT NULL DEFAULT false,
  match_score numeric(4,3)                  -- confidence fuzzy (0..1)
);
```
Order book = **draft**, tidak menyentuh stok/ledger. AI output mentah disimpan di `raw_message` (bukan kolom ai_parsed — bisa direkonstruksi & hindari kebocoran payload).

## 3. API Baru (Tenant API)
| Endpoint | Akses | Fungsi |
|---|---|---|
| `POST /order-books` `{customer_phone, customer_name?, raw_message, note?, items:[{product_id?, product_name, raw_text, qty}]}` | **X-Internal-Key bot** ATAU kasir | buat order; server snapshot harga bila product_id valid; match score dihitung server? TIDAK — bot yang match; server hanya validasi product aktif |
| `GET /order-books?status=&date=&q=` · `GET /order-books/{id}` | login | list/detail |
| `PATCH /order-books/{id}/items/{itemId}` `{product_id?, qty?}` | kasir | kasir perbaiki item (pilih produk/ubah qty); harga re-snapshot; matched=true |
| `DELETE /order-books/{id}/items/{itemId}` | kasir | hapus item salah |
| `POST /order-books/{id}/status` | kasir | PROCESSING / CANCELLED (alasan wajib) |
| `POST /order-books/{id}/convert` `{sale_id}` | kasir | DONE + link sale (dipanggil FE pasca checkout) |

**Auth bot**: middleware `requireInternalKey` (`X-Internal-Key` == env `INTERNAL_API_KEY`); audit `created_by` = user sistem `bot` (seed, tidak bisa login interaktif).

## 4. Modul Bot — `src/modules/posOrder/`
- **`ai.ts`** — klien **MiniMax via OpenAI-compatible** (persis pola opencode): `MINIMAX_BASE_URL=https://api.minimax.io/v1`, `MINIMAX_API_KEY`, `MINIMAX_MODEL` (default `MiniMax-M3.1-Flash-Preview` — cepat/murah untuk parsing; bisa naik ke `MiniMax-M3` bila akurasi kurang). Pakai SDK `openai` (baseUrl custom) + **response_format json_object**; system prompt ketat: skema `{items:[{jenis,keterangan,qty,raw}]}` — AI HANYA menerjemahkan (tidak menyebut product_id/harga; tidak mengarang qty; qty default 1 bila tak disebut; abaikan basa-basi; `keterangan` = deskripsi lengkap gabungan token "tri 30gb 60hr"). Retry 2× + timeout 15s; gagal → bot balas "maaf, pesanan gagal dibaca — tolong tulis format: [produk] [jumlah]".
- **`catalog.ts`** — katalog+stok POS (cache 5 mnt) → index fuzzy: nama + sku + kata kunci (`tri|tlkm|telkomsel|sp|vc|voucher|kartu`).
- **`match.ts`** — AI keterangan → kandidat produk via `fast-fuzzy` + heuristik (operator+kuota+masa harus cocok); `score ≥ 0.75` → matched; 0.4–0.75 → simpan kandidat di `match_score` (UNMATCHED tapi kasir lihat saran); < 0.4 UNMATCHED polos.
- **`api.ts`** — klien tenant API: buat order-book, cek stok ringan.
- **`flow.ts`** — orchestrator: pesan → ai.ts → match.ts → api.ts → balasan ringkasan (item ✓ / ⚠ belum pasti). Trigger: client `pos_enabled`; pesan pendek <3 kata & bukan order ("halo", "harga?") → jawaban singkat statis + contoh format order.
- Routing di `services/wa.ts` messages.upsert: posOrder dulu → fallback intent lama (ECY/fuzzy) untuk client non-POS.
- Multi-client siap multi-toko: `pos_enabled` + `pos_tenant_code` per UsersClient (v1 = 1 toko).

## 5. Flutter (perubahan kecil)
- Menu kasir **"Order WA"** (`/order-books`): list + badge PENDING; detail dengan **editor item** (picker produk untuk UNMATCHED + saran kandidat, qty, hapus), tombol Proses → prefill cart → checkout normal → `convert`; Batalkan (alasan).
- Reuse penuh payment/refund/ledger — tidak ada jalur sale kedua.

## 6. Batasan v1
- AI hanya menerjemahkan — product matching tetap fuzzy lokal + konfirmasi kasir (salah match tidak pernah langsung jadi sale)
- Bot tidak memotong stok; DP/kasbon ditangani kasir saat convert
- Balasan struk DONE via WA → fase 2
- Harga yang ditampilkan bot = harga jual normal

## 7. Fase & Task (±9–11 hari)
| Fase | Scope | Est |
|---|---|---|
| **WA-0** | Backend: DDL 0009 + 6 endpoint + internal key + seed bot + e2e | 2d |
| **WA-1** | Bot: ai.ts (MiniMax) + catalog + match + flow + routing + uji nyata WA → ORD- | 4d |
| **WA-2** | Flutter: menu Order WA + editor item + prefill + convert | 2d |
| **WA-3** | Polish + regresi full + docs (openapi 42→48) | 1–2d |

## 8. Risiko & mitigasi
| Risiko | Mitigasi |
|---|---|
| AI halusinasi (produk/qty salah) | AI hanya deskripsi+qty; match lokal; kasir selalu review; raw_message tersimpan |
| Biaya/latency AI | model flash; cache; fallback format manual bila AI down |
| Nomor WA banned | nomor khusus, rate limit balasan, no broadcast |
| Stok berubah saat convert | validasi stok saat convert; kasir edit qty prefill |
| Key MiniMax tersebar | hanya di .env bot server, tidak di repo/git |
