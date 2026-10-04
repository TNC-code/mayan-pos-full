import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/errors.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Bersihkan bucket kedaluwarsa berkala agar Map tidak bocor memori.
let lastSweep = Date.now();
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

/**
 * Rate limit sederhana in-memory per IP+scope (cukup untuk 2-5 POS / satu proses).
 * P0/P1 hardening: login dibatasi ketat, endpoint lain longgar.
 */
export function rateLimit(scope: string, opts: { windowMs: number; max: number }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    sweep(now);

    const key = `${scope}:${req.ip ?? 'unknown'}`;
    const b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }
    b.count += 1;
    if (b.count > opts.max) {
      res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
      next(new ApiError('TOO_MANY_REQUESTS', `Terlalu banyak permintaan, coba lagi dalam ${Math.ceil((b.resetAt - now) / 1000)} detik`));
      return;
    }
    next();
  };
}
