import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env, roleOf, type Role } from '../config/env.js';
import { ApiError, forbidden, unauthorized } from '../utils/errors.js';

export interface AuthUser {
  id: number;
  username: string;
  full_name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      idempotencyKey?: string;
    }
  }
}

export interface JwtPayload {
  sub: number;
  username: string;
  name: string;
  role: Role;
}

export function signToken(user: AuthUser): string {
  const payload: JwtPayload = {
    sub: user.id,
    username: user.username,
    name: user.full_name,
    role: user.role,
  };
  return jwt.sign(payload, env.jwt.secret, { expiresIn: env.jwt.expiresIn } as jwt.SignOptions);
}

/** Semua endpoint wajib auth kecuali /auth/login. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header || !/^Bearer\s+/i.test(header)) {
    next(unauthorized('Header Authorization: Bearer <token> wajib diisi'));
    return;
  }

  const token = header.replace(/^Bearer\s+/i, '').trim();
  try {
    const decoded = jwt.verify(token, env.jwt.secret) as unknown as JwtPayload;
    req.user = {
      id: Number(decoded.sub),
      username: decoded.username,
      full_name: decoded.name,
      role: decoded.role ?? roleOf(decoded.username),
    };
    next();
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    next(unauthorized(expired ? 'Token kedaluwarsa, silakan login ulang' : 'Token tidak valid'));
  }
}

/** OWNER-only, mis. CRUD payment_methods. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(forbidden(`Endpoint ini hanya untuk role ${roles.join('/')}`));
      return;
    }
    next();
  };
}

/** Idempotency-Key (UUID) wajib untuk POST /sales & POST /payments. */
export function requireIdempotencyKey(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.header('idempotency-key')?.trim();
  if (!raw) {
    next(new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'Header Idempotency-Key (uuid) wajib diisi untuk endpoint ini'));
    return;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    next(new ApiError('VALIDATION_ERROR', 'Idempotency-Key harus berupa UUID v4 yang valid'));
    return;
  }
  req.idempotencyKey = raw.toLowerCase();
  next();
}
