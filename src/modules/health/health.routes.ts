import { Router } from 'express';
import type { HealthResponse } from '../../shared/index.js';
import { databaseStatus } from '../../config/db.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  const body: HealthResponse = {
    status: 'ok',
    uptimeSec: Math.floor(process.uptime()),
    db: databaseStatus(),
    timestamp: new Date().toISOString(),
  };

  res.json(body);
});
