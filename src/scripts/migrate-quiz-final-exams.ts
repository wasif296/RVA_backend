/**
 * Idempotent repair for Quiz final exams + leftover indexes.
 *
 * Pre-Phase-A exams were MCQ rows (options/correctIndex, maxAttempts). The unique
 * index `lessonId_1` (no partial filter) also survived: MongoDB then allows only
 * ONE `lessonId: null` in the whole collection, so a second course's exam create
 * 11000s while GET correctly reports no exam.
 */
import { RULES } from '@shared';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Quiz } from '../models/Quiz.js';
import { logger } from '../utils/logger.js';

const STALE_QUIZ_INDEXES = ['lessonId_1', 'courseId_1'] as const;

export async function migrateQuizFinalExams(): Promise<{
  droppedIndexes: string[];
  examsNormalized: number;
}> {
  const coll = Quiz.collection;
  const existing = await coll.indexes();
  const names = new Set(existing.map((idx) => idx.name));
  const droppedIndexes: string[] = [];

  for (const name of STALE_QUIZ_INDEXES) {
    if (names.has(name)) {
      await coll.dropIndex(name);
      droppedIndexes.push(name);
      logger.info({ index: name }, 'Dropped stale Quiz index');
    }
  }

  await Quiz.syncIndexes();

  const result = await coll.updateMany({ scope: 'final_exam' }, [
    {
      $set: {
        lessonId: null,
        maxAttempts: null,
        passingScorePct: RULES.FINAL_EXAM_PASS_PCT,
        pointsPerQuestion: RULES.DEFAULT_POINTS_PER_QUESTION,
        instructions: { $ifNull: ['$instructions', ''] },
        questions: {
          $map: {
            input: { $ifNull: ['$questions', []] },
            as: 'q',
            in: {
              _id: '$$q._id',
              text: '$$q.text',
              options: [],
              order: '$$q.order',
            },
          },
        },
      },
    },
  ]);

  if (result.modifiedCount > 0) {
    logger.info(
      { modified: result.modifiedCount },
      'Normalized final_exam documents to Phase A shape',
    );
  }

  return {
    droppedIndexes,
    examsNormalized: result.modifiedCount,
  };
}

async function main(): Promise<void> {
  await connectDatabase();
  const summary = await migrateQuizFinalExams();
  logger.info(summary, 'Quiz final-exam migration complete');
}

const invokedAsCli = /(?:^|[/\\])migrate-quiz-final-exams\.(ts|js)$/.test(
  process.argv[1] ?? '',
);

if (invokedAsCli) {
  main()
    .then(async () => {
      await disconnectDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      try {
        await disconnectDatabase();
      } catch {
        // ignore
      }
      process.exit(1);
    });
}
