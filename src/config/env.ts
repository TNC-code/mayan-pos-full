import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int());

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

const schema = z.object({
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  HOST: z.string().min(1),
  PORT: int(5432),
  APP_PORT: int(3000),
  APP_BASE_PATH: z.string().default('/api/v1'),
  DB_POOL_MAX: int(10),
  DB_SSL: bool,
  DB_STATEMENT_TIMEOUT_MS: int(15000),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET minimal 32 karakter'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  BCRYPT_ROUNDS: int(10),
  OWNER_USERNAMES: csv,
  KASIR_USERNAMES: csv,
  SEED_OWNER_PASSWORD: z.string().default('owner123'),
  SEED_KASIR_PASSWORD: z.string().default('kasir123'),
  BUSINESS_TZ: z.string().default('Asia/Jakarta'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  throw new Error(`Konfigurasi .env tidak valid:\n${detail}`);
}

const e = parsed.data;

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: e.APP_PORT,
  basePath: e.APP_BASE_PATH.replace(/\/+$/, ''),
  businessTz: e.BUSINESS_TZ,

  db: {
    host: e.HOST,
    port: e.PORT,
    database: e.POSTGRES_DB,
    user: e.POSTGRES_USER,
    password: e.POSTGRES_PASSWORD,
    max: e.DB_POOL_MAX,
    ssl: e.DB_SSL,
    statementTimeout: e.DB_STATEMENT_TIMEOUT_MS,
  },

  jwt: {
    secret: e.JWT_SECRET,
    expiresIn: e.JWT_EXPIRES_IN,
  },

  bcryptRounds: e.BCRYPT_ROUNDS,

  /**
   * Catatan: tabel `user_account` pada schema final tidak memiliki kolom role
   * (id, username, password, full_name, phone, is_active). Karena DDL dilarang,
   * role dipetakan di layer aplikasi lewat daftar username di .env.
   * Default (tidak terdaftar di mana pun) = KASIR (privilese minimum).
   */
  roles: {
    owner: e.OWNER_USERNAMES,
    kasir: e.KASIR_USERNAMES,
  },

  seed: {
    ownerPassword: e.SEED_OWNER_PASSWORD,
    kasirPassword: e.SEED_KASIR_PASSWORD,
  },
} as const;

export type Role = 'OWNER' | 'KASIR';

export function roleOf(username: string): Role {
  const u = username.trim().toLowerCase();
  if (env.roles.owner.includes(u)) return 'OWNER';
  return 'KASIR';
}
