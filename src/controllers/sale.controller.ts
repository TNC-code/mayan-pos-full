import type { Request, Response } from 'express';
import * as saleService from '../services/sale.service.js';
import { validated } from '../middleware/validate.js';
import { asInt } from '../utils/tx.js';
import type { SaleInput, SalePaymentInput } from '../services/sale.service.js';

/* ------------------------------- sales ------------------------------- */
export async function listSales(_req: Request, res: Response): Promise<void> {
  const q = validated<{
    date_from?: string;
    date_to?: string;
    payment_status?: string;
    status?: string;
    customer_id?: number;
    q?: string;
    include_test?: boolean;
    limit: number;
    offset: number;
  }>(res);
  res.status(200).json(await saleService.listSales(q));
}

/** POS checkout. WAJIB Idempotency-Key (dicek middleware). */
export async function createSale(req: Request, res: Response): Promise<void> {
  const { sale, replayed } = await saleService.createSale(req.body as SaleInput, req.user!.id, req.idempotencyKey!);
  if (replayed) {
    // Retry dengan key yang sama -> response tersimpan, tidak ada transaksi baru.
    res.setHeader('Idempotency-Replayed', 'true');
    res.status(200).json(sale);
    return;
  }
  res.status(201).json(sale);
}

export async function getSale(req: Request, res: Response): Promise<void> {
  res.status(200).json(await saleService.getSale(asInt(req.params.id!, 'id')));
}

/* ------------------------------ payments ------------------------------ */
export async function listPayments(req: Request, res: Response): Promise<void> {
  res.status(200).json(await saleService.listPayments(asInt(req.params.id!, 'id')));
}

export async function createPayment(req: Request, res: Response): Promise<void> {
  const { payment, sale, replayed } = await saleService.addPayment(
    asInt(req.params.id!, 'id'),
    req.body as SalePaymentInput,
    req.user!.id,
    req.idempotencyKey!,
  );
  if (replayed) {
    res.setHeader('Idempotency-Replayed', 'true');
    res.status(200).json({ payment, sale });
    return;
  }
  res.status(201).json({ payment, sale });
}

/* -------------------------- void / refund -------------------------- */
export async function voidSale(req: Request, res: Response): Promise<void> {
  const { reason } = req.body as { reason: string };
  res.status(200).json(await saleService.voidSale(asInt(req.params.id!, 'id'), reason, req.user!.id));
}

/** Retur + refund (bekerja untuk sale PAID maupun UNPAID). WAJIB Idempotency-Key. */
export async function refundSale(req: Request, res: Response): Promise<void> {
  const { reason } = req.body as { reason: string };
  const { sale, replayed } = await saleService.refundSale(
    asInt(req.params.id!, 'id'),
    reason,
    req.user!.id,
    req.idempotencyKey!,
  );
  if (replayed) {
    res.setHeader('Idempotency-Replayed', 'true');
  }
  res.status(200).json(sale);
}
