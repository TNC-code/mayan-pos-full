import type { Request, Response } from 'express';
import * as paymentMethodService from '../services/payment-method.service.js';
import { validated } from '../middleware/validate.js';
import { asInt } from '../utils/tx.js';

/** Menu "set payment method" - semua role boleh melihat, OWNER yang mengubah. */
export async function listPaymentMethods(_req: Request, res: Response): Promise<void> {
  const { active_only } = validated<{ active_only: boolean }>(res);
  res.status(200).json(await paymentMethodService.listPaymentMethods(active_only === true));
}

export async function getPaymentMethod(req: Request, res: Response): Promise<void> {
  res.status(200).json(await paymentMethodService.getPaymentMethod(asInt(req.params.id!, 'id')));
}

export async function createPaymentMethod(req: Request, res: Response): Promise<void> {
  res.status(201).json(await paymentMethodService.createPaymentMethod(req.body));
}

export async function updatePaymentMethod(req: Request, res: Response): Promise<void> {
  res.status(200).json(await paymentMethodService.updatePaymentMethod(asInt(req.params.id!, 'id'), req.body));
}
