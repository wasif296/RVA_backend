import { createApp } from './app.js';
import { connectDatabase } from './config/db.js';
import { assertQuizDocumentsIntegrity } from './models/Quiz.js';
import { assertNoStaleQuizIndexes } from './scripts/migrate-quiz-final-exams.js';

/**
 * Vercel serverless entry. Connect once (cached on globalThis), then export
 * the Express app. app.listen must not run on this path.
 */
await connectDatabase();
await assertNoStaleQuizIndexes();
await assertQuizDocumentsIntegrity();

export default createApp();
