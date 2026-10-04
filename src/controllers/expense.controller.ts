import type { Request, Response } from 'express';
import * as expenseService from '../services/expense.service.js';
import * as reportService from '../services/report.service.js';
import { validated } from '../middleware/validate.js';
import { asInt } from '../utils/tx.js';
import type { ExpenseInput } from '../services/expense.service.js';

/* ------------------------- operational expenses ------------------------ */
export async function listExpenses(_req: Request, res: Response): Promise<void> {
  const q = validated<{ month?: string; category?: string; limit: number; offset: number }>(res);
  res.status(200).json(await expenseService.listExpenses(q));
}

export async function createExpense(req: Request, res: Response): Promise<void> {
  const expense = await expenseService.createExpense(req.body as ExpenseInput, req.user!.id);
  res.status(201).json(expense);
}

export async function updateExpense(req: Request, res: Response): Promise<void> {
  const expense = await expenseService.updateExpense(
    asInt(req.params.id!, 'id'),
    req.body as Partial<ExpenseInput>,
  );
  res.status(200).json(expense);
}

export async function getExpense(req: Request, res: Response): Promise<void> {
  res.status(200).json(await expenseService.getExpense(asInt(req.params.id!, 'id')));
}

/* ------------------------------- reports ------------------------------- */
export async function pnl(_req: Request, res: Response): Promise<void> {
  const q = validated<{ month: string }>(res);
  res.status(200).json(await reportService.pnlReport(q.month));
}

export async function dashboard(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await reportService.dashboard());
}

export async function alerts(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await reportService.alerts());
}
