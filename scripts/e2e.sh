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
OWNER_TOKEN=$(jqv token < /tmp/r.json)
TOKEN=$OWNER_TOKEN
check "a2 role OWNER" "OWNER" "$(jqv role < /tmp/r.json)"
[[ -n "$OWNER_TOKEN" ]] && ok "a3 token ada" "${OWNER_TOKEN:0:25}..." || bad "a3 token ada" "kosong"

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
CODE=$(get "$API/auth/me"); check "a10 auth/me kasir 200" 200 "$CODE"
SAVED=$TOKEN; TOKEN=$KASIR_TOKEN
CODE=$(get "$API/auth/me"); check "a10b auth/me kasir 200" 200 "$CODE"
check "a11 auth/me role KASIR" "KASIR" "$(jqv user.role < /tmp/r.json)"
TOKEN=$OWNER_TOKEN
CODE=$(get "$API/auth/me"); check "a12 auth/me owner 200" 200 "$CODE"
check "a13 auth/me role OWNER" "OWNER" "$(jqv user.role < /tmp/r.json)"
TOKEN=$SAVED

# RBAC v2: semua mutasi = KASIR (operator), semua laporan = OWNER (monitor).
# Mulai fase kerja, token default diganti ke kasir.
TOKEN=$KASIR_TOKEN

# Rekaman stok produk produksi (id=1) SEBELUM uji, untuk cek regresi berbasis delta
# (toleran bila ada klien lain yang kebetulan memakai produk yang sama).
P1_BEFORE=$(get "$API/stock?product_id=1" >/dev/null; jqv 0.qty_on_hand < /tmp/r.json)

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
check "b8 kasir create method 201" 201 "$CODE" "$(body)"
EWALLET_ID=$(jqv id < /tmp/r.json)
CODE=$(post "$API/payment-methods" '{"code":"EWALLET","name":"duplikat"}')
if [[ "$CODE" == "409" ]]; then ok "b9 kode metode unik -> 409" "$(jqv code < /tmp/r.json)"; else bad "b9 kode metode unik -> 409" "aktual=$CODE $(body)"; fi
CODE=$(post "$API/payment-methods" '{"code":"kode nakal!","name":"invalid"}'); check "b9b kode format salah -> 400" 400 "$CODE" "$(body)"
# RBAC v2: input metode bayar = kasir; OWNER read-only -> 403.
SAVED=$TOKEN; TOKEN=$OWNER_TOKEN
CODE=$(post "$API/payment-methods" '{"code":"OTHER","name":"TEST Other"}'); check "b10 owner create method -> 403" 403 "$CODE" "$(body)"
TOKEN=$SAVED
CODE=$(get "$API/payment-methods"); check "b11 kasir boleh list method 200" 200 "$CODE"

step "b) customer uji (wajib untuk sale kasbon/UNPAID)"
CODE=$(post "$API/customers" "{\"name\":\"TEST Customer $RUN_TAG\",\"phone\":\"08120000$RUN_TAG\",\"owner_name\":\"TEST pemilik\"}")
check "b12a create customer 201" 201 "$CODE" "$(body)"
CUST_ID=$(jqv id < /tmp/r.json)
[[ -n "$CUST_ID" ]] && ok "b12b customer id ada" "$CUST_ID" || bad "b12b customer id ada" "kosong"

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
CODE=$(post "$API/sales" "{\"customer_id\":$CUST_ID,\"items\":[{\"product_id\":$VOUCHER_ID,\"batch_id\":$VOUCHER_BATCH,\"qty\":2,\"unit_price\":50000}]}" "$KEY_D")
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
CODE=$(post "$API/sales" "{\"customer_id\":$CUST_ID,\"items\":[{\"product_id\":$VOUCHER_ID,\"qty\":1,\"unit_price\":35000}]}" "$KEY_F1")
check "f1 harga < beli -> 422" 422 "$CODE" "$(body)"
contains "f2 code PRICE_BELOW_COST" "PRICE_BELOW_COST" "$(jqv code < /tmp/r.json)"

step "f) qty 999 (stok hanya 2 tersisa) -> 409"
KEY_F2=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"customer_id\":$CUST_ID,\"items\":[{\"product_id\":$VOUCHER_ID,\"qty\":999,\"unit_price\":50000}]}" "$KEY_F2")
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
CODE=$(post "$API/sales" "{\"customer_id\":$CUST_ID,\"items\":[{\"product_id\":$GULA_ID,\"qty\":1,\"unit_price\":15000}]}" "$KEY_V")
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
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${API%/api/v1}/openapi.json"); check "x8 /openapi.json 200" 200 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${API%/api/v1}/api-docs/"); check "x9 /api-docs 200" 200 "$CODE"

step "validasi body (tidak menyentuh data asli)"
CODE=$(post "$API/sales" '{"items":[]}' "$(node -e "console.log(require('crypto').randomUUID())")")
check "x10 items kosong -> 400" 400 "$CODE" "$(body)"
step "kasbon tanpa customer -> 400 (piutang wajib atas nama)"
KEY_X12=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"items\":[{\"product_id\":$GULA_ID,\"qty\":0.1,\"unit_price\":15000}]}" "$KEY_X12")
check "x12 kasbon tanpa customer_id -> 400" 400 "$CODE" "$(body)"
contains "x13 code VALIDATION_ERROR" "VALIDATION_ERROR" "$(jqv code < /tmp/r.json)"
contains "x14 pesan menyebut customer_id" "customer_id" "$(jqv details.0.message < /tmp/r.json)"
CODE=$(post "$API/purchases" "{\"product_id\":1,\"qty\":-5,\"unit_cost\":1}")
check "x11 qty negatif -> 400" 400 "$CODE" "$(body)"

# ============================================================
#                  BACKEND v2 - UC A / C / D / B
#   Sequencing (penting, stok & rusak dipakai bersama):
#     UC-A  refund parsial RUSAK  -> damaged gula = 1
#     UC-C  void condition campuran-> damaged gula = 3 (total)
#     UC-D  opname detail (good -0.5, damaged -1) -> damaged gula = 2
#     UC-B  retur distributor x2 (REFUNDED lalu WRITTEN_OFF) -> damaged = 0
# ============================================================

hr "UC-A - refund parsial barang rusak (nota PAID)"
step "A) jual 3 kg gula @15000, CASH lunas"
KEY_A0=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"note\":\"UC-A\",\"items\":[{\"product_id\":$GULA_ID,\"qty\":3,\"unit_price\":15000}],\"payment\":{\"method_id\":$CASH_ID,\"amount\":45000,\"tendered_amount\":45000}}" "$KEY_A0")
check "A1 create sale PAID 201" 201 "$CODE" "$(body)"
SALE_A=$(jqv id < /tmp/r.json); ITEM_A=$(jqv items.0.id < /tmp/r.json)
CODE=$(get "$API/stock?product_id=$GULA_ID"); check "A2 stok 6.5" "6.5" "$(jqv 0.qty_on_hand < /tmp/r.json)"

step "A) refund 1 pcs RUSAK (uang kembali 15000, kartu masuk karantina)"
KEY_A1=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales/$SALE_A/refund" "{\"reason\":\"kartu rusak\",\"items\":[{\"sale_item_id\":$ITEM_A,\"qty\":1,\"condition\":\"RUSAK\"}]}" "$KEY_A1")
check "A3 refund parsial 200" 200 "$CODE" "$(body)"
check "A4 refunded_amount 15000" "15000" "$(jqv refunded_amount < /tmp/r.json)"
check "A5 status masih COMPLETED (parsial)" "COMPLETED" "$(jqv status < /tmp/r.json)"
check "A6 refund_items condition RUSAK" "RUSAK" "$(jqv refund_items.0.condition < /tmp/r.json)"
check "A7 refund_items qty 1" "1" "$(jqv refund_items.0.qty < /tmp/r.json)"
check "A8 refund_items subtotal 15000" "15000" "$(jqv refund_items.0.subtotal < /tmp/r.json)"
CODE=$(get "$API/stock?product_id=$GULA_ID")
check "A9 qty_on_hand 6.5 (RUSAK TIDAK masuk stok jual)" "6.5" "$(jqv 0.qty_on_hand < /tmp/r.json)"
check "A10 qty_damaged 1 (karantina)" "1" "$(jqv 0.qty_damaged < /tmp/r.json)"
CODE=$(get "$API/stock/movements?product_id=$GULA_ID&reference_type=RETURN&condition=RUSAK")
check "A11 movement IN RUSAK tercatat" 200 "$CODE"
check "A12 qty_change +1 condition RUSAK" "1" "$(jqv 0.qty_change < /tmp/r.json)"
contains "A13 note movement menandai rusak" "rusak" "$(jqv 0.note < /tmp/r.json)"

step "A) refund melebihi sisa qty -> 422 REFUND_QTY_EXCEEDED"
KEY_A2=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales/$SALE_A/refund" "{\"reason\":\"minta kelebihan\",\"items\":[{\"sale_item_id\":$ITEM_A,\"qty\":5,\"condition\":\"GOOD\"}]}" "$KEY_A2")
check "A14 refund melebihi sisa -> 422" 422 "$CODE" "$(body)"
contains "A15 code REFUND_QTY_EXCEEDED" "REFUND_QTY_EXCEEDED" "$(jqv code < /tmp/r.json)"

step "A) refund penuh (tanpa items) -> sisa 30000, status RETURNED"
KEY_A3=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales/$SALE_A/refund" '{"reason":"sisa retur dalam kondisi baik"}' "$KEY_A3")
check "A16 refund penuh 200" 200 "$CODE" "$(body)"
check "A17 refunded_amount 45000 (15000 + 30000)" "45000" "$(jqv refunded_amount < /tmp/r.json)"
check "A18 status RETURNED" "RETURNED" "$(jqv status < /tmp/r.json)"
CODE=$(get "$API/stock?product_id=$GULA_ID")
check "A19 qty_on_hand 8.5 (2 GOOD balik ke stok jual)" "8.5" "$(jqv 0.qty_on_hand < /tmp/r.json)"
check "A20 qty_damaged tetap 1" "1" "$(jqv 0.qty_damaged < /tmp/r.json)"

hr "UC-C - void dengan condition campuran"
step "C) jual 2 gula + 1 voucher TANPA payment (UNPAID)"
KEY_C2=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/sales" "{\"note\":\"UC-C\",\"customer_id\":$CUST_ID,\"items\":[{\"product_id\":$GULA_ID,\"qty\":2,\"unit_price\":15000},{\"product_id\":$VOUCHER_ID,\"qty\":1,\"unit_price\":50000}]}" "$KEY_C2")
check "C1 create sale UNPAID 201" 201 "$CODE" "$(body)"
SALE_C2=$(jqv id < /tmp/r.json)
IT_C1=$(jqv items.0.id < /tmp/r.json); IT_C2=$(jqv items.1.id < /tmp/r.json)
CODE=$(get "$API/stock?product_id=$VOUCHER_ID"); check "C2 stok voucher 1" "1" "$(jqv 0.qty_on_hand < /tmp/r.json)"

step "C) void: gula RUSAK + voucher GOOD (label & kolom stok harus berbeda)"
CODE=$(post "$API/sales/$SALE_C2/void" "{\"reason\":\"barang rusak saat terima\",\"items\":[{\"sale_item_id\":$IT_C1,\"condition\":\"RUSAK\"},{\"sale_item_id\":$IT_C2,\"condition\":\"GOOD\"}]}")
check "C3 void berlabel 200" 200 "$CODE" "$(body)"
check "C4 status VOIDED" "VOIDED" "$(jqv status < /tmp/r.json)"
CODE=$(get "$API/stock?product_id=$GULA_ID")
check "C5 qty_on_hand 6.5 (2 RUSAK -> karantina)" "6.5" "$(jqv 0.qty_on_hand < /tmp/r.json)"
check "C6 qty_damaged 3" "3" "$(jqv 0.qty_damaged < /tmp/r.json)"
CODE=$(get "$API/stock?product_id=$VOUCHER_ID")
check "C7 stok voucher balik 2 (1 GOOD)" "2" "$(jqv 0.qty_on_hand < /tmp/r.json)"
check "C8 qty_damaged voucher 0" "0" "$(jqv 0.qty_damaged < /tmp/r.json)"
CODE=$(get "$API/stock/movements?product_id=$GULA_ID&reference_type=VOID&condition=RUSAK&reference_id=$SALE_C2")
check "C9 movement VOID RUSAK ada" 200 "$CODE"
check "C10 1 movement RUSAK" "1" "$(jlen)"
check "C11 qty_change +2 condition RUSAK" "2" "$(jqv 0.qty_change < /tmp/r.json)"
contains "C12 label note barang rusak" "rusak" "$(jqv 0.note < /tmp/r.json)"
CODE=$(get "$API/stock/movements?product_id=$VOUCHER_ID&reference_type=VOID&condition=GOOD&reference_id=$SALE_C2")
check "C13 movement VOID GOOD voucher ada" 200 "$CODE"
check "C14 qty_change +1 condition GOOD" "1" "$(jqv 0.qty_change < /tmp/r.json)"
check "C15 label note barang baik" "Void penjualan" "$(jqv 0.note < /tmp/r.json)"

hr "UC-D - opname detail (selisih GOOD + RUSAK, cause, nilai Rp)"
step "D) opname gula: fisik 6 (sistem 6.5) + rusak fisik 2 (sistem 3)"
CODE=$(get "$API/stock?product_id=$GULA_ID")
check "D1 sistem GOOD 6.5" "6.5" "$(jqv 0.qty_on_hand < /tmp/r.json)"
check "D2 sistem RUSAK 3" "3" "$(jqv 0.qty_damaged < /tmp/r.json)"
CODE=$(post "$API/opnames" "{\"note\":\"UC-D opname detail\",\"items\":[{\"product_id\":$GULA_ID,\"physical_qty\":6,\"physical_qty_damaged\":2,\"cause\":\"RUSAK\"}]}")
check "D3 opname detail 201" 201 "$CODE" "$(body)"
OPNAME_D=$(jqv id < /tmp/r.json)
check "D4 system_qty 6.5" "6.5" "$(jqv items.0.system_qty < /tmp/r.json)"
check "D5 difference -0.5" "-0.5" "$(jqv items.0.difference < /tmp/r.json)"
check "D6 system_qty_damaged 3" "3" "$(jqv items.0.system_qty_damaged < /tmp/r.json)"
check "D7 physical_qty_damaged 2" "2" "$(jqv items.0.physical_qty_damaged < /tmp/r.json)"
check "D8 damaged_difference -1" "-1" "$(jqv items.0.damaged_difference < /tmp/r.json)"
check "D9 cause RUSAK" "RUSAK" "$(jqv items.0.cause < /tmp/r.json)"
check "D10 unit_cost 10000" "10000" "$(jqv items.0.unit_cost < /tmp/r.json)"
check "D11 value_difference -5000" "-5000" "$(jqv items.0.value_difference < /tmp/r.json)"
check "D12 value_difference_damaged -10000" "-10000" "$(jqv items.0.value_difference_damaged < /tmp/r.json)"
check "D13 value_difference_total -15000" "-15000" "$(jqv items.0.value_difference_total < /tmp/r.json)"
check "D14 header total_value_difference -15000" "-15000" "$(jqv total_value_difference < /tmp/r.json)"
check "D15 header total_loss_value 15000" "15000" "$(jqv total_loss_value < /tmp/r.json)"
CODE=$(get "$API/stock?product_id=$GULA_ID")
check "D16 stok terkoreksi 6" "6" "$(jqv 0.qty_on_hand < /tmp/r.json)"
check "D17 rusak terkoreksi 2" "2" "$(jqv 0.qty_damaged < /tmp/r.json)"
CODE=$(get "$API/stock/movements?product_id=$GULA_ID&type=ADJUSTMENT&condition=RUSAK&reference_id=$OPNAME_D")
check "D18 movement ADJUSTMENT RUSAK opname ini" 200 "$CODE"
check "D19 tepat 1 movement RUSAK" "1" "$(jlen)"
check "D20 qty_change -1 (barang rusak berkurang)" "-1" "$(jqv 0.qty_change < /tmp/r.json)"
CODE=$(get "$API/stock/movements?product_id=$GULA_ID&type=ADJUSTMENT&condition=GOOD&reference_id=$OPNAME_D")
check "D21 movement ADJUSTMENT GOOD opname ini" 200 "$CODE"
check "D22 qty_change -0.5" "-0.5" "$(jqv 0.qty_change < /tmp/r.json)"
CODE=$(get "$API/opnames/$OPNAME_D"); check "D23 detail opname 200" 200 "$CODE"
check "D24 detail kembali value_difference -15000" "-15000" "$(jqv total_value_difference < /tmp/r.json)"
check "D25 detail kembali cause RUSAK" "RUSAK" "$(jqv items.0.cause < /tmp/r.json)"

hr "UC-B - retur distributor (settle REFUNDED & WRITTEN_OFF)"
step "B) daftar stok rusak siap diretur"
CODE=$(get "$API/stock/damaged?product_id=$GULA_ID"); check "B1 /stock/damaged 200" 200 "$CODE"
check "B2 batch tercantum" "$GULA_BATCH" "$(jqv 0.batch_id < /tmp/r.json)"
check "B3 qty_damaged 2" "2" "$(jqv 0.qty_damaged < /tmp/r.json)"

step "B) buat retur #1 dari 1 pcs rusak -> PENDING, qty_damaged berkurang"
KEY_B1=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/supplier-returns" "{\"supplier_name\":\"TEST-Distributor $RUN_TAG\",\"items\":[{\"batch_id\":$GULA_BATCH,\"qty\":1}]}" "$KEY_B1")
check "B4 create retur 201" 201 "$CODE" "$(body)"
SR1=$(jqv id < /tmp/r.json)
contains "B5 return_no RTR-YYYYMMDD-NNN" "RTR-" "$(jqv return_no < /tmp/r.json)"
check "B6 status PENDING" "PENDING" "$(jqv status < /tmp/r.json)"
check "B7 total_cost 10000" "10000" "$(jqv total_cost < /tmp/r.json)"
check "B8 item condition RUSAK" "RUSAK" "$(jqv items.0.condition < /tmp/r.json)"
# supplier_name berprefiks TEST- supaya 'mark-test-data' bisa menandai retur uji secara deterministik.
contains "B8b supplier_name prefiks TEST- (determinisme mark-test-data)" "TEST-" "$(jqv supplier_name < /tmp/r.json)"
# Default retur = produksi (is_test false) -> baru ditandai mark-test-data di akhir skrip.
check "B8c is_test default false" "false" "$(jqv is_test < /tmp/r.json)"
CODE=$(get "$API/stock?product_id=$GULA_ID")
check "B9 qty_damaged 1" "1" "$(jqv 0.qty_damaged < /tmp/r.json)"
CODE=$(get "$API/stock/movements?product_id=$GULA_ID&reference_type=SUPPLIER_RETURN")
check "B10 movement OUT SUPPLIER_RETURN" 200 "$CODE"
check "B11 qty_change -1 condition RUSAK" "-1" "$(jqv 0.qty_change < /tmp/r.json)"
CODE=$(get "$API/supplier-returns"); check "B12 list retur 200" 200 "$CODE"

step "B) retur melebihi stok rusak -> 409 DAMAGED_QTY_INSUFFICIENT"
KEY_B2=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/supplier-returns" "{\"supplier_name\":\"TEST-Distributor $RUN_TAG\",\"items\":[{\"batch_id\":$GULA_BATCH,\"qty\":99}]}" "$KEY_B2")
check "B13 retur melebihi rusak -> 409" 409 "$CODE" "$(body)"
contains "B14 code DAMAGED_QTY_INSUFFICIENT" "DAMAGED_QTY_INSUFFICIENT" "$(jqv code < /tmp/r.json)"

step "B) settle REFUNDED (distributor bayar balik 10000)"
KEY_B3=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/supplier-returns/$SR1/settle" "{\"result\":\"REFUNDED\",\"amount\":10000,\"method_id\":$CASH_ID,\"reference_no\":\"TEST-TRF-B1\",\"note\":\"uang masuk dari distributor\"}" "$KEY_B3")
check "B15 settle REFUNDED 200" 200 "$CODE" "$(body)"
check "B16 status REFUNDED" "REFUNDED" "$(jqv status < /tmp/r.json)"
check "B17 refunded_amount 10000" "10000" "$(jqv refunded_amount < /tmp/r.json)"
[[ -n "$(jqv refunded_at < /tmp/r.json)" ]] && ok "B18 refunded_at terisi" "$(jqv refunded_at < /tmp/r.json)" || bad "B18 refunded_at terisi" "kosong"
check "B19 write_off_expense null" "" "$(jqv write_off_expense < /tmp/r.json)"

step "B) settle kedua -> 409 SUPPLIER_RETURN_SETTLED"
KEY_B4=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/supplier-returns/$SR1/settle" '{"result":"WRITTEN_OFF"}' "$KEY_B4")
check "B20 settle ulang -> 409" 409 "$CODE" "$(body)"
contains "B21 code SUPPLIER_RETURN_SETTLED" "SUPPLIER_RETURN_SETTLED" "$(jqv code < /tmp/r.json)"

step "B) retur #2 -> WRITTEN_OFF = opex BARANG_RUSAK otomatis"
KEY_B5=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/supplier-returns" "{\"supplier_name\":\"TEST-Distributor $RUN_TAG\",\"items\":[{\"batch_id\":$GULA_BATCH,\"qty\":1}]}" "$KEY_B5")
check "B22 create retur #2 201" 201 "$CODE" "$(body)"
SR2=$(jqv id < /tmp/r.json)
KEY_B6=$(node -e "console.log(require('crypto').randomUUID())")
CODE=$(post "$API/supplier-returns/$SR2/settle" '{"result":"WRITTEN_OFF","note":"distributor menolak barang"}' "$KEY_B6")
check "B23 settle WRITTEN_OFF 200" 200 "$CODE" "$(body)"
check "B24 status WRITTEN_OFF" "WRITTEN_OFF" "$(jqv status < /tmp/r.json)"
check "B25 opex otomatis dibuat" "true" "$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(!!JSON.parse(s).write_off_expense))" < /tmp/r.json)"
check "B26 opex kategori BARANG_RUSAK" "BARANG_RUSAK" "$(jqv write_off_expense.category < /tmp/r.json)"
check "B27 opex amount = total_cost" "10000" "$(jqv write_off_expense.amount < /tmp/r.json)"
check "B28 opex source SUPPLIER_RETURN" "SUPPLIER_RETURN" "$(jqv write_off_expense.source < /tmp/r.json)"
check "B29 opex ter-link ke retur" "$SR2" "$(jqv write_off_expense.supplier_return_id < /tmp/r.json)"
# Opex write-off mewarisi tanda retur (T9): retur produksi -> opex produksi.
check "B29b opex write-off mewarisi is_test retur" "false" "$(jqv write_off_expense.is_test < /tmp/r.json)"
CODE=$(get "$API/stock?product_id=$GULA_ID"); check "B30 qty_damaged habis (0)" "0" "$(jqv 0.qty_damaged < /tmp/r.json)"

hr "P&L & laporan (OWNER only)"
MONTH=$(TZ=Asia/Jakarta date +%Y-%m)
SAVED=$TOKEN; TOKEN=$OWNER_TOKEN
CODE=$(get "$API/reports/pnl?month=$MONTH"); check "P1 P&L OWNER 200" 200 "$CODE"
check "P2 refund_distributor muncul" "true" "$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(typeof JSON.parse(s).refund_distributor==='number'))" < /tmp/r.json)"
P_REFUND_DIST=$(jqv refund_distributor < /tmp/r.json)
[[ "$P_REFUND_DIST" -gt 0 ]] && ok "P3 refund_distributor > 0 (= retur distributor REFUNDED bulan ini)" "$P_REFUND_DIST" || bad "P3 refund_distributor > 0" "aktual=$P_REFUND_DIST"
contains "P4 catatan P&L memuat refund_distributor" "refund_distributor" "$(jqv note < /tmp/r.json)"
# T9: retur uji punya supplier_returns.is_test -> default dikecualikan, include_test=true memunculkan.
CODE=$(get "$API/reports/pnl?month=$MONTH&include_test=true"); check "P3b P&L include_test=true 200" 200 "$CODE"
P_REFUND_DIST_ALL=$(jqv refund_distributor < /tmp/r.json)
[[ "$P_REFUND_DIST_ALL" -ge "$P_REFUND_DIST" ]] && ok "P3c refund_distributor(include_test) >= default" "$P_REFUND_DIST_ALL >= $P_REFUND_DIST" || bad "P3c refund_distributor(include_test) >= default" "include=$P_REFUND_DIST_ALL default=$P_REFUND_DIST"
contains "P3d catatan P&L mode include_test" "include_test=true" "$(jqv note < /tmp/r.json)"
CODE=$(get "$API/reports/opname?month=$MONTH"); check "P5 /reports/opname OWNER 200" 200 "$CODE"
OP_ITEMS=$(jqv total.item_count < /tmp/r.json)
[[ "$OP_ITEMS" -ge 1 ]] && ok "P6 laporan opname punya item" "$OP_ITEMS" || bad "P6 laporan opname punya item" "aktual=$OP_ITEMS"
contains "P7 opname report ada kolom stok rusak" "stok_rusak_belum_diretur" "$(body)"
TOKEN=$SAVED

hr "Matriks RBAC (KASIR = operator, OWNER = monitor; opex = OWNER penuh)"
SAVED=$TOKEN; TOKEN=$KASIR_TOKEN
for P in "/reports/pnl?month=$MONTH" "/reports/dashboard" "/reports/opname?month=$MONTH" "/expenses"; do
  CODE=$(get "$API$P"); check "R1 kasir $P -> 403" 403 "$CODE"
done
CODE=$(get "$API/expenses/5"); check "R2 kasir /expenses/{id} -> 403" 403 "$CODE"
# Amandemen FE-11: pengeluaran operasional = OWNER sepenuhnya -> kasir tidak boleh
# menginput opex lagi (sebelumnya kasir boleh POST /expenses).
CODE=$(post "$API/expenses" '{"category":"TEST_RBAC","amount":1000}')
check "R3a kasir POST /expenses -> 403" 403 "$CODE" "$(body)"
CODE=$(patch "$API/expenses/5" '{"amount":1500}')
check "R3b kasir PATCH /expenses/{id} -> 403" 403 "$CODE" "$(body)"
TOKEN=$SAVED
CODE=$(post "$API/products" "{\"sku\":\"TEST-RBAC-$RUN_TAG\",\"name\":\"TEST RBAC operator\"}")
check "R4 kasir POST /products 201 (boleh input master)" 201 "$CODE" "$(body)"
PROD_RBAC=$(jqv id < /tmp/r.json)
TOKEN=$OWNER_TOKEN
CODE=$(post "$API/expenses" '{"category":"TEST_RBAC_O","amount":1000}')
check "R6a owner POST /expenses 201 (boleh input opex)" 201 "$CODE" "$(body)"
OPEX_RBAC=$(jqv id < /tmp/r.json)
CODE=$(patch "$API/expenses/$OPEX_RBAC" '{"amount":1500}')
check "R6b owner PATCH /expenses/{id} 200 (boleh koreksi opex)" 200 "$CODE" "$(body)"
check "R6c amount opex ter-update" "1500" "$(jqv amount < /tmp/r.json)"
CODE=$(post "$API/products" "{\"sku\":\"TEST-RBACO-$RUN_TAG\",\"name\":\"TEST RBAC owner\"}"); check "R5 owner POST /products -> 403" 403 "$CODE" "$(body)"
CODE=$(post "$API/purchases" '{"product_id":1,"qty":1,"unit_cost":1}'); check "R7 owner POST /purchases -> 403" 403 "$CODE" "$(body)"
CODE=$(post "$API/sales" '{"items":[]}' "$(node -e "console.log(require('crypto').randomUUID())")"); check "R8 owner POST /sales -> 403" 403 "$CODE" "$(body)"
CODE=$(post "$API/opnames" '{"items":[]}'); check "R9 owner POST /opnames -> 403" 403 "$CODE" "$(body)"
CODE=$(post "$API/supplier-returns" '{"supplier_name":"X","items":[]}' "$(node -e "console.log(require('crypto').randomUUID())")"); check "R10 owner POST /supplier-returns -> 403" 403 "$CODE" "$(body)"
CODE=$(patch "$API/store" '{"name":"x"}'); check "R11 owner PATCH /store -> 403" 403 "$CODE" "$(body)"
CODE=$(get "$API/reports/pnl?month=$MONTH"); check "R12 owner laporan P&L tetap 200" 200 "$CODE"
CODE=$(get "$API/expenses"); check "R13 owner GET /expenses 200" 200 "$CODE"
CODE=$(get "$API/products"); check "R14 owner GET /products 200 (tetap baca)" 200 "$CODE"
CODE=$(get "$API/auth/me"); check "R15 owner auth/me 200" 200 "$CODE"
TOKEN=$KASIR_TOKEN
CODE=$(get "$API/auth/me"); check "R16 kasir auth/me 200" 200 "$CODE"
CODE=$(get "$API/sales"); check "R17 kasir GET /sales 200 (semua role boleh baca)" 200 "$CODE"
CODE=$(get "$API/stock/damaged"); check "R18 kasir GET /stock/damaged 200" 200 "$CODE"
CODE=$(get "$API/payment-methods?active_only=false"); check "R19 kasir GET /payment-methods (semua) 200" 200 "$CODE"

hr "Pembersihan data uji"
step "nonaktifkan produk uji (soft delete) + nonaktifkan metode uji"
for PID in $GULA_ID $VOUCHER_ID $PROD_RBAC; do
  CODE=$(curl -s -o /tmp/r.json -w '%{http_code}' -X DELETE "$API/products/$PID" -H "Authorization: Bearer $TOKEN")
  check "c1x produk $PID nonaktif" 200 "$CODE" "$(body)"
done
CODE=$(patch "$API/payment-methods/$EWALLET_ID" '{"is_active":false,"notes":"nonaktif setelah uji e2e"}')
check "c2x metode uji nonaktif" 200 "$CODE" "$(body)"

step "tandai opex uji (R6a) supaya tidak masuk P&L produksi"
TOKEN=$OWNER_TOKEN
CODE=$(get "$API/expenses/$OPEX_RBAC"); check "c5x detail opex uji (OWNER) 200" 200 "$CODE"
TOKEN=$KASIR_TOKEN

step "verifikasi data asli tidak berubah oleh e2e ini (produk produksi id=1)"
# Delta-based: skrip ini tidak boleh mengubah stok produk produksi. Angka absolut bisa
# berubah kalau ada klien lain (mis. POS sungguhan) memakai produk yang sama.
CODE=$(get "$API/stock?product_id=1"); P1_AFTER=$(jqv 0.qty_on_hand < /tmp/r.json)
check "c3x stok produk id=1 tidak berubah oleh e2e" "$P1_BEFORE" "$P1_AFTER" "sebelum=$P1_BEFORE sesudah=$P1_AFTER"
# Batch GRN-20261004-001 searched by code (bukan index 0) supaya tahan batch lain.
CODE=$(get "$API/purchases?product_id=1")
B1_AFTER=$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s).filter(x=>x.batch_code==='GRN-20261004-001');console.log(a.length?a[0].qty_remaining:'tidak-ada')})" < /tmp/r.json)
[[ -n "$B1_AFTER" && "$B1_AFTER" != "tidak-ada" ]] && ok "c4x batch GRN-20261004-001 masih ada" "qty_remaining=$B1_AFTER" || bad "c4x batch GRN-20261004-001" "tidak ditemukan"

step "jalankan mark-test-data (tandai sale + opex uji agar tidak masuk laporan)"
if command -v npx >/dev/null 2>&1 && [[ -f scripts/mark-test-data.ts ]]; then
  MARK_OUT=$(npx tsx scripts/mark-test-data.ts 2>&1 | grep -v 'injected env')
  printf '%s\n' "$MARK_OUT" | sed 's/^/    /'
  if printf '%s' "$MARK_OUT" | grep -q 'GAGAL'; then bad "c6x mark-test-data" "gagal"; else ok "c6x mark-test-data jalan" "$(printf '%s' "$MARK_OUT" | grep -c 'is_test=true' >/dev/null && echo ok)"; fi
else
  bad "c6x mark-test-data" "npx atau skrip tidak ditemukan (cwd=$(pwd))"
fi

hr "RINGKASAN"
printf '  PASS: %d   FAIL: %d\n' "$PASS" "$FAIL"
if [[ $FAIL -gt 0 ]]; then printf '\n  Gagal:\n'; for f in "${FAILED[@]}"; do printf '   - %s\n' "$f"; done; exit 1; fi
printf '\n  Semua uji lulus.\n'
printf '  Data uji tersisa: produk id=%s,%s,%s (nonaktif), sale id=%s,%s,%s,%s,%s,%s (tidak bisa di-DELETE).\n' "$GULA_ID" "$VOUCHER_ID" "$PROD_RBAC" "$SALE_C" "$SALE_D" "$SALE_V" "$ID1" "$SALE_A" "$SALE_C2"
