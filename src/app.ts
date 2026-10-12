import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { QueryTypes } from 'sequelize';
import YAML from 'yaml';
import { env } from './config/env.js';
import { sequelize } from './db/sequelize.js';
import { buildRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { rateLimit } from './middleware/rate-limit.js';

const OPENAPI_PATH = path.resolve(process.cwd(), 'openapi.yaml');

/**
 * Cache spec openapi.yaml agar tidak di-parse ulang tiap request.
 * Deteksi perubahan dengan `stat()` (murah, tanpa baca file): begitu `openapi.yaml` berubah
 * (mtime/size), file dibaca & di-parse ulang pada request berikutnya - tidak perlu restart
 * server setiap spec diedit. Perilaku menjaga yang lama: spec invalid -> cache lama tetap
 * dipakai + warning (dokumentasi tidak boleh mati gara-gara salah ketik di YAML).
 */
let openApiCache: { doc: Record<string, unknown>; mtimeMs: number; size: number } | null = null;
let openApiReloads = 0;

function loadOpenApi(): Record<string, unknown> {
  let st: fs.Stats;
  try {
    st = fs.statSync(OPENAPI_PATH);
  } catch (err) {
    // File hilang/ tidak bisa di-stat: pakai cache lama kalau ada (dokumentasi tetap hidup).
    if (openApiCache) {
      // eslint-disable-next-line no-console
      console.warn(
        `[openapi] GAGAL stat openapi.yaml (${err instanceof Error ? err.message : String(err)}); ` +
          'memakai spec lama yang sudah di-cache',
      );
      return openApiCache.doc;
    }
    throw err;
  }
  if (openApiCache && openApiCache.mtimeMs === st.mtimeMs && openApiCache.size === st.size) {
    return openApiCache.doc;
  }
  try {
    const doc = parseOpenApi(fs.readFileSync(OPENAPI_PATH, 'utf8'));
    openApiCache = { doc, mtimeMs: st.mtimeMs, size: st.size };
    if (openApiReloads > 0) {
      // eslint-disable-next-line no-console
      console.log(`[openapi] openapi.yaml berubah -> spec dimuat ulang (mtime ${st.mtime.toISOString()})`);
    }
    openApiReloads += 1;
    return doc;
  } catch (err) {
    if (openApiCache) {
      // eslint-disable-next-line no-console
      console.warn(
        `[openapi] GAGAL memuat ulang openapi.yaml (${err instanceof Error ? err.message : String(err)}); ` +
          'memakai spec lama yang sudah di-cache',
      );
      return openApiCache.doc;
    }
    throw err;
  }
}

function parseOpenApi(file: string): Record<string, unknown> {
  const doc = YAML.parse(file) as Record<string, unknown>;
  // Samakan base URL dengan env agar konsisten saat diakses dari host lain.
  const servers = Array.isArray(doc.servers) ? (doc.servers as Array<Record<string, unknown>>) : [];
  if (servers.length > 0) servers[0]!.url = `${env.basePath}`;
  return doc;
}

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // P1: rate limit global (longgar; login/refresh punya limit ketat di router).
  app.use(rateLimit('global', { windowMs: 60_000, max: 600 }));

  // Health check: ikut memverifikasi koneksi DB.
  // MP-9: query lewat Sequelize (pool `pg` mentah sudah dihapus) — hasil dan
  // bentuk response `{status, server_time_db, db{open_connections,max_connections}, uptime_sec}` tetap sama.
  app.get('/health', async (_req, res) => {
    try {
      const db = (await sequelize.query<{
        db_now: Date;
        open_connections: number;
        pool_total: number;
        pool_idle: number;
      }>(
        `SELECT now() AS db_now,
                (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS open_connections,
                (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle') AS pool_idle,
                current_setting('max_connections')::int AS pool_total`,
        { type: QueryTypes.SELECT },
      )) as unknown as Array<{
        db_now: Date;
        open_connections: number;
        pool_total: number;
        pool_idle: number;
      }>;
      res.json({
        status: 'ok',
        server_time_db: new Date(db[0]!.db_now).toISOString(),
        db: { open_connections: db[0]!.open_connections, max_connections: db[0]!.pool_total },
        uptime_sec: Math.round(process.uptime()),
      });
    } catch (err) {
      res.status(503).json({ status: 'degraded', error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Dokumentasi API langsung dari openapi.yaml (spec = sumber kebenaran).
  // Spec di-cache per mtime: /openapi.json memakai cache terbaru (mtime dicek tiap request)
  // dan swagger UI mengambil spec lewat /openapi.json, jadi keduanya ikut ter-update
  // begitu openapi.yaml diedit - tanpa restart server.
  loadOpenApi(); // validasi awal: boot gagal cepat kalau spec benar-benar rusak
  app.get('/openapi.json', (_req, res) => res.json(loadOpenApi()));
  // CATATAN: wajib app.use (bukan app.get) — app.get hanya match path persis '/api-docs'
  // sehingga aset statis di bawahnya (/api-docs/swagger-ui-bundle.js dst.) 404 -> halaman blank.
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(null as unknown as Record<string, unknown>, {
      customSiteTitle: 'POS Inventory API',
      swaggerOptions: { url: '/openapi.json' },
    }),
  );

  app.use(env.basePath, buildRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
