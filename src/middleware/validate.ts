import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodType } from 'zod';
import { ApiError } from '../utils/errors.js';

/** Bungkus handler async supaya error-nya sampai ke errorHandler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

function formatIssues(err: z.ZodError): { error: string; code: string; details: unknown } {
  return {
    error: 'Validasi input gagal',
    code: 'VALIDATION_ERROR',
    details: err.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    })),
  };
}

/** Validasi body dengan zod. Hasil parse replaces req.body. */
export function validateBody<T extends ZodType>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(new ApiError('VALIDATION_ERROR', 'Validasi input gagal', formatIssues(parsed.error).details));
      return;
    }
    req.body = parsed.data;
    next();
  };
}

/** Validasi query string. Hasil parse disimpan di res.locals.query. */
export function validateQuery<T extends ZodType>(schema: T): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      next(new ApiError('VALIDATION_ERROR', 'Validasi query gagal', formatIssues(parsed.error).details));
      return;
    }
    res.locals.query = parsed.data;
    next();
  };
}

export interface AppLocals {
  query: unknown;
}

export function validated<T>(res: Response): T {
  return res.locals.query as T;
}
