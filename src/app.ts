import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { buildRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { rateLimit } from './middleware/rate-limit.js';

const OPENAPI_PATH = path.resolve(process.cwd(), 'openapi.yaml');

function loadOpenApi(): Record<string, unknown> {
  const file = fs.readFileSync(OPENAPI_PATH, 'utf8');
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

  // Health check: ikut memverifikasi koneksi pool ke DB.
  app.get('/health', async (_req, res) => {
    try {
      const db = await pool.query<{ db_now: Date; open_connections: number; pool_total: number; pool_idle: number }>(
        `SELECT now() AS db_now,
                (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS open_connections,
                (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle') AS pool_idle,
                current_setting('max_connections')::int AS pool_total`,
      );
      res.json({
        status: 'ok',
        server_time_db: db.rows[0]?.db_now.toISOString(),
        db: { open_connections: db.rows[0]?.open_connections, max_connections: db.rows[0]?.pool_total },
        uptime_sec: Math.round(process.uptime()),
      });
    } catch (err) {
      res.status(503).json({ status: 'degraded', error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Dokumentasi API langsung dari openapi.yaml (spec = sumber kebenaran).
  const openApi = loadOpenApi();
  app.get('/openapi.json', (_req, res) => res.json(openApi));
  app.get('/api-docs', swaggerUi.serve, swaggerUi.setup(openApi, { customSiteTitle: 'POS Inventory API' }));

  app.use(env.basePath, buildRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
