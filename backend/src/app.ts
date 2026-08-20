import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { createApiRouter } from './routes';
import { errorHandler, notFoundHandler } from './middleware/error';
import { requestLogger } from './middleware/requestLogger';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: true,
    }),
  );
  // Lead lists can be pasted in as raw CSV text, so the default 100kb is low.
  app.use(express.json({ limit: '25mb' }));
  app.use(requestLogger);

  app.get('/', (_req, res) => {
    res.json({
      name: 'ReachInbox Email Scheduler API',
      health: '/api/health',
      docs: 'See README.md for the full endpoint list',
    });
  });

  app.use('/api', createApiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
