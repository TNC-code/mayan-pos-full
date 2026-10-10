import type { Request, Response } from 'express';
import * as purchaseService from '../services/purchase.service.js';
import * as stockService from '../services/stock.service.js';
import { validated } from '../middleware/validate.js';
import { asInt } from '../utils/tx.js';
import type { PurchaseInput } from '../services/purchase.service.js';
import type { MovementRow, ProductStockRow } from '../services/stock.service.js';

/* ----------------------------- purchases ----------------------------- */
export async function listPurchases(_req: Request, res: Response): Promise<void> {
  const q = validated<{ product_id?: number; q?: string; active_only?: boolean; limit: number; offset: number }>(res);
  res.status(200).json(await purchaseService.listBatches(q));
}

export async function createPurchase(req: Request, res: Response): Promise<void> {
  const batch = await purchaseService.createPurchase(req.body as PurchaseInput, req.user!.id);
  res.status(201).json(batch);
}

/** Koreksi salah input barang masuk: `PATCH /purchases/batches/{id}` (KASIR only). */
export async function updateBatch(req: Request, res: Response): Promise<void> {
  const batch = await purchaseService.updateBatch(
    asInt(req.params.id!, 'id'),
    req.body as purchaseService.BatchUpdateInput,
    req.user!.id,
  );
  res.status(200).json(batch);
}

export async function getBatch(req: Request, res: Response): Promise<void> {
  res.status(200).json(await purchaseService.getBatch(asInt(req.params.id!, 'id')));
}

/** Picker batch layar kasir: `GET /products/{id}/batches` (baruplan.md req #1).
 *  `qty` opsional → sertakan `suggested_qty` (alokasi FIFO dari server). */
export async function listProductBatches(req: Request, res: Response): Promise<void> {
  const q = validated<{ available_only: boolean; qty?: number | null }>(res);
  res.status(200).json(await purchaseService.listProductBatches(asInt(req.params.id!, 'id'), q.available_only, q.qty ?? null));
}

/* ------------------------------- stock ------------------------------- */
export async function listStock(_req: Request, res: Response): Promise<void> {
  const q = validated<{
    product_id?: number;
    q?: string;
    category_id?: number;
    active_only?: boolean;
    expiring_in_days?: number;
    in_stock_only?: boolean;
    limit: number;
    offset: number;
  }>(res);
  res.status(200).json(await stockService.getStock(q));
}

export async function getProductStock(req: Request, res: Response): Promise<void> {
  res.status(200).json(await stockService.getProductStock(asInt(req.params.id!, 'id')));
}

export async function listMovements(_req: Request, res: Response): Promise<void> {
  const q = validated<{
    product_id?: number;
    batch_id?: number;
    type?: string;
    reference_type?: string;
    reference_id?: number;
    limit: number;
    offset: number;
  }>(res);
  res.status(200).json(await stockService.listMovements(q));
}

export type { MovementRow, ProductStockRow };
