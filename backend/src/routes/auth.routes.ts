import { Router } from 'express';
import { loginWithGoogle } from '../services/auth.service';
import { requireAuth, currentUser } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { googleLoginSchema } from './schemas';
import { env } from '../config/env';

export const authRouter = Router();

/** Exposes just enough for the sign-in screen to render a real Google button. */
authRouter.get('/config', (_req, res) => {
  res.json({
    googleClientId: env.auth.googleClientId || null,
    configured: Boolean(env.auth.googleClientId),
  });
});

/** Exchanges a Google ID token for an API session token. */
authRouter.post(
  '/google',
  asyncHandler(async (req, res) => {
    const { idToken } = googleLoginSchema.parse(req.body);
    const session = await loginWithGoogle(idToken);
    res.json(session);
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: currentUser(req) });
});
