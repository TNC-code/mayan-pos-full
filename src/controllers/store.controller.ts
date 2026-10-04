import type { Request, Response } from 'express';
import * as storeService from '../services/store.service.js';
import { asInt } from '../utils/tx.js';
import type { StoreProfileInput } from '../services/store.service.js';

export async function getStore(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await storeService.getStoreProfile());
}

export async function updateStore(req: Request, res: Response): Promise<void> {
  res.status(200).json(await storeService.updateStoreProfile(req.body as StoreProfileInput, req.user!.id));
}

/** Nota/struk JSON lengkap (header toko + item + pembayaran) untuk dirender frontend. */
export async function saleReceipt(req: Request, res: Response): Promise<void> {
  res.status(200).json(await storeService.saleReceipt(asInt(req.params.id!, 'id')));
}
