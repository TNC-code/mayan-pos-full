import type { Request, Response } from 'express';
import * as cashService from '../services/cash-session.service.js';
import { validated } from '../middleware/validate.js';
import { asInt } from '../utils/tx.js';

export async function listSessions(_req: Request, res: Response): Promise<void> {
  const q = validated<{ user_id?: number; status?: string; limit: number; offset: number }>(res);
  res.status(200).json(await cashService.listSessions(q));
}

export async function getSession(req: Request, res: Response): Promise<void> {
  res.status(200).json(await cashService.getSession(asInt(req.params.id!, 'id')));
}

export async function openSession(req: Request, res: Response): Promise<void> {
  const { opening_cash: openingCash, note } = req.body as { opening_cash: number; note?: string };
  res.status(201).json(await cashService.openSession(req.user!.id, openingCash, note));
}

export async function closeSession(req: Request, res: Response): Promise<void> {
  const { closing_cash: closingCash, note } = req.body as { closing_cash: number; note?: string };
  res.status(200).json(await cashService.closeSession(asInt(req.params.id!, 'id'), req.user!.id, closingCash, note));
}
