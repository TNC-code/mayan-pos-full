import { createApp } from './app.js';
import { env } from './config/env.js';
import { sequelize } from './db/sequelize.js';
import { verifySchema } from './db/check.js';
import { purgeIdempotencyKeys } from './services/idempotency.service.js';

async function main(): Promise<void> {
  // Fail fast kalau kredensial/schemanya salah.
  try {
    await sequelize.authenticate();
  } catch (err) {
    console.error('[boot] gagal terhubung ke PostgreSQL:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const schema = await verifySchema();
  if (!schema.ok) {
    console.error(
      `[boot] skema DB tidak lengkap. Tabel hilang: [${schema.missingTables}] ` +
        `Trigger hilang: [${schema.missingTriggers}] Sequence hilang: [${schema.missingSequences}] ` +
        `Kolom entitlement hilang: [${schema.missingEntitlementColumns}] store_profile id=1: ${schema.hasStoreRow}`,
    );
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[boot] POS Inventory API siap`);
    console.log(`[boot] http://localhost:${env.port}${env.basePath}`);
    console.log(`[boot] Swagger UI : http://localhost:${env.port}/api-docs`);
    console.log(`[boot] OpenAPI JSON: http://localhost:${env.port}/openapi.json`);
    console.log(`[boot] DB ${env.db.host}:${env.db.port}/${env.db.database} | pool max ${env.db.max} | env ${env.nodeEnv}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[shutdown] ${signal} diterima, menutup server...`);
    clearInterval(housekeeping);
    server.close(async () => {
      await sequelize.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  // Housekeeping: buang idempotency key yang sudah tidak mungkin di-retry (>24 jam)
  // supaya tabel tidak tumbuh tanpa batas. Tidak menyentuh data transaksi.
  const housekeeping = setInterval(() => {
    purgeIdempotencyKeys(24)
      .then((n) => {
        if (n > 0) console.log(`[housekeeping] ${n} idempotency key lama dibuang`);
      })
      .catch((err) => console.warn('[housekeeping] gagal:', err instanceof Error ? err.message : err));
  }, 6 * 60 * 60 * 1000);
  housekeeping.unref();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[boot] GAGAL:', err);
  process.exit(1);
});
