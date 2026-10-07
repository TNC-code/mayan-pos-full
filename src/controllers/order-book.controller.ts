import type { Request, Response } from 'express';
import * as orderBookService from '../services/order-book.service.js';
import { validated } from '../middleware/validate.js';
import { asInt } from '../utils/tx.js';
import type {
  OrderBookInput,
  OrderBookInputItem,
} from '../services/order-book.service.js';

/**
 * POST /order-books - dua jalur auth (lihat middleware/internal-key.ts):
 *  - `X-Internal-Key` valid -> bot WA; `created_by` = user sistem 'bot'
 *  - JWT kasir           -> kasir membuat order manual; `created_by` = user tsb
 */
export async function createOrderBook(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    customer_phone: string;
    customer_name?: string | null;
    raw_message: string;
    note?: string | null;
    items: OrderBookInputItem[];
  };
  const input: OrderBookInput = { ...body };
  const order = await orderBookService.createOrderBook(input, req.internalCaller ? null : req.user!.id);
  res.status(201).json(order);
}

export async function listOrderBooks(_req: Request, res: Response): Promise<void> {
  const q = validated<{
    status?: string;
    date_from?: string;
    date_to?: string;
    q?: string;
    limit: number;
    offset: number;
  }>(res);
  res.status(200).json(await orderBookService.listOrderBooks(q));
}

export async function getOrderBook(req: Request, res: Response): Promise<void> {
  res.status(200).json(await orderBookService.getOrderBook(asInt(req.params.id!, 'id')));
}

/** PATCH /order-books/{id}/items/{itemId} — KASIR: pilih produk (re-snapshot harga) / ubah qty. */
export async function patchOrderBookItem(req: Request, res: Response): Promise<void> {
  res.status(200).json(
    await orderBookService.patchOrderBookItem(
      asInt(req.params.id!, 'id'),
      asInt(req.params.itemId!, 'itemId'),
      req.body as { product_id?: number | null; qty?: number },
    ),
  );
}

/** DELETE /order-books/{id}/items/{itemId} — KASIR: hapus item salah (item terakhir ditolak). */
export async function deleteOrderBookItem(req: Request, res: Response): Promise<void> {
  res.status(200).json(
    await orderBookService.deleteOrderBookItem(asInt(req.params.id!, 'id'), asInt(req.params.itemId!, 'itemId')),
  );
}

/** POST /order-books/{id}/status — KASIR: PROCESSING / CANCELLED (alasan wajib). */
export async function setOrderBookStatus(req: Request, res: Response): Promise<void> {
  const { status, reason } = req.body as { status: 'PROCESSING' | 'CANCELLED'; reason?: string | null };
  res.status(200).json(
    await orderBookService.setOrderBookStatus(
      asInt(req.params.id!, 'id'),
      status,
      reason ?? null,
      req.user!.id,
    ),
  );
}

/**
 * POST /order-books/{id}/convert — KASIR: tutup order jadi DONE setelah checkout POS.
 * Convert ulang dengan sale yang sama = 200 idempotent (FE boleh retry).
 */
export async function convertOrderBook(req: Request, res: Response): Promise<void> {
  const { sale_id: saleId } = req.body as { sale_id: number };
  const { order, alreadyDone } = await orderBookService.convertOrderBook(
    asInt(req.params.id!, 'id'),
    saleId,
    req.user!.id,
  );
  if (alreadyDone) res.setHeader('X-Idempotent-Replay', 'true');
  res.status(200).json(order);
}
