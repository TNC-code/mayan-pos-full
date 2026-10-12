/**
 * E2E PENUH Mayan POS (MP-9.1) — satu skrip, nol dependency baru.
 *
 * Menjalankan seluruh alur nyata aplikasi terhadap server dev:
 *   auth -> master data + RBAC -> pembelian/batch/FIFO -> POS (CASH, transfer,
 *   kasbon + DP + pelunasan, idempotency, guard harga/stok, void, refund parsial)
 *   -> shift -> opname -> retur distributor + opex -> laporan OWNER
 *   -> order book (internal key, convert, replay) -> MATRIKS GATING SUBSCRIPTION
 *   -> INVARIAN pemenixuan.
 *
 * Jalankan:  npm run e2e:mayan
 *
 * CARA SERVER (paling andal = start/stop sendiri):
 *  - default            : skrip menyalakan `tsx src/server.ts` di port uji
 *                         (`E2E_PORT`, default 3999), menunggu `/health` siap,
 *                         lalu mematikan lagi di akhir. Rate limit login/refresh
 *                         (10/15 menit) selalu mulai dari nol karena proses baru.
 *  - `BASE_URL=<url>`   : skrip TIDAK menyalakan server, hanya menguji URL itu.
 *                         HATI-HATI: kalau server itu sudah dipakai login 10x
 *                         dalam 15 menit, uji auth kena 429 (bukan bug aplikasi).
 *  - `E2E_KEEP_SERVER=1`: tidak mematikan server yang disalakan skrip (debug).
 *
 * MATRIKS GATING & INVARIAN lewat `psql` (bukan API): entitlement ditulis langsung
 * ke `store_profile` untuk menguji gate, lalu state awal dipulihkan 100% di blok
 * `finally` — termasuk saat skrip gagal di tengah jalan.
 *
 * Data uji: semua nama/SKU diberi prefix `UJI-` (ikut dikenali `npm run mark-test-data`
 * & `scripts/clean_and_seed_dummy.ts`), dan penjualan yang dibuat ditandai
 * `is_test = true` supaya tidak masuk P&L produksi.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { env } from '../src/config/env.js';

/* ========================================================================== *
 * 0. Infrastruktur: pencatat hasil, HTTP client, psql, server uji
 * ========================================================================== */

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.E2E_PORT ?? 3999);
const OWN_SERVER = !process.env.BASE_URL;
const BASE_URL = (process.env.BASE_URL ?? `http://127.0.0.1:${PORT}${env.basePath}`).replace(/\/+$/, '');
const ROOT_URL = BASE_URL.replace(new RegExp(`${env.basePath}$`), '');
const TAG = `UJI-MP9-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
/** Varian TAG tanpa tanda hubung — untuk kolom yang hanya menerima huruf/angka/underscore
 *  (kode metode pembayaran & kategori opex). */
const TAG_U = TAG.replace(/-/g, '_');
const MONTH = new Intl.DateTimeFormat('en-CA', { timeZone: env.businessTz, year: 'numeric', month: '2-digit' })
  .format(new Date())
  .slice(0, 7);

type Json = Record<string, any>;

interface CaseResult {
  section: string;
  label: string;
  passed: boolean;
  info: string;
}

const results: CaseResult[] = [];
let currentSection = 'umum';

function section(title: string): void {
  currentSection = title;
  console.log(`\n\x1b[1m== ${title} ==\x1b[0m`);
}

function record(label: string, passed: boolean, info = ''): boolean {
  results.push({ section: currentSection, label, passed, info });
  if (passed) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}${info ? ` :: ${info}` : ''}`);
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${info ? ` :: ${info}` : ''}`);
  }
  return passed;
}

/** Bandingkan nilai (deep lewat JSON) — pesan jelas saat beda. */
function check(label: string, expected: unknown, actual: unknown): boolean {
  const same = JSON.stringify(expected) === JSON.stringify(actual);
  return record(label, same, same ? `= ${fmt(actual)}` : `harapan=${fmt(expected)} aktual=${fmt(actual)}`);
}

function ok(label: string, condition: boolean, info = ''): boolean {
  return record(label, condition, info);
}

function fmt(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > 300 ? `${text.slice(0, 300)}…` : String(text);
}

/* ------------------------------- HTTP client ------------------------------ */

interface Res<T = Json> {
  status: number;
  body: T;
  headers: Headers;
  replayed: boolean;
}

async function req<T = Json>(
  method: string,
  pathOrUrl: string,
  opts: { token?: string | null; idem?: string; internalKey?: string; body?: unknown } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  if (opts.internalKey) headers['X-Internal-Key'] = opts.internalKey;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE_URL}${pathOrUrl}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    status: res.status,
    body: body as T,
    headers: res.headers,
    replayed: res.headers.get('idempotency-replayed') === 'true' || res.headers.get('x-idempotent-replay') === 'true',
  };
}

/** Bentuk error kontrak API: `{ error, code, details? }`. */
function expectError<T = Json>(res: Res<T>, status: number, code: string, label: string): boolean {
  const good = res.status === status && (res.body as Json)?.code === code;
  return record(label, good, good ? `${status} ${code}` : `harapan=${status} ${code} aktual=${res.status} ${fmt(res.body)}`);
}

function expectOk<T = Json>(res: Res<T>, status: number, label: string): boolean {
  return record(label, res.status === status, res.status === status ? `${status}` : `harapan=${status} aktual=${res.status} ${fmt(res.body)}`);
}

const idem = (): string => crypto.randomUUID();

/* ---------------------------------- psql ---------------------------------- */

/**
 * Jalankan SQL lewat binary `psql` (argumen array, tanpa shell — tidak ada
 * interpolasi shell sama sekali). Password datang dari `.env` (sudah dimuat
 * oleh `src/config/env.ts`) lewat env `PGPASSWORD`.
 */
function psql(sql: string): string {
  try {
    return execFileSync(
      'psql',
      [
        '-X',
        '-q',
        '-t',
        '-A',
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        process.env.HOST ?? '',
        '-p',
        process.env.PORT ?? '5432',
        '-U',
        process.env.POSTGRES_USER ?? '',
        '-d',
        process.env.POSTGRES_DB ?? '',
        '-c',
        sql,
      ],
      { env: { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD ?? '' }, encoding: 'utf8', timeout: 30_000 },
    ).trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`psql GAGAL untuk: ${sql.slice(0, 160)}…\n${detail}`);
  }
}

/** Jalankan query dan kembalikan barisnya sebagai objek (JSON). */
function psqlRows<T = Json>(sql: string): T[] {
  const out = psql(`SELECT COALESCE(json_agg(x), '[]'::json)::text FROM (${sql}) x`);
  return out ? (JSON.parse(out) as T[]) : [];
}

function psqlNumber(sql: string): number {
  return Number(psql(sql) || 0);
}

/* --------------------------- server uji (self-host) --------------------------- */

type ChildProc = ReturnType<typeof spawn>;

let child: ChildProc | null = null;
let childLog = '';

async function startServer(): Promise<void> {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  child = spawn(bin, [path.join(ROOT, 'src', 'server.ts')], {
    cwd: ROOT,
    env: { ...process.env, APP_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => {
    childLog += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    childLog += d.toString();
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server uji langsung mati (code ${child.exitCode}):\n${childLog.slice(-2000)}`);
    }
    try {
      const res = await fetch(`${ROOT_URL}/health`);
      if (res.ok) return;
    } catch {
      /* belum siap */
    }
    await sleep(400);
  }
  throw new Error(`Server uji tidak siap dalam 60 detik:\n${childLog.slice(-2000)}`);
}

async function stopServer(): Promise<void> {
  if (!child || child.exitCode !== null) return;
  if (process.env.E2E_KEEP_SERVER === '1') {
    console.log('  (E2E_KEEP_SERVER=1 -> server uji dibiarkan hidup)');
    return;
  }
  const proc = child;
  child = null;
  proc.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (proc.exitCode === null && Date.now() < deadline) await sleep(200);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== *
 * 1. Auth
 * ========================================================================== */

interface Tokens {
  token: string;
  refresh: string;
  userId: number;
}

async function login(username: string, password: string): Promise<Res> {
  return req('POST', '/auth/login', { body: { username, password } });
}

async function authSection(): Promise<{ owner: Tokens; kasir: Tokens }> {
  section('1. AUTH (login, refresh rotasi, logout, /auth/me)');

  const ownerRes = await login('owner', env.seed.ownerPassword);
  expectOk(ownerRes, 200, 'login owner 200');
  check('owner dapat role OWNER', 'OWNER', ownerRes.body?.role);
  ok('owner dapat token + refresh_token', Boolean(ownerRes.body?.token && ownerRes.body?.refresh_token));
  const owner: Tokens = {
    token: ownerRes.body.token,
    refresh: ownerRes.body.refresh_token,
    userId: ownerRes.body?.user?.id,
  };

  const kasirRes = await login('kasir1', env.seed.kasirPassword);
  expectOk(kasirRes, 200, 'login kasir1 200');
  check('kasir dapat role KASIR', 'KASIR', kasirRes.body?.role);
  const kasir: Tokens = {
    token: kasirRes.body.token,
    refresh: kasirRes.body.refresh_token,
    userId: kasirRes.body?.user?.id,
  };

  expectError(await login('owner', 'password-salah-xyz'), 401, 'UNAUTHORIZED', 'password salah -> 401 UNAUTHORIZED');
  expectError(await req('GET', '/products'), 401, 'UNAUTHORIZED', 'tanpa token -> 401');
  const badToken = await req('GET', '/products', { token: 'token-palsu' });
  expectError(badToken, 401, 'UNAUTHORIZED', 'token ngawur -> 401');

  const meRes = await req('GET', '/auth/me', { token: owner.token });
  expectOk(meRes, 200, 'GET /auth/me 200');
  check('me.user.username', 'owner', meRes.body?.user?.username);
  ok('me.modulesreports lengkap (MP-8)', meRes.body?.modules?.reports !== undefined);
  check('me.modules.reports.active', true, meRes.body?.modules?.reports?.active);
  ok('me.account.status ada', typeof meRes.body?.account?.status === 'string', String(meRes.body?.account?.status));
  ok('me.account.trial_ends_at ada', meRes.body?.account?.trial_ends_at !== null);
  ok('me.account.paket_aktif ada (additive MP-8)', 'paket_aktif' in (meRes.body?.account ?? {}));

  // Rotasi refresh token: yang lama langsung mati, yang baru berlaku.
  const refresh1 = await req('POST', '/auth/refresh', { body: { refresh_token: kasir.refresh } });
  expectOk(refresh1, 200, 'refresh rotasi -> 200');
  ok('refresh mengembalikan token baru', Boolean(refresh1.body?.token));
  ok('refresh mengembalikan refresh_token baru (rotasi)', Boolean(refresh1.body?.refresh_token));
  const oldRefresh = kasir.refresh;
  kasir.refresh = refresh1.body?.refresh_token ?? oldRefresh;
  kasir.token = refresh1.body?.token ?? kasir.token;
  expectError(
    await req('POST', '/auth/refresh', { body: { refresh_token: oldRefresh } }),
    401,
    'UNAUTHORIZED',
    'refresh token lama dicabut -> 401',
  );

  expectOk(await req('POST', '/auth/logout', { token: kasir.token, body: { refresh_token: kasir.refresh } }), 200, 'logout 200');
  expectError(
    await req('POST', '/auth/refresh', { body: { refresh_token: kasir.refresh } }),
    401,
    'UNAUTHORIZED',
    'refresh setelah logout -> 401',
  );

  // Login ulang (token logout di atas dipakai supaya sesi bersih untuk sisa skenario).
  const kasirAgain = await login('kasir1', env.seed.kasirPassword);
  expectOk(kasirAgain, 200, 'login kasir1 (ulang) 200');
  kasir.token = kasirAgain.body.token;

  return { owner, kasir };
}

/* ========================================================================== *
 * 2. Master data + RBAC
 * ========================================================================== */

interface MasterData {
  productTypeId: number;
  categoryId: number;
  productA: number;
  productB: number;
  customerId: number;
  paymentMethodId: number;
  cashMethodId: number;
  transferMethodId: number;
  expenseId: number;
  storeFooterBefore: string | null;
}

async function masterSection(t: { owner: Tokens; kasir: Tokens }): Promise<MasterData> {
  section('2. MASTER DATA + RBAC (produk, kategori, customer, metode bayar, toko, opex)');

  const type = await req('POST', '/product-types', {
    token: t.kasir.token,
    body: { name: `${TAG} Tipe` },
  });
  expectOk(type, 201, 'POST /product-types (kasir) 201');

  const cat = await req('POST', '/categories', {
    token: t.kasir.token,
    body: { name: `${TAG} Kategori`, type_id: type.body?.id },
  });
  expectOk(cat, 201, 'POST /categories (kasir) 201');
  const categoryId = cat.body?.id as number;

  const cats = await req('GET', '/categories?active_only=true', { token: t.kasir.token });
  expectOk(cats, 200, 'GET /categories 200');
  ok('kategori baru ada di daftar', (cats.body as Json[])?.some((c) => c.id === categoryId));

  const catPatch = await req('PATCH', `/categories/${categoryId}`, {
    token: t.kasir.token,
    body: { name: `${TAG} Kategori (renamed)` },
  });
  expectOk(catPatch, 200, 'PATCH /categories/:id 200');
  check('nama kategori ter-update', `${TAG} Kategori (renamed)`, catPatch.body?.name);

  const prod = await req('POST', '/products', {
    token: t.kasir.token,
    body: {
      name: `${TAG} Produk A`,
      sku: `${TAG}-A`,
      unit: 'pcs',
      category_id: categoryId,
      harga_beli: 10_000,
      harga_jual: 12_000,
      min_stock: 1,
    },
  });
  expectOk(prod, 201, 'POST /products (kasir) 201');
  const productA = prod.body?.id as number;
  check('product.harga_beli bertipe number (kontrak openapi)', 'number', typeof prod.body?.harga_beli);
  check('product.harga_jual bertipe number (kontrak openapi)', 'number', typeof prod.body?.harga_jual);

  const prodB = await req('POST', '/products', {
    token: t.kasir.token,
    body: {
      name: `${TAG} Produk B`,
      sku: `${TAG}-B`,
      unit: 'pcs',
      category_id: categoryId,
      harga_beli: 20_000,
      harga_jual: 22_000,
    },
  });
  expectOk(prodB, 201, 'POST /products produk kedua 201');

  expectOk(await req('GET', `/products/${productA}`, { token: t.kasir.token }), 200, 'GET /products/:id 200');
  const search = await req('GET', `/products?q=${encodeURIComponent(TAG)}`, { token: t.kasir.token });
  expectOk(search, 200, 'GET /products?q= 200');
  ok('pencarian menemukan produk uji', (search.body as Json[])?.some((p) => p.id === productA));

  const patch = await req('PATCH', `/products/${productA}`, {
    token: t.kasir.token,
    body: { harga_jual: 12_500, min_stock: 2 },
  });
  expectOk(patch, 200, 'PATCH /products/:id 200');
  check('harga_jual ter-update', 12_500, patch.body?.harga_jual);

  expectError(
    await req('POST', '/products', { token: t.owner.token, body: { name: `${TAG} OWNER` } }),
    403,
    'FORBIDDEN',
    'POST /products oleh OWNER -> 403 FORBIDDEN',
  );
  expectError(
    await req('PATCH', `/products/${productA}`, { token: t.owner.token, body: { nama: 'x' } }),
    403,
    'FORBIDDEN',
    'PATCH /products oleh OWNER -> 403',
  );

  const customer = await req('POST', '/customers', {
    token: t.kasir.token,
    body: { name: `${TAG} Pembeli`, phone: '08123456789', address: 'Jl. Uji' },
  });
  expectOk(customer, 201, 'POST /customers 201');
  const customerId = customer.body?.id as number;
  expectOk(await req('GET', `/customers/${customerId}`, { token: t.kasir.token }), 200, 'GET /customers/:id 200');
  const custList = await req('GET', `/customers?q=${encodeURIComponent(TAG)}`, { token: t.kasir.token });
  expectOk(custList, 200, 'GET /customers?q= 200');
  ok('customer uji ketemu di daftar', (custList.body as Json[])?.some((c) => c.id === customerId));
  const custPatch = await req('PATCH', `/customers/${customerId}`, {
    token: t.kasir.token,
    body: { address: 'Jl. Uji 2' },
  });
  expectOk(custPatch, 200, 'PATCH /customers/:id 200');

  const methods = await req('GET', '/payment-methods', { token: t.kasir.token });
  expectOk(methods, 200, 'GET /payment-methods 200');
  const list = methods.body as Json[];
  const cash = list.find((m) => m.code === 'CASH');
  const transfer = list.find((m) => m.code === 'BANK_TRANSFER');
  ok('metode CASH & BANK_TRANSFER tersedia (seeder)', Boolean(cash && transfer), `CASH=${cash?.id} TRANSFER=${transfer?.id}`);

  const newMethod = await req('POST', '/payment-methods', {
    token: t.kasir.token,
    body: { code: `${TAG_U}_PAY`, name: `${TAG} E-Wallet`, requires_reference: true },
  });
  expectOk(newMethod, 201, 'POST /payment-methods 201');
  const methodOff = await req('PATCH', `/payment-methods/${newMethod.body?.id}`, {
    token: t.kasir.token,
    body: { is_active: false },
  });
  expectOk(methodOff, 200, 'PATCH /payment-methods/:id (nonaktif) 200');
  check('metode jadi tidak aktif', false, methodOff.body?.is_active);
  expectError(
    await req('POST', '/payment-methods', { token: t.owner.token, body: { code: `${TAG}-X`, name: 'x' } }),
    403,
    'FORBIDDEN',
    'POST /payment-methods oleh OWNER -> 403',
  );

  const store = await req('GET', '/store', { token: t.kasir.token });
  expectOk(store, 200, 'GET /store 200');
  ok('store_profile punya nama', Boolean(store.body?.name));
  const storeFooterBefore = (store.body?.receipt_footer ?? null) as string | null;
  const storePatch = await req('PATCH', '/store', {
    token: t.kasir.token,
    body: { receipt_footer: `${TAG} footer e2e` },
  });
  expectOk(storePatch, 200, 'PATCH /store (kasir) 200');
  check('receipt_footer ter-update', `${TAG} footer e2e`, storePatch.body?.receipt_footer);
  expectError(
    await req('PATCH', '/store', { token: t.owner.token, body: { name: 'x' } }),
    403,
    'FORBIDDEN',
    'PATCH /store oleh OWNER -> 403',
  );

  // Opex = OWNER penuh (amandemen FE-11).
  const expense = await req('POST', '/expenses', {
    token: t.owner.token,
    body: { category: `${TAG_U}_OPEX`, amount: 25_000, description: 'sewa uji' },
  });
  expectOk(expense, 201, 'POST /expenses (OWNER) 201');
  const expenseId = expense.body?.id as number;
  expectOk(await req('PATCH', `/expenses/${expenseId}`, { token: t.owner.token, body: { amount: 26_000 } }), 200, 'PATCH /expenses/:id 200');
  expectError(await req('GET', '/expenses', { token: t.kasir.token }), 403, 'FORBIDDEN', 'GET /expenses oleh KASIR -> 403');
  expectError(
    await req('POST', '/expenses', { token: t.kasir.token, body: { category: 'UJI', amount: 1000 } }),
    403,
    'FORBIDDEN',
    'POST /expenses oleh KASIR -> 403',
  );

  return {
    productTypeId: type.body?.id,
    categoryId,
    productA,
    productB: prodB.body?.id,
    customerId,
    paymentMethodId: newMethod.body?.id,
    cashMethodId: cash?.id,
    transferMethodId: transfer?.id,
    expenseId,
    storeFooterBefore,
  };
}

/* ========================================================================== *
 * 3. Pembelian, batch, FIFO picker, edit/top-up, sinkron harga
 * ========================================================================== */

interface StockData {
  batchA: number;
  batchB: number;
  batchB2: number;
}

async function purchaseSection(t: Tokens, m: MasterData): Promise<StockData> {
  section('3. PEMBELIAN + BATCH + PICKER FIFO + EDIT/TOP-UP + SYNC HARGA');

  const b1 = await req('POST', '/purchases', {
    token: t.token,
    body: {
      product_id: m.productA,
      qty: 10,
      unit_cost: 10_000,
      markup_type: 'AMOUNT',
      markup_value: 2_000,
      expired_date: '2027-01-31',
      supplier: `${TAG} Supplier`,
      notes: 'batch lama (FIFO pertama)',
    },
  });
  expectOk(b1, 201, 'POST /purchases batch 1 201');
  ok('batch_code bergaya GRN-', String(b1.body?.batch_code ?? '').startsWith('GRN-'), String(b1.body?.batch_code));
  check('qty_received 10', 10, b1.body?.qty_received);
  check('qty_remaining 10 (movement IN via trigger)', 10, b1.body?.qty_remaining);
  check('suggested_price = 10.000 + 2.000', 12_000, b1.body?.suggested_price);
  const batchA = b1.body?.id as number;

  const b2 = await req('POST', '/purchases', {
    token: t.token,
    body: {
      product_id: m.productA,
      qty: 5,
      unit_cost: 10_500,
      markup_type: 'PERCENT',
      markup_value: 10,
      expired_date: '2027-06-30',
      notes: 'batch terbaru (memimpin harga produk)',
    },
  });
  expectOk(b2, 201, 'POST /purchases batch 2 (terbaru) 201');
  check('suggested_price PERCENT = 10.500 x 1.1', 11_550, b2.body?.suggested_price);
  const batchB = b2.body?.id as number;

  const b3 = await req('POST', '/purchases', {
    token: t.token,
    body: { product_id: m.productB, qty: 20, unit_cost: 20_000, markup_type: 'AMOUNT', markup_value: 0 },
  });
  expectOk(b3, 201, 'POST /purchases produk kedua 201');
  const batchB2 = b3.body?.id as number;

  const prodAfterBuy = await req('GET', `/products/${m.productA}`, { token: t.token });
  check('harga_beli produk mengikuti batch TERBARU', 10_500, prodAfterBuy.body?.harga_beli);
  check('harga_jual produk mengikuti suggested_price batch terbaru', 11_550, prodAfterBuy.body?.harga_jual);

  const picker = await req('GET', `/products/${m.productA}/batches?available_only=true&qty=3`, { token: t.token });
  expectOk(picker, 200, 'GET /products/:id/batches (picker FIFO) 200');
  const pickerList = picker.body as Json[];
  check('picker: batch terlama advising', batchA, pickerList?.[0]?.id);
  check('picker: alokasi FIFO 3 pcs ke batch terlama', 3, pickerList?.[0]?.suggested_qty);
  check('picker: batch kedua dapat 0', 0, pickerList?.find((b) => b.id === batchB)?.suggested_qty);

  expectOk(await req('GET', `/purchases?product_id=${m.productA}`, { token: t.token }), 200, 'GET /purchases?product_id= 200');
  expectOk(await req('GET', `/purchases/batches/${batchA}`, { token: t.token }), 200, 'GET /purchases/batches/:id 200');

  const editQty = await req('PATCH', `/purchases/batches/${batchA}`, { token: t.token, body: { qty: 12 } });
  expectOk(editQty, 200, 'PATCH batch (koreksi qty) 200');
  check('qty_received 10 -> 12', 12, editQty.body?.qty_received);
  check('qty_remaining ikut 12', 12, editQty.body?.qty_remaining);

  const topup = await req('POST', '/purchases', {
    token: t.token,
    body: {
      product_id: m.productA,
      qty: 8,
      unit_cost: 10_000,
      markup_type: 'AMOUNT',
      markup_value: 2_000,
      merge_into_batch_id: batchA,
    },
  });
  expectOk(topup, 201, 'POST /purchases top-up (merge) 201');
  check('top-up tidak membuat batch baru', batchA, topup.body?.id);
  check('qty_received 12 + 8 = 20', 20, topup.body?.qty_received);
  check('qty_remaining 20', 20, topup.body?.qty_remaining);
  check('suggested_price tetap 12.000', 12_000, topup.body?.suggested_price);

  const topupBad = await req('POST', '/purchases', {
    token: t.token,
    body: {
      product_id: m.productA,
      qty: 5,
      unit_cost: 9_999,
      markup_type: 'AMOUNT',
      markup_value: 1_000,
      merge_into_batch_id: batchA,
    },
  });
  expectError(topupBad, 400, 'VALIDATION_ERROR', 'top-up beda harga beli -> 400');

  // Koreksi harga pada batch LAMA tidak boleh menggeser harga produk.
  const editOldCost = await req('PATCH', `/purchases/batches/${batchA}`, { token: t.token, body: { unit_cost: 9_000 } });
  expectOk(editOldCost, 200, 'PATCH batch lama (harga beli) 200');
  const prodAfterOld = await req('GET', `/products/${m.productA}`, { token: t.token });
  check('harga_beli produk TETAP dari batch terbaru', 10_500, prodAfterOld.body?.harga_beli);

  // Koreksi batch TERBARI = harga produk ikut berubah.
  const editNewCost = await req('PATCH', `/purchases/batches/${batchB}`, { token: t.token, body: { unit_cost: 11_000 } });
  expectOk(editNewCost, 200, 'PATCH batch terbaru (harga beli) 200');
  const prodAfterNew = await req('GET', `/products/${m.productA}`, { token: t.token });
  check('harga_beli produk ikut 11.000', 11_000, prodAfterNew.body?.harga_beli);
  check('harga_jual produk ikut suggested (11.000 x 1.1)', 12_100, prodAfterNew.body?.harga_jual);

  expectError(
    await req('POST', '/purchases', { token: t.token, body: { product_id: m.productA, qty: 0, unit_cost: 10_000, markup_type: 'AMOUNT', markup_value: 0 } }),
    400,
    'VALIDATION_ERROR',
    'pembelian qty 0 -> 400 VALIDATION_ERROR',
  );
  expectOk(
    await req('POST', '/purchases', { token: t.token, body: { product_id: m.productB, qty: 1, unit_cost: 20_000, markup_type: 'PERCENT', markup_value: 10 } }),
    201,
    'pembelian PERCENT-10% tetap valid (kontrol)',
  );

  return { batchA, batchB, batchB2 };
}

/* ========================================================================== *
 * 4. POS: shift open, CASH, transfer, kasbon+DP+pelunasan, guard, void, refund
 * ========================================================================== */

interface PosData {
  shiftId: number;
  saleCashId: number;
  saleTransferId: number;
  saleCreditId: number;
  saleVoidId: number;
  saleIds: number[];
  stockAfter: { remaining: number; damaged: number };
}

async function posSection(t: Tokens, m: MasterData, s: StockData): Promise<PosData> {
  section('4. POS — shift open, CASH, transfer, kasbon+DP+pelunasan, guard, void, refund parsial');

  const shift = await req('POST', '/cash-sessions/open', {
    token: t.token,
    body: { opening_cash: 100_000, note: `${TAG} shift buka` },
  });
  expectOk(shift, 201, 'POST /cash-sessions/open (kasir) 201');
  const shiftId = shift.body?.id as number;
  expectError(
    await req('POST', '/cash-sessions/open', { token: t.token, body: { opening_cash: 1 } }),
    409,
    'CONCURRENT_CONFLICT',
    'buka shift kedua saat masih OPEN -> 409',
  );

  const saleIds: number[] = [];

  /* ---- CASH ---- */
  const keyCash = idem();
  const cashBody = {
    items: [{ product_id: m.productA, batch_id: s.batchA, qty: 2, unit_price: 12_000 }],
    payment: { method_id: m.cashMethodId, amount: 24_000, tendered_amount: 25_000 },
    note: `${TAG} sale tunai`,
  };
  const cashSale = await req('POST', '/sales', { token: t.token, idem: keyCash, body: cashBody });
  expectOk(cashSale, 201, 'POST /sales CASH 201');
  check('payment_status PAID', 'PAID', cashSale.body?.payment_status);
  check('total 24.000', 24_000, cashSale.body?.total_amount);
  check('kembalian CASH 1.000', 1_000, cashSale.body?.payments?.[0]?.change_amount);
  check('snapshot HPP di sale_item', 9_000, cashSale.body?.items?.[0]?.unit_cost);
  const saleCashId = cashSale.body?.id as number;
  saleIds.push(saleCashId);

  const replayCash = await req('POST', '/sales', { token: t.token, idem: keyCash, body: cashBody });
  check('replay idempotency -> 200', 200, replayCash.status);
  ok('replay ditandai header Idempotency-Replayed', replayCash.replayed);
  check('replay mengembalikan sale yang sama', saleCashId, replayCash.body?.id);
  const saleCount = psqlNumber(`SELECT COUNT(*) FROM sales WHERE sale_no = '${cashSale.body?.sale_no}'`);
  check('replay tidak membuat sale kedua', 1, saleCount);

  expectError(
    await req('POST', '/sales', { token: t.token, body: cashBody }),
    400,
    'IDEMPOTENCY_KEY_REQUIRED',
    'tanpa Idempotency-Key -> 400',
  );
  expectError(
    await req('POST', '/sales', { token: t.token, idem: 'bukan-uuid', body: cashBody }),
    400,
    'VALIDATION_ERROR',
    'Idempotency-Key bukan UUID -> 400',
  );

  /* ---- guard harga & stok (rollback total) ---- */
  const stockBefore = psqlNumber(`SELECT qty_remaining FROM stock_batches WHERE id = ${s.batchA}`);
  const salesBefore = psqlNumber(`SELECT COUNT(*) FROM sales`);

  expectError(
    await req('POST', '/sales', {
      token: t.token,
      idem: idem(),
      body: {
        items: [{ product_id: m.productA, batch_id: s.batchA, qty: 1, unit_price: 5_000 }],
        payment: { method_id: m.cashMethodId, amount: 5_000 },
      },
    }),
    422,
    'PRICE_BELOW_COST',
    'harga jual di bawah harga beli -> 422 PRICE_BELOW_COST',
  );
  expectError(
    await req('POST', '/sales', {
      token: t.token,
      idem: idem(),
      body: {
        items: [{ product_id: m.productA, batch_id: s.batchA, qty: 9_999, unit_price: 12_000 }],
        payment: { method_id: m.cashMethodId, amount: 1000 },
      },
    }),
    409,
    'INSUFFICIENT_STOCK',
    'stok tidak cukup -> 409 INSUFFICIENT_STOCK',
  );
  check('rollback: stok batch tidak berubah', stockBefore, psqlNumber(`SELECT qty_remaining FROM stock_batches WHERE id = ${s.batchA}`));
  check('rollback: tidak ada sale baru', salesBefore, psqlNumber(`SELECT COUNT(*) FROM sales`));

  /* ---- transfer ---- */
  expectError(
    await req('POST', '/sales', {
      token: t.token,
      idem: idem(),
      body: {
        items: [{ product_id: m.productB, batch_id: s.batchB2, qty: 1, unit_price: 22_000 }],
        payment: { method_id: m.transferMethodId, amount: 22_000 },
      },
    }),
    422,
    'REFERENCE_NO_REQUIRED',
    'transfer tanpa reference_no -> 422',
  );
  const transferSale = await req('POST', '/sales', {
    token: t.token,
    idem: idem(),
    body: {
      items: [{ product_id: m.productB, batch_id: s.batchB2, qty: 1, unit_price: 22_000 }],
      payment: { method_id: m.transferMethodId, amount: 22_000, reference_no: `TRX-${TAG}-1` },
    },
  });
  expectOk(transferSale, 201, 'POST /sales transfer 201');
  check('transfer PAID', 'PAID', transferSale.body?.payment_status);
  const saleTransferId = transferSale.body?.id as number;
  saleIds.push(saleTransferId);

  /* ---- kasbon + DP + pelunasan ---- */
  expectError(
    await req('POST', '/sales', {
      token: t.token,
      idem: idem(),
      body: { items: [{ product_id: m.productA, batch_id: s.batchA, qty: 1, unit_price: 12_000 }] },
    }),
    400,
    'VALIDATION_ERROR',
    'kasbon tanpa customer -> 400',
  );

  const credit = await req('POST', '/sales', {
    token: t.token,
    idem: idem(),
    body: {
      customer_id: m.customerId,
      items: [{ product_id: m.productA, batch_id: s.batchA, qty: 3, unit_price: 12_000 }],
      note: `${TAG} kasbon + DP`,
    },
  });
  expectOk(credit, 201, 'POST /sales kasbon (tanpa bayar) 201');
  check('kasbon UNPAID', 'UNPAID', credit.body?.payment_status);
  check('piutang tercatat di customer', m.customerId, credit.body?.customer_id);
  const saleCreditId = credit.body?.id as number;
  saleIds.push(saleCreditId);

  const dp = await req('POST', `/sales/${saleCreditId}/payments`, {
    token: t.token,
    idem: idem(),
    body: { method_id: m.cashMethodId, amount: 10_000 },
  });
  expectOk(dp, 201, 'POST /sales/:id/payments (DP) 201');
  check('setelah DP -> PARTIAL', 'PARTIAL', dp.body?.sale?.payment_status);

  expectError(
    await req('POST', `/sales/${saleCreditId}/payments`, {
      token: t.token,
      idem: idem(),
      body: { method_id: m.cashMethodId, amount: 999_999 },
    }),
    422,
    'PAYMENT_OVER_TOTAL',
    'pelunasan lebih dari sisa -> 422 PAYMENT_OVER_TOTAL',
  );

  const pelunasan = await req('POST', `/sales/${saleCreditId}/payments`, {
    token: t.token,
    idem: idem(),
    body: { method_id: m.cashMethodId, amount: 26_000 },
  });
  expectOk(pelunasan, 201, 'POST /sales/:id/payments (pelunasan) 201');
  check('setelah pelunasan -> PAID', 'PAID', pelunasan.body?.sale?.payment_status);

  expectOk(await req('GET', `/sales/${saleCreditId}/payments`, { token: t.token }), 200, 'GET /sales/:id/payments 200');
  const saleDetail = await req('GET', `/sales/${saleCashId}`, { token: t.token });
  expectOk(saleDetail, 200, 'GET /sales/:id 200');
  ok('detail memuat item + pembayaran', (saleDetail.body?.items ?? []).length > 0 && (saleDetail.body?.payments ?? []).length > 0);
  expectOk(await req('GET', `/sales/${saleCashId}/receipt`, { token: t.token }), 200, 'GET /sales/:id/receipt 200');
  expectOk(await req('GET', `/sales?date_from=2000-01-01&date_to=2100-01-01&include_test=true`, { token: t.token }), 200, 'GET /sales (filter) 200');
  expectOk(await req('GET', `/stock/products/${m.productA}`, { token: t.token }), 200, 'GET /stock/products/:id 200');
  expectOk(await req('GET', '/stock', { token: t.token }), 200, 'GET /stock 200');
  expectOk(await req('GET', '/stock/movements?limit=10', { token: t.token }), 200, 'GET /stock/movements 200');

  /* ---- void ---- */
  expectError(
    await req('POST', `/sales/${saleCashId}/void`, { token: t.token, body: { reason: 'sudah dibayar' } }),
    409,
    'VOID_NOT_ALLOWED',
    'void penjualan PAID -> 409 VOID_NOT_ALLOWED',
  );

  const voidTarget = await req('POST', '/sales', {
    token: t.token,
    idem: idem(),
    body: {
      customer_id: m.customerId,
      items: [{ product_id: m.productA, batch_id: s.batchA, qty: 1, unit_price: 12_000 }],
      note: `${TAG} void`,
    },
  });
  expectOk(voidTarget, 201, 'POST /sales (target void) 201');
  const saleVoidId = voidTarget.body?.id as number;
  saleIds.push(saleVoidId);

  const beforeVoid = psqlNumber(`SELECT qty_remaining FROM stock_batches WHERE id = ${s.batchA}`);
  const voidRes = await req('POST', `/sales/${saleVoidId}/void`, { token: t.token, body: { reason: `${TAG} batal` } });
  expectOk(voidRes, 200, 'POST /sales/:id/void 200');
  check('status VOIDED', 'VOIDED', voidRes.body?.status);
  check('stok balik +1 setelah void', beforeVoid + 1, psqlNumber(`SELECT qty_remaining FROM stock_batches WHERE id = ${s.batchA}`));
  ok(
    'movement VOID tercatat di ledger',
    psqlNumber(`SELECT COUNT(*) FROM stock_movements WHERE reference_type = 'VOID' AND reference_id = ${saleVoidId}`) === 1,
  );
  expectError(
    await req('POST', `/sales/${saleVoidId}/void`, { token: t.token, body: { reason: 'coba lagi' } }),
    409,
    'TRANSITION_NOT_ALLOWED',
    'void kedua -> 409 TRANSITION_NOT_ALLOWED (bukan 500)',
  );

  /* ---- refund parsial RUSAK ---- */
  expectError(
    await req('POST', `/sales/${saleCashId}/refund`, {
      token: t.token,
      idem: idem(),
      body: { reason: 'kebanyakan', items: [{ sale_item_id: cashSale.body?.items?.[0]?.id, qty: 5, condition: 'GOOD' }] },
    }),
    422,
    'REFUND_QTY_EXCEEDED',
    'refund melebihi sisa qty -> 422 REFUND_QTY_EXCEEDED',
  );

  const damagedBefore = psqlNumber(`SELECT qty_damaged FROM stock_batches WHERE id = ${s.batchB2}`);
  const refund = await req('POST', `/sales/${saleTransferId}/refund`, {
    token: t.token,
    idem: idem(),
    body: {
      reason: `${TAG} barang rusak`,
      method_id: m.cashMethodId,
      items: [{ sale_item_id: transferSale.body?.items?.[0]?.id, qty: 1, condition: 'RUSAK' }],
    },
  });
  expectOk(refund, 200, 'POST /sales/:id/refund parsial RUSAK 200');
  check('refund amount = 22.000', 22_000, refund.body?.refunds?.[0]?.amount);
  check('sale jadi RETURNED (refund penuh)', 'RETURNED', refund.body?.status);
  check(
    'qty_damaged batch naik +1 (RUSAK)',
    damagedBefore + 1,
    psqlNumber(`SELECT qty_damaged FROM stock_batches WHERE id = ${s.batchB2}`),
  );
  ok(
    'movement RUSAK tercatat',
    psqlNumber(
      `SELECT COUNT(*) FROM stock_movements WHERE reference_type = 'RETURN' AND reference_id = ${saleTransferId} AND condition = 'RUSAK'`,
    ) === 1,
  );
  ok(
    'barang refund RUSAK tidak kembali ke qty_remaining',
    psqlNumber(`SELECT COUNT(*) FROM stock_movements WHERE reference_type = 'RETURN' AND reference_id = ${saleTransferId} AND condition = 'GOOD'`) === 0,
  );

  return {
    shiftId,
    saleCashId,
    saleTransferId,
    saleCreditId,
    saleVoidId,
    saleIds,
    stockAfter: {
      remaining: Number(psql(`SELECT qty_remaining FROM stock_batches WHERE id = ${s.batchA}`)),
      damaged: Number(psql(`SELECT qty_damaged FROM stock_batches WHERE id = ${s.batchB2}`)),
    },
  };
}

/* ========================================================================== *
 * 5. Shift: tutup + selisih kas
 * ========================================================================== */

async function shiftSection(t: { owner: Tokens; kasir: Tokens }, p: PosData): Promise<void> {
  section('5. SHIFT KASIR — tutup shift & selisih kas');

  // opening 100.000 + CASH masuk (24.000 tunai + 10.000 DP + 26.000 pelunasan)
  //           - CASH keluar (refund RUSAK 22.000)
  const expectedCash = 100_000 + 24_000 + 10_000 + 26_000 - 22_000;
  const close = await req('POST', `/cash-sessions/${p.shiftId}/close`, {
    token: t.kasir.token,
    body: { closing_cash: expectedCash - 1_000, note: `${TAG} tutup` },
  });
  expectOk(close, 200, 'POST /cash-sessions/:id/close 200');
  check('status CLOSED', 'CLOSED', close.body?.status);
  check('expected_cash = opening + CASH masuk − refund CASH', expectedCash, close.body?.expected_cash);
  check('difference = closing − expected = −1.000', -1_000, close.body?.difference);
  check('catatan tutup tersimpan', `${TAG} tutup`, close.body?.note);

  const detail = await req('GET', `/cash-sessions/${p.shiftId}`, { token: t.kasir.token });
  expectOk(detail, 200, 'GET /cash-sessions/:id 200');
  expectOk(await req('GET', '/cash-sessions?status=CLOSED', { token: t.kasir.token }), 200, 'GET /cash-sessions 200');

  expectError(
    await req('POST', `/cash-sessions/${p.shiftId}/close`, { token: t.kasir.token, body: { closing_cash: 0 } }),
    409,
    'CONCURRENT_CONFLICT',
    'tutup shift yang sudah CLOSED -> 409',
  );
  expectOk(
    await req('POST', '/cash-sessions/open', { token: t.kasir.token, body: { opening_cash: 10_000 } }),
    201,
    'buka shift lagi setelah shift lama CLOSED -> 201',
  );
  // Tutup shift kontrol tadi supaya tidak meninggalkan sesi OPEN.
  const sessions = psqlRows<{ id: number }>(
    `SELECT id FROM cash_sessions WHERE user_id = ${t.kasir.userId} AND status = 'OPEN' ORDER BY id DESC`,
  );
  for (const s of sessions) {
    await req('POST', `/cash-sessions/${s.id}/close`, { token: t.kasir.token, body: { closing_cash: 10_000 } });
  }
  expectError(
    await req('POST', '/cash-sessions/open', { token: t.owner.token, body: { opening_cash: 1_000 } }),
    403,
    'FORBIDDEN',
    'buka shift oleh OWNER -> 403 FORBIDDEN',
  );
  ok('semua sesi uji tertutup', psqlNumber(`SELECT COUNT(*) FROM cash_sessions WHERE status = 'OPEN'`) === 0);
}

/* ========================================================================== *
 * 6. Opname GOOD/RUSAK + guard
 * ========================================================================== */

async function opnameSection(t: { owner: Tokens; kasir: Tokens }, m: MasterData, s: StockData, p: PosData): Promise<number> {
  section('6. OPNAME — selisih GOOD, barang rusak, guard');

  const sysA = Number(psql(`SELECT qty_remaining FROM stock_batches WHERE id = ${s.batchA}`));
  const op1 = await req('POST', '/opnames', {
    token: t.kasir.token,
    body: {
      note: `${TAG} opname GOOD`,
      items: [{ product_id: m.productA, batch_id: s.batchA, physical_qty: sysA - 1, physical_qty_damaged: 0, cause: 'HILANG' }],
    },
  });
  expectOk(op1, 201, 'POST /opnames (selisih GOOD) 201');
  check('difference = −1', -1, op1.body?.items?.[0]?.difference);
  check('system_qty tersnapshot', sysA, op1.body?.items?.[0]?.system_qty);
  ok('nilai selisih dihitung (value_difference)', typeof op1.body?.items?.[0]?.value_difference === 'number');
  check('stok batch turun 1', sysA - 1, Number(psql(`SELECT qty_remaining FROM stock_batches WHERE id = ${s.batchA}`)));
  const opnameId = op1.body?.id as number;

  const sysDamaged = Number(psql(`SELECT qty_damaged FROM stock_batches WHERE id = ${s.batchB2}`));
  const op2 = await req('POST', '/opnames', {
    token: t.kasir.token,
    body: {
      note: `${TAG} opname RUSAK`,
      items: [
        {
          product_id: m.productB,
          batch_id: s.batchB2,
          physical_qty: Number(psql(`SELECT qty_remaining FROM stock_batches WHERE id = ${s.batchB2}`)),
          physical_qty_damaged: sysDamaged + 2,
          cause: 'RUSAK',
        },
      ],
    },
  });
  expectOk(op2, 201, 'POST /opnames (barang rusak) 201');
  check('damaged_difference = +2', 2, op2.body?.items?.[0]?.damaged_difference);
  check('qty_damaged naik +2', sysDamaged + 2, Number(psql(`SELECT qty_damaged FROM stock_batches WHERE id = ${s.batchB2}`)));
  ok(
    'movement ADJUSTMENT RUSAK tercatat',
    psqlNumber(`SELECT COUNT(*) FROM stock_movements WHERE reference_type = 'OPNAME' AND reference_id = ${op2.body?.id} AND condition = 'RUSAK'`) === 1,
  );

  const capA = Number(psql(`SELECT qty_received FROM stock_batches WHERE id = ${s.batchA}`));
  expectError(
    await req('POST', '/opnames', {
      token: t.kasir.token,
      body: { items: [{ product_id: m.productA, batch_id: s.batchA, physical_qty: capA + 100, cause: 'SALAH_HITUNG' }] },
    }),
    400,
    'VALIDATION_ERROR',
    'opname melebihi kapasitas batch -> 400',
  );
  expectError(
    await req('POST', '/opnames', {
      token: t.kasir.token,
      body: {
        items: [
          { product_id: m.productA, physical_qty: 1 },
          { product_id: m.productA, physical_qty: 2 },
        ],
      },
    }),
    400,
    'VALIDATION_ERROR',
    'produk dobel dalam satu opname -> 400',
  );

  expectOk(await req('GET', `/opnames/${opnameId}`, { token: t.kasir.token }), 200, 'GET /opnames/:id 200');
  expectOk(await req('GET', '/opnames', { token: t.kasir.token }), 200, 'GET /opnames 200');
  expectError(
    await req('POST', '/opnames', { token: t.owner.token, body: { items: [{ product_id: m.productA, physical_qty: 1 }] } }),
    403,
    'FORBIDDEN',
    'POST /opnames oleh OWNER -> 403',
  );

  return sysDamaged + 2;
}

/* ========================================================================== *
 * 7. Retur distributor + opex ter-link
 * ========================================================================== */

async function returnSection(t: { owner: Tokens; kasir: Tokens }, m: MasterData, s: StockData): Promise<void> {
  section('7. RETUR DISTRIBUTOR — create, settle REFUNDED/WRITTEN_OFF, opex ter-link');

  const damaged = await req('GET', `/stock/damaged?product_id=${m.productB}`, { token: t.kasir.token });
  expectOk(damaged, 200, 'GET /stock/damaged 200');
  ok(
    'batch rusak muncul di karantina',
    (damaged.body as Json[])?.some((d) => d.batch_id === s.batchB2 && Number(d.qty_damaged) >= 2),
  );

  const damagedBeforeRetur = Number(psql(`SELECT qty_damaged FROM stock_batches WHERE id = ${s.batchB2}`));
  const keyReturn = idem();
  const returnBody = {
    supplier_name: `${TAG} Supplier`,
    items: [{ batch_id: s.batchB2, qty: 1 }],
    note: `${TAG} retur uji`,
    is_test: true,
  };
  const ret1 = await req('POST', '/supplier-returns', { token: t.kasir.token, idem: keyReturn, body: returnBody });
  expectOk(ret1, 201, 'POST /supplier-returns 201');
  check('status awal PENDING', 'PENDING', ret1.body?.status);
  const ret1Id = ret1.body?.id as number;

  const replay = await req('POST', '/supplier-returns', { token: t.kasir.token, idem: keyReturn, body: returnBody });
  check('replay retur -> 200', 200, replay.status);
  check('replay retur mengembalikan dokumen yang sama', ret1Id, replay.body?.id);

  check(
    'movement OUT RUSAK mengurangi karantina',
    damagedBeforeRetur - 1,
    Number(psql(`SELECT qty_damaged FROM stock_batches WHERE id = ${s.batchB2}`)),
  );

  expectError(
    await req('POST', '/supplier-returns', {
      token: t.kasir.token,
      idem: idem(),
      body: { supplier_name: `${TAG} Supplier`, items: [{ batch_id: s.batchB2, qty: 999 }] },
    }),
    409,
    'DAMAGED_QTY_INSUFFICIENT',
    'retur melebihi stok rusak -> 409 DAMAGED_QTY_INSUFFICIENT',
  );

  const settle1 = await req('POST', `/supplier-returns/${ret1Id}/settle`, {
    token: t.kasir.token,
    idem: idem(),
    body: { result: 'REFUNDED', amount: 20_000, method_id: m.cashMethodId, reference_no: `RF-${TAG}` },
  });
  expectOk(settle1, 200, 'settle REFUNDED 200');
  check('status REFUNDED', 'REFUNDED', settle1.body?.status);
  check('refunded_amount 20.000', 20_000, settle1.body?.refunded_amount);
  expectError(
    await req('POST', `/supplier-returns/${ret1Id}/settle`, {
      token: t.kasir.token,
      idem: idem(),
      body: { result: 'WRITTEN_OFF', note: 'coba lagi' },
    }),
    409,
    'SUPPLIER_RETURN_SETTLED',
    'settle kedua -> 409 SUPPLIER_RETURN_SETTLED',
  );
  expectError(
    await req('POST', `/supplier-returns/${ret1Id}/settle`, {
      token: t.kasir.token,
      idem: idem(),
      body: { result: 'REFUNDED', amount: 999_999 },
    }),
    409,
    'SUPPLIER_RETURN_SETTLED',
    'settle dengan nominal berlebih -> 409 (sudah settle)',
  );

  const ret2 = await req('POST', '/supplier-returns', {
    token: t.kasir.token,
    idem: idem(),
    body: { supplier_name: `${TAG} Supplier`, items: [{ batch_id: s.batchB2, qty: 1 }], is_test: true },
  });
  expectOk(ret2, 201, 'POST /supplier-returns kedua 201');
  const ret2Id = ret2.body?.id as number;
  const settle2 = await req('POST', `/supplier-returns/${ret2Id}/settle`, {
    token: t.kasir.token,
    idem: idem(),
    body: { result: 'WRITTEN_OFF', note: `${TAG} distributor menolak` },
  });
  expectOk(settle2, 200, 'settle WRITTEN_OFF 200');
  check('status WRITTEN_OFF', 'WRITTEN_OFF', settle2.body?.status);
  const linkedOpex = psqlRows<{ id: number; amount: number; is_test: boolean }>(
    `SELECT id, amount, is_test FROM operational_expenses WHERE supplier_return_id = ${ret2Id}`,
  );
  check('opex write-off ter-link 1 baris', 1, linkedOpex.length);
  check('opex mewarisi is_test dari retur', true, linkedOpex[0]?.is_test);
  check('opex kategori BARANG_RUSAK', 'BARANG_RUSAK', psql(`SELECT category FROM operational_expenses WHERE supplier_return_id = ${ret2Id}`));

  expectOk(await req('GET', `/supplier-returns/${ret1Id}`, { token: t.kasir.token }), 200, 'GET /supplier-returns/:id 200');
  expectOk(await req('GET', '/supplier-returns?status=REFUNDED', { token: t.kasir.token }), 200, 'GET /supplier-returns 200');
  expectError(
    await req('POST', '/supplier-returns', {
      token: t.owner.token,
      idem: idem(),
      body: { supplier_name: 'x', items: [{ batch_id: s.batchB2, qty: 1 }] },
    }),
    403,
    'FORBIDDEN',
    'POST /supplier-returns oleh OWNER -> 403',
  );
}

/* ========================================================================== *
 * 8. Laporan OWNER
 * ========================================================================== */

async function reportSection(t: { owner: Tokens; kasir: Tokens }): Promise<void> {
  section('8. LAPORAN OWNER (P&L, dashboard, opname, alerts)');

  const pnl = await req('GET', `/reports/pnl?month=${MONTH}&include_test=true`, { token: t.owner.token });
  expectOk(pnl, 200, 'GET /reports/pnl 200');
  check('periode benar', MONTH, pnl.body?.period);
  ok('field lengkap (pendapatan/hpp/laba_kotor/beban/refund_distributor)', ['pendapatan', 'hpp', 'laba_kotor', 'beban_operasional', 'refund_distributor'].every((k) => k in (pnl.body ?? {})));
  check('laba_kotor = pendapatan − HPP', Number(pnl.body?.pendapatan) - Number(pnl.body?.hpp), Number(pnl.body?.laba_kotor));
  ok('angka laporan bertipe number', typeof pnl.body?.pendapatan === 'number' && typeof pnl.body?.hpp === 'number');

  const pnlProd = await req('GET', `/reports/pnl?month=${MONTH}`, { token: t.owner.token });
  expectOk(pnlProd, 200, 'GET /reports/pnl (default, data uji dikecualikan) 200');
  ok('default tidak memuat data uji', Number(pnlProd.body?.pendapatan) <= Number(pnl.body?.pendapatan));

  const dash = await req('GET', '/reports/dashboard', { token: t.owner.token });
  expectOk(dash, 200, 'GET /reports/dashboard 200');
  ok('dashboard punya blok today + top_products', 'today' in (dash.body ?? {}) && Array.isArray(dash.body?.top_products));

  const opnameReport = await req('GET', `/reports/opname?month=${MONTH}`, { token: t.owner.token });
  expectOk(opnameReport, 200, 'GET /reports/opname 200');
  ok('laporan opname punya per_cause & tren 6 bulan', Array.isArray(opnameReport.body?.per_cause) && Array.isArray(opnameReport.body?.tren_6_bulan));

  const alerts = await req('GET', '/alerts', { token: t.kasir.token });
  expectOk(alerts, 200, 'GET /alerts (semua role) 200');
  ok('alerts punya low_stock & expiring', 'low_stock' in (alerts.body ?? {}) && 'expiring' in (alerts.body ?? {}));

  const expenses = await req('GET', '/expenses?include_test=true', { token: t.owner.token });
  expectOk(expenses, 200, 'GET /expenses (OWNER) 200');
  ok('opex uji terlihat dengan include_test', (expenses.body as Json[])?.some((e) => String(e.category).includes(TAG_U)));
}

/* ========================================================================== *
 * 9. Order book (WA) + convert
 * ========================================================================== */

async function orderBookSection(t: { owner: Tokens; kasir: Tokens }, m: MasterData, s: StockData): Promise<void> {
  section('9. ORDER BOOK WA — internal key, edit item, status, convert, replay');

  const internalKey = env.internalApiKey;
  ok('INTERNAL_API_KEY tersedia di .env', Boolean(internalKey));

  // Harga snapshot order book mengikuti harga jual produk SAAT ini (yang sudah
  // ikut ter-sinkron oleh batch terbaru) — dibaca dari API, bukan ditebak.
  const hargaA = (await req('GET', `/products/${m.productA}`, { token: t.kasir.token })).body?.harga_jual;
  const hargaB = (await req('GET', `/products/${m.productB}`, { token: t.kasir.token })).body?.harga_jual;

  const order1 = await req('POST', '/order-books', {
    internalKey,
    body: {
      customer_phone: '081200011122',
      customer_name: `${TAG} Pembeli WA`,
      raw_message: `mau ${TAG} 2 pcs dan barang lain 1`,
      items: [
        { product_name: `${TAG} Produk B`, product_id: m.productB, qty: 2, match_score: 0.92 },
        { product_name: `${TAG} Barang Misterius`, qty: 1 },
      ],
    },
  });
  expectOk(order1, 201, 'POST /order-books (X-Internal-Key) 201');
  ok('order_no bergaya ORD-', String(order1.body?.order_no ?? '').startsWith('ORD-'), String(order1.body?.order_no));
  check('status awal PENDING', 'PENDING', order1.body?.status);
  check('satu item UNMATCHED', 1, order1.body?.unmatched_count);
  const orderId = order1.body?.id as number;
  const unmatchedItem = (order1.body?.items as Json[]).find((i) => i.product_id === null);

  const matchedItem = (order1.body?.items as Json[]).find((i) => i.product_id === m.productB);
  check('item matched tersnapshot harga jual produk', hargaB, matchedItem?.unit_price);

  const patch = await req('PATCH', `/order-books/${orderId}/items/${unmatchedItem?.id}`, {
    token: t.kasir.token,
    body: { product_id: m.productA, qty: 2 },
  });
  expectOk(patch, 200, 'PATCH /order-books/:id/items/:itemId 200');
  const patched = (patch.body?.items as Json[]).find((i) => i.id === unmatchedItem?.id);
  check('item jadi matched setelah dipilih produknya', true, patched?.matched);
  check('harga di-snapshot ulang setelah pilih produk', hargaA, patched?.unit_price);
  check('tidak ada item UNMATCHED lagi', 0, patch.body?.unmatched_count);

  const qtyPatch = await req('PATCH', `/order-books/${orderId}/items/${patched?.id}`, { token: t.kasir.token, body: { qty: 3 } });
  expectOk(qtyPatch, 200, 'qty item masih boleh diubah saat PENDING');
  const deleted = await req('DELETE', `/order-books/${orderId}/items/${patched?.id}`, { token: t.kasir.token });
  expectOk(deleted, 200, 'hapus 1 dari 2 item -> 200');
  const lastItem = (deleted.body?.items as Json[])[0];
  expectError(
    await req('DELETE', `/order-books/${orderId}/items/${lastItem?.id}`, { token: t.kasir.token }),
    422,
    'ORDER_LAST_ITEM',
    'hapus item terakhir ditolak -> 422 ORDER_LAST_ITEM',
  );

  expectError(
    await req('POST', '/order-books', { internalKey: 'kunci-salah', body: { customer_phone: '0812', raw_message: 'x', items: [{ product_name: 'x', qty: 1 }] } }),
    401,
    'INTERNAL_KEY_INVALID',
    'X-Internal-Key salah -> 401 (tidak jatuh ke jalur JWT)',
  );
  expectError(
    await req('GET', '/internal/catalog'),
    401,
    'INTERNAL_KEY_INVALID',
    'GET /internal/catalog tanpa kunci -> 401',
  );

  const catalog = await req('GET', '/internal/catalog', { internalKey });
  expectOk(catalog, 200, 'GET /internal/catalog (X-Internal-Key) 200');
  ok('katalog tidak pernah mengirim harga_beli', (catalog.body as Json[]).every((c) => !('harga_beli' in c)));
  ok(
    'katalog memuat produk uji + stok',
    (catalog.body as Json[]).some((c) => c.id === m.productA && Number(c.qty_on_hand) > 0),
  );

  expectOk(
    await req('POST', `/order-books/${orderId}/status`, { token: t.kasir.token, body: { status: 'PROCESSING' } }),
    200,
    'POST /order-books/:id/status (PROCESSING) 200',
  );
  check('status jadi PROCESSING', 'PROCESSING', (await req('GET', `/order-books/${orderId}`, { token: t.kasir.token })).body?.status);

  const cancelOrder = await req('POST', '/order-books', {
    internalKey,
    body: { customer_phone: '081299988877', raw_message: 'batal', items: [{ product_name: `${TAG} batal`, qty: 1 }] },
  });
  expectOk(
    await req('POST', `/order-books/${cancelOrder.body?.id}/status`, {
      token: t.kasir.token,
      body: { status: 'CANCELLED', reason: `${TAG} pelanggan batal` },
    }),
    200,
    'POST status CANCELLED + alasan 200',
  );
  expectError(
    await req('POST', `/order-books/${cancelOrder.body?.id}/convert`, { token: t.kasir.token, body: { sale_id: 1 } }),
    409,
    'ORDER_STATUS_TRANSITION',
    'convert order CANCELLED -> 409 ORDER_STATUS_TRANSITION',
  );

  // Penjualan nyata untuk order ini (kontrak: kasir checkout dulu, lalu link).
  const sale = await req('POST', '/sales', {
    token: t.kasir.token,
    idem: idem(),
    body: {
      customer_id: m.customerId,
      items: [
        { product_id: m.productB, batch_id: s.batchB2, qty: 2, unit_price: 22_000 },
        { product_id: m.productA, batch_id: s.batchA, qty: 2, unit_price: 12_000 },
      ],
      payment: { method_id: m.cashMethodId, amount: 68_000 },
      note: `${TAG} sale untuk order book`,
    },
  });
  expectOk(sale, 201, 'POST /sales untuk order book 201');
  const saleId = sale.body?.id as number;

  const convert = await req('POST', `/order-books/${orderId}/convert`, { token: t.kasir.token, body: { sale_id: saleId } });
  expectOk(convert, 200, 'POST /order-books/:id/convert 200');
  check('order jadi DONE', 'DONE', convert.body?.status);
  check('sale_id ter-link', saleId, convert.body?.sale_id);
  check('sale_no ikut tampil', sale.body?.sale_no, convert.body?.sale_no);

  const replayConvert = await req('POST', `/order-books/${orderId}/convert`, { token: t.kasir.token, body: { sale_id: saleId } });
  check('convert ulang (sale sama) -> 200 idempotent', 200, replayConvert.status);
  ok('convert ulang ditandai X-Idempotent-Replay', replayConvert.replayed);

  expectError(
    await req('PATCH', `/order-books/${orderId}/items/${lastItem?.id}`, { token: t.kasir.token, body: { qty: 5 } }),
    409,
    'ORDER_STATUS_TRANSITION',
    'edit item order DONE -> 409 ORDER_STATUS_TRANSITION',
  );

  // MP-9: satu penjualan hanya boleh menutup satu order book.
  const order2 = await req('POST', '/order-books', {
    internalKey,
    body: { customer_phone: '081277766655', raw_message: 'order kedua', items: [{ product_name: `${TAG} order 2`, qty: 1 }] },
  });
  expectOk(order2, 201, 'POST /order-books kedua 201');
  const dupeConvert = await req('POST', `/order-books/${order2.body?.id}/convert`, { token: t.kasir.token, body: { sale_id: saleId } });
  expectError(dupeConvert, 409, 'ORDER_ALREADY_DONE', 'convert order kedua ke sale yang sama -> 409 ORDER_ALREADY_DONE');
  ok(
    'pesan 409 menjelaskan satu penjualan = satu order',
    String(dupeConvert.body?.error ?? '').includes('satu penjualan hanya bisa menutup satu order book'),
    String(dupeConvert.body?.error ?? ''),
  );

  expectOk(
    await req('POST', `/order-books/${order2.body?.id}/convert`, { token: t.kasir.token, body: { sale_id: 999_999 } }),
    422,
    'convert ke sale yang tidak ada -> 422 (kontrol)',
  );
  expectOk(await req('GET', '/order-books?status=DONE', { token: t.kasir.token }), 200, 'GET /order-books?status=DONE 200');
  expectOk(await req('GET', '/order-books', { token: t.owner.token }), 200, 'GET /order-books oleh OWNER -> 200 (baca semua role)');

  // Tandai penjualan skenario order book sebagai data uji.
  psql(`UPDATE sales SET is_test = true WHERE id = ${saleId}`);
}

/* ========================================================================== *
 * 10. Matriks gating subscription (tulis/pulih lewat psql)
 * ========================================================================== */

interface StoreSnapshot {
  account_status: string;
  trial_ends_at: string | null;
  suspended_at: string | null;
  modules: Json;
}

function snapshotStore(): StoreSnapshot {
  const rows = psqlRows<StoreSnapshot>(
    `SELECT account_status, trial_ends_at, suspended_at, modules FROM store_profile WHERE id = 1`,
  );
  if (rows.length !== 1) throw new Error('store_profile id=1 tidak ditemukan — jalankan npm run db:migrate');
  return rows[0]!;
}

function restoreStore(snap: StoreSnapshot): void {
  const json = JSON.stringify({
    account_status: snap.account_status,
    trial_ends_at: snap.trial_ends_at,
    suspended_at: snap.suspended_at,
    modules: snap.modules,
  });
  psql(
    `UPDATE store_profile
        SET account_status = (j->>'account_status'),
            trial_ends_at   = NULLIF(j->>'trial_ends_at', '')::timestamptz,
            suspended_at    = NULLIF(j->>'suspended_at', '')::timestamptz,
            modules         = j->'modules'
       FROM (SELECT '${json}'::json AS j) t
      WHERE id = 1`,
  );
}

interface ModuleGateCase {
  module: string;
  /** Endpoint yang harus 403 MODULE_NOT_ACTIVE. */
  blocked: Array<{ method: string; path: string; token?: string; internalKey?: boolean; body?: unknown; idem?: boolean }>;
  /** Endpoint di luar paket modul -> harus tetap 200. */
  allowed: Array<{ method: string; path: string; token?: string; internalKey?: boolean }>;
  price: number;
}

async function gatingSection(t: { owner: Tokens; kasir: Tokens }, snap: StoreSnapshot): Promise<void> {
  section('10. MATRIKS GATING SUBSCRIPTION (modul dicabut via psql, lalu dipulihkan)');

  const k = t.kasir;
  const cases: ModuleGateCase[] = [
    {
      module: 'reports',
      price: 35_000,
      blocked: [{ method: 'GET', path: `/reports/pnl?month=${MONTH}`, token: t.owner.token }],
      allowed: [{ method: 'GET', path: '/products', token: t.owner.token }],
    },
    {
      module: 'shift',
      price: 25_000,
      blocked: [
        { method: 'POST', path: '/cash-sessions/open', token: k.token, body: { opening_cash: 1000 } },
        // Tutup shift juga digate; sesi uji sudah ditutup semua, jadi cukup buka.
      ],
      // Daftar/detail shift sengaja TIDAK digate (dipakai layar kasir monitoring).
      allowed: [
        { method: 'GET', path: '/products', token: k.token },
        { method: 'GET', path: '/cash-sessions', token: k.token },
      ],
    },
    {
      module: 'wa_order',
      price: 75_000,
      blocked: [
        { method: 'GET', path: '/order-books', token: k.token },
        { method: 'GET', path: '/internal/catalog', internalKey: true },
        { method: 'POST', path: '/order-books', internalKey: true, body: { customer_phone: '0812', raw_message: 'x', items: [{ product_name: 'x', qty: 1 }] } },
      ],
      allowed: [{ method: 'GET', path: '/products', token: k.token }],
    },
    {
      module: 'retur',
      price: 25_000,
      blocked: [
        { method: 'GET', path: '/supplier-returns', token: k.token },
        { method: 'POST', path: '/supplier-returns', token: k.token, body: { supplier_name: 'x', items: [{ batch_id: 1, qty: 1 }] } },
      ],
      allowed: [{ method: 'GET', path: '/stock/damaged', token: k.token }],
    },
  ];

  for (const gate of cases) {
    psql(`UPDATE store_profile SET modules = modules - '${gate.module}' WHERE id = 1`);

    for (const b of gate.blocked) {
      const res = await req(b.method, b.path, {
        token: b.token,
        internalKey: b.internalKey ? env.internalApiKey : undefined,
        body: b.body,
        idem: b.method === 'POST' && b.path === '/supplier-returns' ? idem() : undefined,
      });
      const label = `[${gate.module}] ${b.method} ${b.path} -> 403 MODULE_NOT_ACTIVE`;
      expectError(res, 403, 'MODULE_NOT_ACTIVE', label);
      check(`[${gate.module}] details.module`, gate.module, res.body?.details?.module);
      check(`[${gate.module}] details.price_monthly`, gate.price, res.body?.details?.price_monthly);
      ok(`[${gate.module}] ada meta upsell (name + description)`, Boolean(res.body?.details?.name && res.body?.details?.description));
    }

    for (const a of gate.allowed) {
      const res = await req(a.method, a.path, {
        token: a.token,
        internalKey: a.internalKey ? env.internalApiKey : undefined,
      });
      record(
        `[${gate.module}] endpoint tak terkait tetap 200: ${a.method} ${a.path}`,
        res.status === 200,
        `aktual=${res.status} ${fmt(res.body)}`,
      );
    }

    restoreStore(snap);
    const back = snapshotStore();
    check(`[${gate.module}] state modul dipulihkan`, true, Boolean(back.modules?.[gate.module]));
  }

  /* --------------------------- EXPIRED (read-only) --------------------------- */
  psql(`UPDATE store_profile SET account_status = 'EXPIRED' WHERE id = 1`);
  const expiredRead = await req('GET', '/products', { token: t.kasir.token });
  expectOk(expiredRead, 200, 'EXPIRED: GET tetap jalan (read-only)');
  const expiredWrite = await req('POST', '/products', {
    token: t.kasir.token,
    body: { name: `${TAG} EXPIRED` },
  });
  expectError(expiredWrite, 403, 'TRIAL_EXPIRED', 'EXPIRED: mutasi -> 403 TRIAL_EXPIRED');
  check('EXPIRED: details.paket.kode', 'inventaris', expiredWrite.body?.details?.paket?.code);
  const expiredReports = await req('GET', `/reports/pnl?month=${MONTH}`, { token: t.owner.token });
  expectOk(expiredReports, 200, 'EXPIRED: laporan OWNER tetap bisa dibaca');
  restoreStore(snap);

  /* ---------------------------- SUSPENDED (full block) ---------------------------- */
  psql(`UPDATE store_profile SET account_status = 'SUSPENDED', suspended_at = now() WHERE id = 1`);
  const suspendLogin = await login('kasir1', env.seed.kasirPassword);
  expectError(suspendLogin, 403, 'AKUN_SUSPENDED', 'SUSPENDED: login -> 403 AKUN_SUSPENDED');
  expectError(
    await req('GET', '/products', { token: t.kasir.token }),
    403,
    'AKUN_SUSPENDED',
    'SUSPENDED: GET -> 403 AKUN_SUSPENDED',
  );
  expectError(
    await req('POST', '/products', { token: t.kasir.token, body: { name: 'x' } }),
    403,
    'AKUN_SUSPENDED',
    'SUSPENDED: mutasi -> 403 AKUN_SUSPENDED',
  );
  expectOk(
    await req('GET', '/auth/me', { token: t.kasir.token }),
    200,
    'SUSPENDED: /auth/me tetap 200 (app bisa baca status & logout)',
  );
  expectError(
    await req('GET', '/internal/catalog', { internalKey: env.internalApiKey }),
    403,
    'AKUN_SUSPENDED',
    'SUSPENDED: jalur bot (internal key) ikut tertutup',
  );
  restoreStore(snap);

  const finalState = snapshotStore();
  check('state akhir: status kembali', snap.account_status, finalState.account_status);
  check('state akhir: 7 modul aktif kembali', 7, Object.keys(finalState.modules ?? {}).length);
  check('state akhir: suspended_at kembali null', null, finalState.suspended_at);
  const meAfter = await req('GET', '/auth/me', { token: t.owner.token });
  check('state akhir: /auth/me melaporkan TRIAL', 'TRIAL', meAfter.body?.account?.status);
}

/* ========================================================================== *
 * 11. Invariant pemenixuan (psql)
 * ========================================================================== */

async function invariantSection(): Promise<void> {
  section('11. INVARIANT PEMENIXUAN (psql)');

  const ledgerMismatch = psqlRows<{ id: number; batch_code: string; good: number; damaged: number; qty_remaining: number; qty_damaged: number }>(
    `WITH agg AS (
       SELECT batch_id,
              COALESCE(SUM(qty_change) FILTER (WHERE condition = 'GOOD'), 0)  AS good,
              COALESCE(SUM(qty_change) FILTER (WHERE condition = 'RUSAK'), 0) AS damaged
         FROM stock_movements
        GROUP BY batch_id
     )
     SELECT b.id, b.batch_code, a.good, a.damaged, b.qty_remaining, b.qty_damaged
       FROM stock_batches b
       LEFT JOIN agg a ON a.batch_id = b.id
      WHERE COALESCE(a.good, 0) <> b.qty_remaining
         OR COALESCE(a.damaged, 0) <> b.qty_damaged`,
  );
  check('ledger: Σ qty_change GOOD = qty_remaining (0 mismatch)', 0, ledgerMismatch.length);
  check('ledger: Σ qty_change RUSAK = qty_damaged (0 mismatch)', 0, ledgerMismatch.length);

  const underpaid = psqlRows<{ id: number; sale_no: string }>(
    `SELECT s.id, s.sale_no
       FROM sales s
      WHERE s.payment_status = 'PAID'
        AND s.total_amount > COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.sale_id = s.id), 0)`,
  );
  check('tidak ada sale PAID kurang bayar', 0, underpaid.length);

  const orphanOrders = psqlRows<{ id: number }>(`SELECT id FROM order_books WHERE status = 'DONE' AND sale_id IS NULL`);
  check('order DONE tanpa sale_id = 0', 0, orphanOrders.length);

  const dupOrderSale = psqlRows<{ sale_id: number }>(
    `SELECT sale_id FROM order_books WHERE sale_id IS NOT NULL GROUP BY sale_id HAVING COUNT(*) > 1`,
  );
  check('satu penjualan menutup maksimal satu order book', 0, dupOrderSale.length);

  const orphanMovements = psqlNumber(
    `SELECT COUNT(*) FROM stock_movements m
      WHERE (m.reference_type = 'SALE' AND NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = m.reference_id))
         OR (m.reference_type = 'OPNAME' AND NOT EXISTS (SELECT 1 FROM stock_opnames o WHERE o.id = m.reference_id))
         OR (m.reference_type = 'SUPPLIER_RETURN' AND NOT EXISTS (SELECT 1 FROM supplier_returns r WHERE r.id = m.reference_id))`,
  );
  check('tidak ada movement yatim (SALE/OPNAME/SUPPLIER_RETURN)', 0, orphanMovements);

  const openSessions = psqlNumber(`SELECT COUNT(*) FROM cash_sessions WHERE status = 'OPEN'`);
  check('tidak ada shift uji tertinggal OPEN', 0, openSessions);
}

/* ========================================================================== *
 * Orchestrator
 * ========================================================================== */

async function main(): Promise<void> {
  console.log(`\x1b[1mE2E Mayan POS (MP-9)\x1b[0m`);
  console.log(`  base URL : ${BASE_URL} ${OWN_SERVER ? '(server dijalankan oleh skrip)' : '(dari BASE_URL)'}`);
  console.log(`  data uji : ${TAG} · bulan laporan ${MONTH}`);
  console.log(`  DB       : ${process.env.HOST}:${process.env.PORT}/${process.env.POSTGRES_DB}`);

  const snap = snapshotStore();
  console.log(`  state awal store_profile: ${snap.account_status}, ${Object.keys(snap.modules ?? {}).length} modul`);

  let m: MasterData | null = null;
  let salesToMark: number[] = [];

  try {
    if (OWN_SERVER) {
      await startServer();
    }

    const auth = await authSection();
    m = await masterSection(auth);

    const stock = await purchaseSection(auth.kasir, m);
    const pos = await posSection(auth.kasir, m, stock);
    salesToMark = [...pos.saleIds];

    await shiftSection(auth, pos);
    await opnameSection(auth, m, stock, pos);
    await returnSection(auth, m, stock);
    await reportSection(auth);
    await orderBookSection(auth, m, stock);
    await gatingSection(auth, snap);
    await invariantSection();

    /* ------------------------------ housekeeping ------------------------------ */
    section('12. HOUSEKEEPING (data uji & state akhir)');
    if (salesToMark.length > 0) {
      psql(`UPDATE sales SET is_test = true WHERE id = ANY(ARRAY[${salesToMark.join(',')}]::bigint[])`);
      check('penjualan skenario ditandai is_test=true', salesToMark.length, psqlNumber(
        `SELECT COUNT(*) FROM sales WHERE id = ANY(ARRAY[${salesToMark.join(',')}]::bigint[]) AND is_test = true`,
      ));
    }
    psql(`UPDATE sales SET is_test = true WHERE note ILIKE '${TAG}%' OR note ILIKE '%${TAG}%'`);
    // Opex manual yang dibuat skrip ini juga data uji (`POST /expenses` tidak menerima
    // flag `is_test` — hanya harness internal yang bisa), jadi ditandai lewat SQL.
    if (m?.expenseId) {
      psql(`UPDATE operational_expenses SET is_test = true WHERE id = ${m.expenseId}`);
      check(
        'opex skenario ditandai is_test=true',
        1,
        psqlNumber(`SELECT COUNT(*) FROM operational_expenses WHERE id = ${m.expenseId} AND is_test = true`),
      );
    }
    const footer = psql(`SELECT COALESCE(receipt_footer, '') FROM store_profile WHERE id = 1`);
    if (m && m.storeFooterBefore !== null) {
      psql(`UPDATE store_profile SET receipt_footer = ${quoteLiteral(m.storeFooterBefore)} WHERE id = 1`);
      check('receipt_footer toko dipulihkan', m.storeFooterBefore, footer);
    } else if (footer.includes(TAG)) {
      psql(`UPDATE store_profile SET receipt_footer = NULL WHERE id = 1`);
      ok('receipt_footer uji dibersihkan', true);
    }
    // Produk uji di-soft-delete (ledger tetap utuh) supaya tidak mencemarikan daftar produk.
    if (m) {
      await req('DELETE', `/products/${m.productA}`, { token: auth.kasir.token });
      await req('DELETE', `/products/${m.productB}`, { token: auth.kasir.token });
      ok(
        'produk uji di-soft-delete (is_active=false)',
        psqlNumber(`SELECT COUNT(*) FROM product WHERE id IN (${m.productA}, ${m.productB}) AND is_active = false`) === 2,
      );
    }
  } catch (err) {
    record('skrip e2e selesai tanpa exception', false, err instanceof Error ? err.message : String(err));
  } finally {
    // Pulihkan state store_profile apa pun yang terjadi (gating matrix, exception, Ctrl-C).
    try {
      restoreStore(snap);
      const restored = snapshotStore();
      record(
        'state store_profile dipulihkan (TRIAL + 7 modul)',
        restored.account_status === snap.account_status && Object.keys(restored.modules ?? {}).length === Object.keys(snap.modules ?? {}).length,
        `${restored.account_status} · ${Object.keys(restored.modules ?? {}).length} modul`,
      );
    } catch (err) {
      record('state store_profile dipulihkan', false, err instanceof Error ? err.message : String(err));
    }
    await stopServer();
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  section('RINGKASAN');
  const bySection = new Map<string, { pass: number; fail: number }>();
  for (const r of results) {
    const agg = bySection.get(r.section) ?? { pass: 0, fail: 0 };
    if (r.passed) agg.pass += 1;
    else agg.fail += 1;
    bySection.set(r.section, agg);
  }
  for (const [name, agg] of bySection) {
    const line = `  ${agg.fail === 0 ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mGAGAL\x1b[0m'} ${name.padEnd(52)} ${agg.pass} PASS / ${agg.fail} FAIL`;
    console.log(line);
  }
  if (failed > 0) {
    console.log('\n  \x1b[31mKasus gagal:\x1b[0m');
    for (const r of results.filter((x) => !x.passed)) {
      console.log(`   - [${r.section}] ${r.label} :: ${r.info}`);
    }
  }
  console.log(`\n\x1b[1mTOTAL: ${passed} PASS / ${failed} FAIL\x1b[0m`);
  process.exitCode = failed === 0 ? 0 : 1;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

void main();