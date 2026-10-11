import type { Request, Response } from 'express';
import * as authService from '../services/auth.service.js';

export async function login(req: Request, res: Response): Promise<void> {
  const { username, password } = req.body as { username: string; password: string };
  const result = await authService.login(username, password);
  res.status(200).json(result);
}

/** Tukar refresh token -> JWT baru (tidak butuh JWT, cukup refresh token valid).
 *  Rotasi: token lama dicabut, `refresh_token` baru dikembalikan (field additive —
 *  FE memakai yang baru kalau ada, lihat fe/lib/api/auth_api.dart). */
export async function refresh(req: Request, res: Response): Promise<void> {
  const { refresh_token: refreshToken } = req.body as { refresh_token: string };
  const { token, refresh_token, user } = await authService.refreshAccessToken(refreshToken);
  res.status(200).json({
    token,
    refresh_token,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
  });
}

/** Logout: cabut refresh token. */
export async function logout(req: Request, res: Response): Promise<void> {
  const { refresh_token: refreshToken } = req.body as { refresh_token: string };
  await authService.logout(refreshToken);
  res.status(200).json({ ok: true, message: 'Logout berhasil, refresh token dicabut' });
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = await authService.me(req.user!.id);
  res.status(200).json({ user });
}
