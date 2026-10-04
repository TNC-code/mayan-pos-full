#!/usr/bin/env bash
# Uji end-to-end POS Inventory (fase 0-5) terhadap server yang sedang jalan.
# Semua data uji memakai prefiks TEST- agar data asli (mis. kartu Telkomsel) tidak tersentuh.
set -uo pipefail

API=${API:-http://localhost:3000/api/v1}
PASS=0; FAIL=0
RUN_TAG="UJI$(date +%H%M%S)"
PASSED=(); FAILED=()

hr()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
step() { printf '\n\033[36m-- %s\033[0m\n' "$1"; }
ok()   { PASS=$((PASS+1)); PASSED+=("$1"); printf '  \033[32mPASS\033[0m %s :: %s\n' "$1" "${2:-}"; }
bad()  { FAIL=$((FAIL+1)); FAILED+=("$1"); printf '  \033[31mFAIL\033[0m %s :: %s\n' "$1" "${2:-}"; }

# check <label> <expected> <actual> [extra]
check() {
  if [[ "$2" == "$3" ]]; then ok "$1" "=$3"; else bad "$1" "harapan=$2 aktual=$3 ${4:-}"; fi
}
contains() {
  if [[ "$3" == *"$2"* ]]; then ok "$1" "mengandung '$2'"; else bad "$1" "ekspektasi mengandung '$2', aktual=${3:0:200}"; fi
}
jlen() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).length)}catch(e){console.log(0)}})" < "${1:-/tmp/r.json}"; }
jqv() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=process.argv[1].split('.').reduce((a,k)=>a?.[k],o);console.log(v===undefined||v===null?'':typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('')}})" "$1"; }

post()  { curl -s -o /tmp/r.json -w '%{http_code}' -X POST "$1" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" ${3:+-H "Idempotency-Key: $3"} -d "$2"; }
patch() { curl -s -o /tmp/r.json -w '%{http_code}' -X PATCH "$1" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "$2"; }
get()   { curl -s -o /tmp/r.json -w '%{http_code}' "$1" -H "Authorization: Bearer $TOKEN"; }
body()  { cat /tmp/r.json; }

hr "FASE 0 - auth"
step "a) login owner"
CODE=$(curl -s -o /tmp/r.json -w '%{http_code}' -X POST "$API/auth/login" -H 'Content-Type: application/json' -d '{"username":"owner","password":"owner123"}')
check "a1 login owner 200" 200 "$CODE" "$(body)"
TOKEN=$(jqv token < /tmp/r.json)
check "a2 role OWNER" "OWNER" "$(jqv role < /tmp/r.json)"
[[ -n "$TOKEN" ]] && ok "a3 token ada" "${TOKEN:0:25}..." || bad "a3 token ada" "kosong"

step "a) login kasir + proteksi endpoint"
CODE=$(curl -s -o /tmp/r.json -w '%{http_code}' -X POST "$API/auth/login" -H 'Content-Type: application/json' -d '{"username":"kasir1","password":"kasir123"}')
KASIR_TOKEN=$(jqv token < /tmp/r.json)
check "a4 login kasir 200" 200 "$CODE"
check "a5 role kasir KASIR" "KASIR" "$(jqv role < /tmp/r.json)"
CODE=$(get "$API/products"); check "a6 token valid -> 200" 200 "$CODE"
SAVED=$TOKEN; TOKEN="buruk"; CODE=$(get "$API/products"); check "a7 token salah -> 401" 401 "$CODE"; TOKEN=$SAVED
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$API/products"); check "a8 tanpa token -> 401" 401 "$CODE"
CODE=$(curl -s -o /tmp/r.json -w '%{http_code}' -X POST "$API/auth/login" -H 'Content-Type: application/json' -d '{"username":"owner","password":"salah"}')
check "a9 password salah -> 401" 401 "$CODE"

hr "FASE 1 - master data"
step "b) buat produk gula 1kg"
CODE=$(post "$API/products" "{\"sku\":\"TEST-GULA-$RUN_TAG\",\"barcode\":\"8991002101$RUN_TAG\",\"name\":\"TEST Gula 1kg\",\"unit\":\"kg\",\"category_id\":1,\"harga_beli\":10000,\"harga_jual\":15000,\"attributes\":{\"sumber\":\"uji e2e\"}}")
check "b1 create produk 201" 201 "$CODE" "$(body)"
GULA_ID=$(jqv id < /tmp/r.json)
GULA_NAME=$(jqv name < /tmp/r.json)
step "b) produk kedua (harga beli tinggi, untuk uji harga < beli)"
CODE=$(post "$API/products" "{\"sku\":\"TEST-VOUCHER-$RUN_TAG\",\"name\":\"TEST Voucher Gold\",\"unit\":\"pcs\",\"harga_beli\":40000,\"harga_jual\":55000}")
check "b2 create produk kedua 201" 201 "$CODE" "$(body)"
VOUCHER_ID=$(jqv id < /tmp/r.json)
step "b) pencarian barcode / sku / nama"
CODE=$(get "$API/products?q=TEST%20Gula"); check "b3 search by nama 200" 200 "$CODE"
check "b4 hasil memuat produk uji" "yes" "$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).some(x=>x.id==$GULA_ID)?'yes':'no'))" < /tmp/r.json)"
CODE=$(get "$API/products?q=TEST-GULA-$RUN_TAG"); check "b4b search by sku unik 200" 200 "$CODE"
check "b4c tepat 1 hasil by sku" "1" "$(jlen)"
CODE=$(get "$API/products?barcode_scan=1&q=8991002101$RUN_TAG"); check "b5 search by barcode 200" 200 "$CODE"
check "b6 ketemu by barcode" "$GULA_ID" "$(jqv 0.id < /tmp/r.json)"
step "b) payment methods (menu)"
CODE=$(get "$API/payment-methods"); check "b7 list payment methods 200" 200 "$CODE"
CASH_ID=$(node -e "const a=JSON.parse(require('fs').readFileSync('/tmp/r.json'));console.log(a.find(x=>x.code==='CASH').id)")
BANK_ID=$(node -e "const a=JSON.parse(require('fs').readFileSync('/tmp/r.json'));console.log(a.find(x=>x.code==='BANK_TRANSFER').id)")
# code unik per run supaya skrip bisa diulang berkali-kali
MCODE="M$RUN_TAG"
CODE=$(post "$API/payment-methods" "{\"code\":\"$MCODE\",\"name\":\"TEST E-Wallet $RUN_TAG\",\"requires_reference\":true}")
check "b8 owner create method 201" 201 "$CODE" "$(body)"
EWALLET_ID=$(jqv id < /tmp/r.json)
CODE=$(post "$API/payment-methods" "{\"code\":\"EWALLET\",\"name\":\"duplikat\"}")
if [[ "$CODE" == "409" ]]; then ok "b9 kode metode unik -> 409" "$(jqv code < /tmp/r.json)"; else bad "b9 kode metode unik -> 409" "aktual=$CODE $(body)"; fi
CODE=$(post "$API/payment-methods" '{"code":"kode nakal!","name":"invalid"}'); check "b9b kode format salah -> 400" 400 "$CODE" "$(body)"
SAVED=$TOKEN; TOKEN=$KASIR_TOKEN
CODE=$(post "$API/payment-methods" '{"code":"OTHER","name":"TEST Other"}'); check "b10 kasir create method -> 403" 403 "$CODE" "$(body)"
CODE=$(get "$API/payment-methods"); check "b11 kasir boleh list method 200" 200 "$CODE"
TOKEN=$SAVED

hr "FASE 2 - pembelian (barang masuk)"
step "b) purchase 10 kg gula @10000"
CODE=$(post "$API/purchases" "{\"product_id\":$GULA_ID,\"qty\":10,\"unit_cost\":10000,\"supplier\":\"TEST supplier\",\"notes\":\"uji e2e\"}")
check "b12 purchase 201" 201 "$CODE" "$(body)"
GULA_BATCH=$(jqv id < /tmp/r.json)
check "b13 qty_received 10" "10" "$(jqv qty_received < /tmp/r.json)"
check "b14 qty_remaining 10 (movement IN)" "10" "$(jqv qty_remaining < /tmp/r.json)"
contains "b15 batch_code GRN-" "GRN-" "$(jqv batch_code < /tmp/r.json)"
step "b) purchase 5 pcs voucher @40000 (untuk uji harga jual < beli)"
CODE=$(post "$API/purchases" "{\"product_id\":$VOUCHER_ID,\"qty\":5,\"unit_cost\":40000}")
check "b16 purchase voucher 201" 201 "$CODE" "$(body)"
VOUCHER_BATCH=$(jqv id < /tmp/r.json)
step "b) stok setelah pembelian"
CODE=$(get "$API/stock?product_id=$GULA_ID"); check "b17 get stock 200" 200 "$CODE"
check "b18 qty_on_hand gula = 10" "10" "$(jqv 0.qty_on_hand < /tmp/r.json)"
CODE=$(get "$API/stock/movements?product_id=$GULA_ID&type=IN"); check "b19 list movement IN 200" 200 "$CODE"
check "b20 1 movement IN" "1" "$(jlen)"

hr "FASE 3 - penjualan atomic"
step "c) jual gula 0.25 kg @15000 + CASH lunas (tendered 20000)"
KEY_C=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"note\":\"uji e2e c\",\"items\":[{\"product_id\":$GULA_ID,\"qty\":0.25,\"unit_price\":15000}],\"payment\":{\"method_id\":$CASH_ID,\"amount\":3750,\"tendered_amount\":20000}}" "$KEY_C")
check "c1 create sale 201" 201 "$CODE" "$(body)"
SALE_C=$(jqv id < /tmp/r.json)
SALE_NO_C=$(jqv sale_no < /tmp/r.json)
check "c2 total 3750" "3750" "$(jqv total_amount < /tmp/r.json)"
check "c3 payment_status PAID" "PAID" "$(jqv payment_status < /tmp/r.json)"
check "c4 status COMPLETED" "COMPLETED" "$(jqv status < /tmp/r.json)"
check "c5 due_amount 0" "0" "$(jqv due_amount < /tmp/r.json)"
check "c6 change 16250 (generated column)" "16250" "$(jqv payments.0.change_amount < /tmp/r.json)"
check "c7 auto-FIFO batch dipilih" "$GULA_BATCH" "$(jqv items.0.batch_id < /tmp/r.json)"
check "c8 unit_cost snapshot 10000" "10000" "$(jqv items.0.unit_cost < /tmp/r.json)"
contains "c9 sale_no INV-YYYYMMDD-###" "INV-" "$SALE_NO_C"
step "c) cek stok jadi 9.750"
CODE=$(get "$API/stock?product_id=$GULA_ID"); check "c10 get stock 200" 200 "$CODE"
check "c11 qty_on_hand = 9.75" "9.75" "$(jqv 0.qty_on_hand < /tmp/r.json)"
CODE=$(get "$API/stock/movements?product_id=$GULA_ID&type=OUT"); check "c12 movement OUT tercatat" 200 "$CODE"
check "c13 qty_change -0.25" "-0.25" "$(jqv 0.qty_change < /tmp/r.json)"

step "d) jual 2 pcs voucher @50000 dari batch eksplisit, TANPA payment"
KEY_D=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"items\":[{\"product_id\":$VOUCHER_ID,\"batch_id\":$VOUCHER_BATCH,\"qty\":2,\"unit_price\":50000}]}" "$KEY_D")
check "d1 create sale tanpa payment 201" 201 "$CODE" "$(body)"
SALE_D=$(jqv id < /tmp/r.json)
check "d2 payment_status UNPAID" "UNPAID" "$(jqv payment_status < /tmp/r.json)"
check "d3 total 100000" "100000" "$(jqv total_amount < /tmp/r.json)"
check "d4 due 100000" "100000" "$(jqv due_amount < /tmp/r.json)"
check "d5 payments kosong" "0" "$(jqv payments.length < /tmp/r.json)"

step "d) DP 25000 CASH -> PARTIAL"
KEY_DP=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales/$SALE_D/payments" "{\"method_id\":$CASH_ID,\"amount\":25000,\"tendered_amount\":25000}" "$KEY_DP")
check "d6 payment DP 201" 201 "$CODE" "$(body)"
check "d7 payment_status PARTIAL" "PARTIAL" "$(jqv sale.payment_status < /tmp/r.json)"
check "d8 paid 25000" "25000" "$(jqv sale.paid_amount < /tmp/r.json)"
check "d9 due 75000" "75000" "$(jqv sale.due_amount < /tmp/r.json)"

step "d) pelunasan 75000 BANK_TRANSFER -> PAID"
KEY_PE=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales/$SALE_D/payments" "{\"method_id\":$BANK_ID,\"amount\":75000,\"reference_no\":\"TEST-TRF-001\"}" "$KEY_PE")
check "d10 pelunasan 201" 201 "$CODE" "$(body)"
check "d11 payment_status PAID" "PAID" "$(jqv sale.payment_status < /tmp/r.json)"
check "d12 paid 100000" "100000" "$(jqv sale.paid_amount < /tmp/r.json)"
check "d13 due 0" "0" "$(jqv sale.due_amount < /tmp/r.json)"
CODE=$(get "$API/sales/$SALE_D/payments"); check "d14 list payments 200" 200 "$CODE"
check "d15 2 baris payment" "2" "$(jlen)"

step "e) idempotency: submit 2x dengan key sama"
KEY_E=$(node -e "console.log(require('crypto').randomUUID())")
PAYLOAD="{\"items\":[{\"product_id\":$VOUCHER_ID,\"qty\":1,\"unit_price\":50000}],\"payment\":{\"method_id\":$CASH_ID,\"amount\":50000}}"
CODE1=$(post "$API/sales" "$PAYLOAD" "$KEY_E"); ID1=$(jqv id < /tmp/r.json); SALE_NO_E=$(jqv sale_no < /tmp/r.json)
CODE2=$(post "$API/sales" "$PAYLOAD" "$KEY_E"); ID2=$(jqv id < /tmp/r.json)
REPLAY=$(curl -s -D- -o /tmp/r2.json -X POST "$API/sales" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY_E" -d "$PAYLOAD" | grep -i 'idempotency-replayed' | tr -d '\r')
check "e1 submit pertama 201" 201 "$CODE1"
check "e2 submit kedua 200 (replay)" 200 "$CODE2"
check "e3 id sale sama" "$ID1" "$ID2"
contains "e4 header Idempotency-Replayed" "Idempotency-Replayed" "$REPLAY"
CODE=$(get "$API/sales?limit=200"); check "e5 daftar sales" 200 "$CODE"
SALE_COUNT=$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(a.filter(x=>x.sale_no==='$SALE_NO_E').length)})" < /tmp/r.json)
check "e6 hanya 1 transaksi untuk 1 key" "1" "$SALE_COUNT"
CODE=$(post "$API/sales" "$PAYLOAD"); check "e7 tanpa Idempotency-Key -> 400" 400 "$CODE" "$(body)"
CODE=$(post "$API/sales" "$PAYLOAD" "bukan-uuid"); check "e8 key bukan uuid -> 400" 400 "$CODE" "$(body)"

hr "FASE 3/4 - peta error DB -> HTTP"
step "f) harga jual 35000 di bawah harga beli 40000 -> 422"
KEY_F1=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"items\":[{\"product_id\":$VOUCHER_ID,\"qty\":1,\"unit_price\":35000}]}" "$KEY_F1")
check "f1 harga < beli -> 422" 422 "$CODE" "$(body)"
contains "f2 code PRICE_BELOW_COST" "PRICE_BELOW_COST" "$(jqv code < /tmp/r.json)"

step "f) qty 999 (stok hanya 2 tersisa) -> 409"
KEY_F2=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"items\":[{\"product_id\":$VOUCHER_ID,\"qty\":999,\"unit_price\":50000}]}" "$KEY_F2")
check "f3 stok tidak cukup -> 409" 409 "$CODE" "$(body)"
contains "f4 code INSUFFICIENT_STOCK" "INSUFFICIENT_STOCK" "$(jqv code < /tmp/r.json)"

step "f) overpay -> 422"
KEY_F3=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"items\":[{\"product_id\":$GULA_ID,\"qty\":0.1,\"unit_price\":15000}],\"payment\":{\"method_id\":$CASH_ID,\"amount\":999999}}" "$KEY_F3")
check "f5 overpay -> 422" 422 "$CODE" "$(body)"
contains "f6 code PAYMENT_OVER_TOTAL" "PAYMENT_OVER_TOTAL" "$(jqv code < /tmp/r.json)"

step "g) BANK_TRANSFER tanpa reference_no -> 422"
KEY_G=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"items\":[{\"product_id\":$GULA_ID,\"qty\":0.1,\"unit_price\":15000}],\"payment\":{\"method_id\":$BANK_ID,\"amount\":1500}}" "$KEY_G")
check "g1 bank transfer tanpa ref -> 422" 422 "$CODE" "$(body)"
contains "g2 code REFERENCE_NO_REQUIRED" "REFERENCE_NO_REQUIRED" "$(jqv code < /tmp/r.json)"
KEY_G2=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales/$SALE_C/payments" "{\"method_id\":$BANK_ID,\"amount\":100}" "$(node -e "console.log(require('crypto').randomUUID())")")
check "g3 payment bank tanpa ref -> 422" 422 "$CODE" "$(body)"

step "f) metode tidak aktif -> 422"
CODE=$(patch "$API/payment-methods/$EWALLET_ID" '{"is_active":false}'); check "f7 nonaktifkan metode 200" 200 "$CODE" "$(body)"
KEY_F4=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"items\":[{\"product_id\":$GULA_ID,\"qty\":0.1,\"unit_price\":15000}],\"payment\":{\"method_id\":$EWALLET_ID,\"amount\":1500}}" "$KEY_F4")
check "f8 metode nonaktif -> 422" 422 "$CODE" "$(body)"
contains "f9 code PAYMENT_METHOD_INACTIVE" "PAYMENT_METHOD_INACTIVE" "$(jqv code < /tmp/r.json)"

step "rollback: stok & tagihan utuh setelah semua error"
CODE=$(get "$API/stock?product_id=$GULA_ID"); check "f10 stok gula tak berubah" "9.75" "$(jqv 0.qty_on_hand < /tmp/r.json)"
CODE=$(get "$API/stock?product_id=$VOUCHER_ID"); check "f11 stok voucher (5-2-1)" "2" "$(jqv 0.qty_on_hand < /tmp/r.json)"
CODE=$(get "$API/sales/$SALE_C"); check "f12 sale c tetap PAID" "PAID" "$(jqv payment_status < /tmp/r.json)"

hr "FASE 5 - void / retur"
step "void sale yang sudah dibayar -> 409"
CODE=$(post "$API/sales/$SALE_C/void" '{"reason":"bayar dulu"}'); check "v1 void sale PAID -> 409" 409 "$CODE" "$(body)"
contains "v2 code VOID_NOT_ALLOWED" "VOID_NOT_ALLOWED" "$(jqv code < /tmp/r.json)"
step "void sale UNPAID -> stok kembali"
KEY_V=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"items\":[{\"product_id\":$GULA_ID,\"qty\":1,\"unit_price\":15000}]}" "$KEY_V")
check "v3 buat sale UNPAID 201" 201 "$CODE" "$(body)"
SALE_V=$(jqv id < /tmp/r.json)
CODE=$(get "$API/stock?product_id=$GULA_ID"); check "v4 stok 8.75" "8.75" "$(jqv 0.qty_on_hand < /tmp/r.json)"
CODE=$(post "$API/sales/$SALE_V/void" '{"reason":"pelanggan batal bayar"}'); check "v5 void 200" 200 "$CODE" "$(body)"
check "v6 status VOIDED" "VOIDED" "$(jqv status < /tmp/r.json)"
[[ -n "$(jqv voided_by < /tmp/r.json)" ]] && ok "v7 voided_by terisi (dari JWT)" "$(jqv voided_by < /tmp/r.json)" || bad "v7 voided_by terisi" "kosong"
CODE=$(get "$API/stock?product_id=$GULA_ID"); check "v8 stok kembali 9.75" "9.75" "$(jqv 0.qty_on_hand < /tmp/r.json)"
CODE=$(get "$API/stock/movements?product_id=$GULA_ID&type=IN&reference_type=VOID"); check "v9 movement IN void" 200 "$CODE"
check "v10 qty_change +1" "1" "$(jqv 0.qty_change < /tmp/r.json)"
CODE=$(post "$API/sales/$SALE_V/void" '{"reason":"void dua kali"}'); check "v11 void ulang -> 409" 409 "$CODE" "$(body)"
contains "v11b code TRANSITION_NOT_ALLOWED" "TRANSITION_NOT_ALLOWED" "$(jqv code < /tmp/r.json)"
CODE=$(post "$API/sales/$SALE_V/void" '{"reason":"x"}'); check "v12 reason terlalu pendek -> 400" 400 "$CODE" "$(body)"

hr "FASE 6 - opname"
CODE=$(get "$API/stock?product_id=$GULA_ID"); SYS=$(jqv 0.qty_on_hand < /tmp/r.json)
CODE=$(post "$API/opnames" "{\"note\":\"uji opname\",\"items\":[{\"product_id\":$GULA_ID,\"physical_qty\":9.5}]}")
check "v13 opname 201" 201 "$CODE" "$(body)"
check "v14 system_qty = $SYS" "$SYS" "$(jqv items.0.system_qty < /tmp/r.json)"
check "v15 difference -0.25" "-0.25" "$(jqv items.0.difference < /tmp/r.json)"
CODE=$(get "$API/stock?product_id=$GULA_ID"); check "v16 stok terkoreksi 9.5" "9.5" "$(jqv 0.qty_on_hand < /tmp/r.json)"
CODE=$(get "$API/stock/movements?product_id=$GULA_ID&type=ADJUSTMENT"); check "v17 movement ADJUSTMENT" 200 "$CODE"
check "v18 qty_change -0.25" "-0.25" "$(jqv 0.qty_change < /tmp/r.json)"
CODE=$(get "$API/opnames"); check "v19 list opname 200" 200 "$CODE"

hr "Lain-lain: filter, immutability, docs"
CODE=$(get "$API/sales?payment_status=PAID&limit=5"); check "x1 filter PAID 200" 200 "$CODE"
CODE=$(get "$API/sales?date_from=2000-01-01&date_to=2100-01-01&limit=5"); check "x2 filter tanggal 200" 200 "$CODE"
CODE=$(get "$API/sales/999999"); check "x3 sale tidak ada -> 404" 404 "$CODE"
CODE=$(get "$API/products/999999"); check "x4 produk tidak ada -> 404" 404 "$CODE"
CODE=$(get "$API/stock?expiring_in_days=30"); check "x5 filter expiring 200" 200 "$CODE"
CODE=$(get "$API/categories"); check "x6 list kategori 200" 200 "$CODE"
CODE=$(get "$API/customers"); check "x7 list customer 200" 200 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/openapi.json); check "x8 /openapi.json 200" 200 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api-docs/); check "x9 /api-docs 200" 200 "$CODE"

step "validasi body (tidak menyentuh data asli)"
CODE=$(post "$API/sales" '{"items":[]}' "$(node -e "console.log(require('crypto').randomUUID())")")
check "x10 items kosong -> 400" 400 "$CODE" "$(body)"
CODE=$(post "$API/purchases" "{\"product_id\":1,\"qty\":-5,\"unit_cost\":1}")
check "x11 qty negatif -> 400" 400 "$CODE" "$(body)"

hr "Pembersihan data uji"
step "nonaktifkan produk uji (soft delete) + nonaktifkan metode uji"
for PID in $GULA_ID $VOUCHER_ID; do
  CODE=$(curl -s -o /tmp/r.json -w '%{http_code}' -X DELETE "$API/products/$PID" -H "Authorization: Bearer $TOKEN")
  check "c1x produk $PID nonaktif" 200 "$CODE" "$(body)"
done
CODE=$(patch "$API/payment-methods/$EWALLET_ID" '{"is_active":false,"notes":"nonaktif setelah uji e2e"}')
check "c2x metode uji nonaktif" 200 "$CODE" "$(body)"

step "verifikasi data asli tidak berubah (kartu Telkomsel id=1 harus tetap 16)"
CODE=$(get "$API/stock?product_id=1"); check "c3x stok Telkomsel tetap 16" "16" "$(jqv 0.qty_on_hand < /tmp/r.json)"
CODE=$(get "$API/purchases?product_id=1"); check "c4x batch Telkomsel tetap 20/16" "16" "$(jqv 0.qty_remaining < /tmp/r.json)"

hr "RINGKASAN"
printf '  PASS: %d   FAIL: %d\n' "$PASS" "$FAIL"
if [[ $FAIL -gt 0 ]]; then printf '\n  Gagal:\n'; for f in "${FAILED[@]}"; do printf '   - %s\n' "$f"; done; exit 1; fi
printf '\n  Semua uji lulus.\n'
printf '  Data uji tersisa: produk id=%s,%s (nonaktif), sale id=%s,%s,%s,%s (tidak bisa di-DELETE).\n' "$GULA_ID" "$VOUCHER_ID" "$SALE_C" "$SALE_D" "$SALE_V" "$ID1"
