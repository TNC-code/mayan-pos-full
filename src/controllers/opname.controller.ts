import type { Request, Response } from 'express';
import * as opnameService from '../services/opname.service.js';
import { validated } from '../middleware/validate.js';
import { asInt } from '../utils/tx.js';
import type { OpnameInput } from '../services/opname.service.js';

export async function listOpnames(_req: Request, res: Response): Promise<void> {
  const q = validated<{ date?: string; limit: number; offset: number }>(res);
  res.status(200).json(await opnameService.listOpnames(q));
}

export async function getOpname(req: Request, res: Response): Promise<void> {
  res.status(200).json(await opnameService.getOpname(asInt(req.params.id!, 'id')));
}

export async function createOpname(req: Request, res: Response): Promise<void> {
  res.status(201).json(await opnameService.createOpname(req.body as OpnameInput, req.user!.id));
}
