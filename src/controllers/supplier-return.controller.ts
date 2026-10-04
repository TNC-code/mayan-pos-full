import type { Request, Response } from 'express';
import * as stockService from '../services/stock.service.js';
import * as supplierReturnService from '../services/supplier-return.service.js';
import { validated } from '../middleware/validate.js';
import { asInt } from '../utils/tx.js';
import type { SupplierReturnInput, SupplierReturnSettleInput } from '../services/supplier-return.service.js';

/* ---------------------- stok rusak siap diretur (UC-B) ---------------------- */
export async function listDamagedStock(_req: Request, res: Response): Promise<void> {
  const q = validated<{ product_id?: number; q?: string; limit: number; offset: number }>(res);
  res.status(200).json(await stockService.getDamagedStock(q));
}

/* ----------------------------- retur distributor ----------------------------- */
export async function listSupplierReturns(_req: Request, res: Response): Promise<void> {
  const q = validated<{
    status?: string;
    supplier_name?: string;
    date_from?: string;
    date_to?: string;
    q?: string;
    limit: number;
    offset: number;
  }>(res);
  res.status(200).json(await supplierReturnService.listSupplierReturns(q));
}

export async function getSupplierReturn(req: Request, res: Response): Promise<void> {
  res.status(200).json(await supplierReturnService.getSupplierReturn(asInt(req.params.id!, 'id')));
}

/** POST /supplier-returns - KASIR only + WAJIB Idempotency-Key. */
export async function createSupplierReturn(req: Request, res: Response): Promise<void> {
  const { supplierReturn, replayed } = await supplierReturnService.createSupplierReturn(
    req.body as SupplierReturnInput,
    req.user!.id,
    req.idempotencyKey!,
  );
  if (replayed) {
    res.setHeader('Idempotency-Replayed', 'true');
    res.status(200).json(supplierReturn);
    return;
  }
  res.status(201).json(supplierReturn);
}

/**
 * POST /supplier-returns/{id}/settle - KASIR only + WAJIB Idempotency-Key.
 * REFUNDED (distributor bayar balik) atau WRITTEN_OFF (ditolak -> jadi opex BARANG_RUSAK).
 */
export async function settleSupplierReturn(req: Request, res: Response): Promise<void> {
  const { supplierReturn, replayed } = await supplierReturnService.settleSupplierReturn(
    asInt(req.params.id!, 'id'),
    req.body as SupplierReturnSettleInput,
    req.user!.id,
    req.idempotencyKey!,
  );
  if (replayed) {
    res.setHeader('Idempotency-Replayed', 'true');
  }
  res.status(200).json(supplierReturn);
}
