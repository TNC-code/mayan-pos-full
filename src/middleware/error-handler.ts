import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ApiError } from '../utils/errors.js';
import { mapDbError } from '../utils/db-errors.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: `Endpoint tidak ditemukan: ${req.method} ${req.originalUrl}`,
    code: 'NOT_FOUND',
  });
};

/**
 * Satu-satunya tempat error jadi response. Semua error DB dipetakan ke
 * { error, code } sesuai openapi.yaml + fase.md section 3.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const apiError: ApiError = err instanceof ApiError ? err : mapDbError(err);

  if (apiError.status >= 500) {
    console.error('[error]', err);
  }

  const body: { error: string; code: string; details?: unknown } = {
    error: apiError.message,
    code: apiError.code,
  };
  if (apiError.details !== undefined) body.details = apiError.details;

  res.status(apiError.status).json(body);
};
