import { Router } from 'express';
import { authRouter } from './auth.routes';
import { campaignsRouter } from './campaigns.routes';
import { emailsRouter } from './emails.routes';
import { sendersRouter } from './senders.routes';
import { systemRouter } from './system.routes';

export function createApiRouter(): Router {
  const router = Router();

  router.use(systemRouter);
  router.use('/auth', authRouter);
  router.use('/emails', emailsRouter);
  router.use('/campaigns', campaignsRouter);
  router.use('/senders', sendersRouter);

  return router;
}
