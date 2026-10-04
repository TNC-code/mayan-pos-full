/**
 * Uji konkurensi multi-POS (FASE 7 / "Aturan wajib aplikasi" #1-#4).
 *
 * Skenario 1 - anti-oversell: 20 request SEJAKUSAH ke batch yang sama dengan stok 10.
 *   Harinya: tepat 10 berhasil (201), 10 ditolak 409 INSUFFICIENT_STOCK, stok akhir 0.
 *   (SELECT ... FOR UPDATE di trigger fn_sale_item_validate yang menserialisasi.)
 *
 * Skenario 2 - idempotency: 8 request SEJAKUSAH dengan Idempotency-Key yang SAMA.
 *   Harinya: tepat 1 transaksi sales (1x 201 + 7x replay 200), stok berkurang 1 saja.
 *
 * Semua memakai produk uji sendiri (prefix UJI-) sehingga data asli tidak tersentuh.
 * Jalankan: npm run concurrency  (server harus sudah jalan)
 */
import { env } from '../src/config/env.js';

const API = process.env.API ?? `http://localhost:${env.port}${env.basePath}`;
const TAG = `UJIKON${Date.now().toString().slice(-6)}`;

let pass = 0;
let fail = 0;
const check = (label: string, expected: unknown, actual: unknown): void => {
  if (String(expected) === String(actual)) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${label} :: =${actual}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} :: harapan=${expected} aktual=${actual}`);
  }
};

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  idemKey?: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idemKey ? { 'Idempotency-Key': idemKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const uuid = (): string => globalThis.crypto.randomUUID();

async function main(): Promise<void> {
  console.log('\x1b[1m== UJI KONKURENSI MULTI-POS ==\x1b[0m');

  const login = await api('POST', '/auth/login', { username: 'owner', password: 'owner123' });
  if (login.status !== 200) throw new Error(`login gagal: ${login.status} ${JSON.stringify(login.json)}`);
  const token: string = login.json.token;
  console.log(`  token owner ok (id=${login.json.user.id})`);

  const methods = await api('GET', '/payment-methods', undefined, token);
  const cash = methods.json.find((m: any) => m.code === 'CASH');

  /* ---------------- Skenario 1: 20 POS jual 1 unit dari stok 10 ---------------- */
  console.log('\n-- 20 request SEJAKUSAH, stok awal 10 --');
  const prod = await api('POST', '/products', { sku: `${TAG}-A`, name: `UJI ${TAG} Anti Oversell`, unit: 'pcs', harga_beli: 10000, harga_jual: 15000 }, token);
  check('buat produk uji 201', 201, prod.status);
  const purchase = await api('POST', '/purchases', { product_id: prod.json.id, qty: 10, unit_cost: 10000 }, token);
  check('purchase 10 pcs 201', 201, purchase.status);
  check('batch qty_remaining 10', 10, purchase.json.qty_remaining);

  const CONCURRENCY = 20;
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      api('POST', '/sales', { items: [{ product_id: prod.json.id, qty: 1, unit_price: 15000 }] }, token, uuid()),
    ),
  );

  const created = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  const other = results.filter((r) => r.status !== 201 && r.status !== 409);

  check('jumlah 201 (terjual)', 10, created.length);
  check('jumlah 409 (stok kurang)', 10, conflicts.length);
  check('tidak ada error lain', 0, other.length);
  check(
    'semua 409 bercode INSUFFICIENT_STOCK',
    10,
    conflicts.filter((r) => r.json?.code === 'INSUFFICIENT_STOCK').length,
  );
  check('tidak ada 5xx', 0, results.filter((r) => r.status >= 500).length);

  const saleNos = new Set(created.map((r) => r.json.sale_no));
  check('sale_no unik per transaksi', created.length, saleNos.size);
  console.log(`  contoh sale_no: ${[...saleNos].slice(0, 4).join(', ')} ...`);

  const stockAfter = await api('GET', `/stock?product_id=${prod.json.id}`, undefined, token);
  check('stok akhir 0 (tidak pernah minus)', 0, stockAfter.json[0].qty_on_hand);

  // Rekonsiliasi: qty_remaining harus == qty_received - OUT
  const movements = await api('GET', `/stock/movements?product_id=${prod.json.id}`, undefined, token);
  const sum = movements.json
    .filter((m: any) => m.batch_id === purchase.json.id)
    .reduce((a: number, m: any) => a + Number(m.qty_change), 0);
  check('rekonsiliasi ledger = 0', 0, sum);
  check('jumlah movement = 11 (1 IN + 10 OUT)', 11, movements.json.length);

  /* ---------------- Skenario 2: idempotency saat submit bersamaan ---------------- */
  console.log('\n-- 8 request SEJAKUSAH dengan Idempotency-Key SAMA --');
  const prod2 = await api('POST', '/products', { sku: `${TAG}-B`, name: `UJI ${TAG} Idempotency`, unit: 'pcs', harga_beli: 10000, harga_jual: 15000 }, token);
  await api('POST', '/purchases', { product_id: prod2.json.id, qty: 10, unit_cost: 10000 }, token);

  const sharedKey = uuid();
  const payload = {
    items: [{ product_id: prod2.json.id, qty: 1, unit_price: 15000 }],
    payment: { method_id: cash.id, amount: 15000 },
  };
  const dup = await Promise.all(Array.from({ length: 8 }, () => api('POST', '/sales', payload, token, sharedKey)));

  const firsts = dup.filter((r) => r.status === 201);
  const replays = dup.filter((r) => r.status === 200);
  const saleIds = new Set(dup.map((r) => r.json?.id).filter(Boolean));

  check('tepat 1x 201', 1, firsts.length);
  check('7x 200 (replay)', 7, replays.length);
  check('tepat 1 id sale', 1, saleIds.size);

  const stock2 = await api('GET', `/stock?product_id=${prod2.json.id}`, undefined, token);
  check('stok berkurang tepat 1', 9, stock2.json[0].qty_on_hand);

  const payments2 = await api('GET', `/sales/${[...saleIds][0]}/payments`, undefined, token);
  check('hanya 1 payment tercatat', 1, payments2.json.length);

  /* ---------------- Kebersihan ---------------- */
  for (const id of [prod.json.id, prod2.json.id]) {
    await api('DELETE', `/products/${id}`, undefined, token);
  }
  const telkomsel = await api('GET', '/stock?product_id=1', undefined, token);
  check('stok Telkomsel asli tetap 16', 16, telkomsel.json[0].qty_on_hand);

  console.log(`\n  RINGKASAN KONKURENSI: PASS=${pass} FAIL=${fail}`);
  console.log(`  Sisa data uji: produk ${prod.json.id}, ${prod2.json.id} (nonaktif), 11 sale (tidak bisa dihapus).`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('GAGAL:', err);
  process.exit(1);
});
