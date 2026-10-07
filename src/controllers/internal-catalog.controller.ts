import type { Request, Response } from 'express';
import { getInternalCatalog } from '../services/internal-catalog.service.js';

/**
 * GET /internal/catalog - katalog + stok untuk bot WA (WA-1).
 *
 * Auth: **hanya** `X-Internal-Key` (middleware `requireInternalKey` dipasang di routes/index.ts
 * SEBELUM `requireAuth`, jadi bot tidak perlu JWT kasir). Sengaja tidak memakai
 * `requireInternalKeyOrKasir` supaya katalog tidak bisa dibaca lewat sesi kasir pun —
 * endpoint ini hanya untuk integrasi server-to-server.
 */
export async function getCatalog(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await getInternalCatalog());
}