import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { assertQuizDocumentsIntegrity } from './models/Quiz.js';
import { assertNoStaleQuizIndexes } from './scripts/migrate-quiz-final-exams.js';
import { logger } from './utils/logger.js';

const FORCE_EXIT_MS = 10_000;

async function main(): Promise<void> {
  await connectDatabase();
  await assertNoStaleQuizIndexes();
  await assertQuizDocumentsIntegrity();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`Server listening on port ${env.PORT}`);
  });

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down gracefully');

    const forceTimer = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, FORCE_EXIT_MS);
    forceTimer.unref();

    server.close(async (closeErr) => {
      if (closeErr) {
        logger.error({ err: closeErr }, 'Error closing HTTP server');
      }

      try {
        await disconnectDatabase();
        clearTimeout(forceTimer);
        process.exit(closeErr ? 1 : 0);
      } catch (err) {
        logger.error({ err }, 'Error during database disconnect');
        clearTimeout(forceTimer);
        process.exit(1);
      }
    });
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
