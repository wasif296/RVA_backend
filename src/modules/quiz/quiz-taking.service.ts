import { Types, trusted } from 'mongoose';
import { RULES, finalExamPassMark } from '@shared';
import { Course } from '../../models/Course.js';
import { ExamSubmission } from '../../models/ExamSubmission.js';
import { Lesson } from '../../models/Lesson.js';
import { Progress } from '../../models/Progress.js';
import { Quiz, finalExamFilter, lessonQuizFilter, type QuizScope } from '../../models/Quiz.js';
import { QuizAttempt } from '../../models/QuizAttempt.js';
import { User } from '../../models/User.js';
import { AppError } from '../../utils/AppError.js';

export type LearnerQuestionDto = {
  id: string;
  text: string;
  options: string[];
  order: number;
};

export type LearnerQuizDto = {
  id: string;
  scope: QuizScope;
  title: string;
  pointsPerQuestion: number;
  passingScorePct: number;
  maxAttempts: number | null;
  questionCount: number;
  maxPoints: number;
  questions: LearnerQuestionDto[];
};

export type LearnerFinalExamQuestionDto = {
  id: string;
  text: string;
  order: number;
};

export type LearnerFinalExamDto = {
  id: string;
  title: string;
  instructions: string;
  questions: LearnerFinalExamQuestionDto[];
  maxMarks: number;
  passPct: number;
  passMark: number;
};

export type ExamSubmissionDto = {
  id: string;
  status: 'submitted' | 'graded';
  docUrl: string;
  loomUrl: string | null;
  submittedAt: string;
  marksAwarded: number | null;
  maxMarks: number;
  passed: boolean | null;
  feedback: string | null;
  gradedAt: string | null;
};

export type QuestionResultDto = {
  questionId: string;
  selectedIndex: number | null;
  correctIndex: number;
  isCorrect: boolean;
};

export type SubmitQuizResultDto = {
  correctCount: number;
  score: number;
  maxScore: number;
  pointsDelta: number;
  passed: boolean;
  attemptNumber: number;
  breakdown: QuestionResultDto[];
};

export type AttemptHistoryItemDto = {
  id: string;
  score: number;
  maxScore: number;
  correctCount: number;
  pointsDelta: number;
  attemptNumber: number;
  createdAt: string;
};

type QuizForGrading = {
  _id: Types.ObjectId;
  scope: QuizScope;
  courseId: Types.ObjectId;
  lessonId?: Types.ObjectId | null;
  title: string;
  pointsPerQuestion: number;
  passingScorePct: number;
  maxAttempts: number | null;
  questions: Array<{
    _id: Types.ObjectId;
    text: string;
    options: string[];
    correctIndex: number;
    order: number;
  }>;
};

/**
 * Explicit learner projection — never include correctIndex, even if select:false
 * is later removed from the schema.
 */
function toLearnerQuizDto(quiz: {
  _id: Types.ObjectId;
  scope: QuizScope;
  title: string;
  pointsPerQuestion: number;
  passingScorePct: number;
  maxAttempts?: number | null;
  questions: Array<{
    _id: Types.ObjectId;
    text: string;
    options: string[];
    order: number;
  }>;
}): LearnerQuizDto {
  const questions: LearnerQuestionDto[] = quiz.questions
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((q) => ({
      id: q._id.toString(),
      text: q.text,
      options: [...q.options],
      order: q.order,
    }));

  return {
    id: quiz._id.toString(),
    scope: quiz.scope,
    title: quiz.title,
    pointsPerQuestion: quiz.pointsPerQuestion,
    passingScorePct: quiz.passingScorePct,
    maxAttempts: quiz.maxAttempts ?? null,
    questionCount: questions.length,
    maxPoints: questions.length * quiz.pointsPerQuestion,
    questions,
  };
}

function scoreAnswers(
  quiz: QuizForGrading,
  answers: Array<number | null>,
): {
  correctCount: number;
  score: number;
  maxScore: number;
  breakdown: QuestionResultDto[];
  persistedAnswers: number[];
} {
  const questions = quiz.questions.slice().sort((a, b) => a.order - b.order);

  if (answers.length !== questions.length) {
    throw AppError.validation(
      `answers length must equal questionCount (${questions.length})`,
    );
  }

  let correctCount = 0;
  const breakdown: QuestionResultDto[] = [];
  const persistedAnswers: number[] = [];

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i]!;
    const selected = answers[i] ?? null;

    if (selected !== null) {
      if (
        !Number.isInteger(selected) ||
        selected < 0 ||
        selected >= question.options.length
      ) {
        throw AppError.validation(
          `answers[${i}] is not a valid option index`,
        );
      }
    }

    const isCorrect = selected !== null && selected === question.correctIndex;
    if (isCorrect) correctCount += 1;

    breakdown.push({
      questionId: question._id.toString(),
      selectedIndex: selected,
      correctIndex: question.correctIndex,
      isCorrect,
    });
    // Persist unanswered as -1 (QuizAttempt.answers is Number[])
    persistedAnswers.push(selected === null ? -1 : selected);
  }

  const maxScore = questions.length * quiz.pointsPerQuestion;
  const score = correctCount * quiz.pointsPerQuestion;

  return { correctCount, score, maxScore, breakdown, persistedAnswers };
}

async function requirePublishedLesson(lessonId: string) {
  if (!Types.ObjectId.isValid(lessonId)) {
    throw AppError.notFound('Lesson not found');
  }
  const lesson = await Lesson.findById(lessonId);
  if (!lesson) {
    throw AppError.notFound('Lesson not found');
  }
  const course = await Course.findById(lesson.courseId);
  if (!course || course.status !== 'published') {
    throw AppError.notFound('Lesson not found');
  }
  return { lesson, course };
}

async function requirePublishedCourse(courseId: string) {
  if (!Types.ObjectId.isValid(courseId)) {
    throw AppError.notFound('Course not found');
  }
  const course = await Course.findById(courseId);
  if (!course || course.status !== 'published') {
    throw AppError.notFound('Course not found');
  }
  return course;
}

async function loadQuizForLearner(filter: Record<string, unknown>) {
  // Do NOT select correctIndex — lean projection omits it by default (select:false).
  const quiz = await Quiz.findOne(filter)
    .select({
      scope: 1,
      title: 1,
      pointsPerQuestion: 1,
      passingScorePct: 1,
      maxAttempts: 1,
      'questions._id': 1,
      'questions.text': 1,
      'questions.options': 1,
      'questions.order': 1,
    })
    .lean();

  if (!quiz) {
    throw AppError.notFound('Quiz not found');
  }

  return toLearnerQuizDto(quiz as Parameters<typeof toLearnerQuizDto>[0]);
}

async function loadQuizForGrading(filter: Record<string, unknown>): Promise<QuizForGrading> {
  const quiz = await Quiz.findOne(filter).select('+questions.correctIndex');
  if (!quiz) {
    throw AppError.notFound('Quiz not found');
  }

  for (const question of quiz.questions) {
    if (typeof question.correctIndex !== 'number') {
      throw new AppError('INTERNAL_ERROR', 'Quiz loaded for grading without correctIndex');
    }
  }

  return quiz as unknown as QuizForGrading;
}

async function ensureLessonProgressEntry(params: {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  lessonId: Types.ObjectId;
}) {
  let progress = await Progress.findOne({
    userId: params.userId,
    courseId: params.courseId,
  });

  if (!progress) {
    progress = await Progress.create({
      userId: params.userId,
      courseId: params.courseId,
      startedAt: new Date(),
      lastLessonId: params.lessonId,
      lessons: [
        {
          lessonId: params.lessonId,
          watchedSec: 0,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });
    return progress;
  }

  const exists = progress.lessons.some((row) =>
    row.lessonId.equals(params.lessonId),
  );
  if (!exists) {
    progress.lessons.push({
      lessonId: params.lessonId,
      watchedSec: 0,
      videoPointsAwarded: false,
      bestQuizScore: 0,
      quizPointsAwarded: 0,
      attempts: 0,
    });
    await progress.save();
  }

  return progress;
}

export async function getLessonQuizForLearner(params: {
  lessonId: string;
  userId: string;
}): Promise<{ quiz: LearnerQuizDto }> {
  void params.userId;
  const { lesson } = await requirePublishedLesson(params.lessonId);
  const quiz = await loadQuizForLearner({
    lessonId: lesson._id,
    scope: 'lesson',
  });
  return { quiz };
}

function toExamSubmissionDto(row: {
  _id: Types.ObjectId;
  status: 'submitted' | 'graded';
  docUrl: string;
  loomUrl?: string | null;
  submittedAt: Date;
  marksAwarded?: number | null;
  maxMarks: number;
  passed?: boolean | null;
  feedback?: string | null;
  gradedAt?: Date | null;
}): ExamSubmissionDto {
  return {
    id: row._id.toString(),
    status: row.status,
    docUrl: row.docUrl,
    loomUrl: row.loomUrl ?? null,
    submittedAt: row.submittedAt.toISOString(),
    marksAwarded: row.marksAwarded ?? null,
    maxMarks: row.maxMarks,
    passed: row.passed ?? null,
    feedback: row.feedback ?? null,
    gradedAt: row.gradedAt ? row.gradedAt.toISOString() : null,
  };
}

export async function getFinalExamForLearner(
  courseId: string,
): Promise<{ exam: LearnerFinalExamDto }> {
  const course = await requirePublishedCourse(courseId);
  const quiz = await Quiz.findOne(finalExamFilter(course._id))
    .select({
      title: 1,
      instructions: 1,
      'questions._id': 1,
      'questions.text': 1,
      'questions.order': 1,
    })
    .lean();

  if (!quiz) {
    throw AppError.notFound('Final exam not found');
  }

  const questions: LearnerFinalExamQuestionDto[] = quiz.questions
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((q) => ({
      id: q._id.toString(),
      text: q.text,
      order: q.order,
    }));

  return {
    exam: {
      id: quiz._id.toString(),
      title: quiz.title,
      instructions: quiz.instructions ?? '',
      questions,
      maxMarks: RULES.FINAL_EXAM_MAX_MARKS,
      passPct: RULES.FINAL_EXAM_PASS_PCT,
      passMark: finalExamPassMark(),
    },
  };
}

export async function submitLessonQuiz(params: {
  userId: string;
  lessonId: string;
  answers: Array<number | null>;
}): Promise<SubmitQuizResultDto> {
  const { lesson, course } = await requirePublishedLesson(params.lessonId);
  const userOid = new Types.ObjectId(params.userId);
  const quiz = await loadQuizForGrading({
    lessonId: lesson._id,
    scope: 'lesson',
  });

  const graded = scoreAnswers(quiz, params.answers);
  const progress = await ensureLessonProgressEntry({
    userId: userOid,
    courseId: course._id,
    lessonId: lesson._id,
  });

  const entry = progress.lessons.find((row) => row.lessonId.equals(lesson._id))!;
  const previousBest = entry.bestQuizScore ?? 0;
  const pointsDelta = Math.max(0, graded.score - previousBest);
  const attemptNumber = (entry.attempts ?? 0) + 1;
  const passed =
    graded.maxScore > 0
      ? (graded.score / graded.maxScore) * 100 >= quiz.passingScorePct
      : false;

  await QuizAttempt.create({
    userId: userOid,
    lessonId: lesson._id,
    quizId: quiz._id,
    answers: graded.persistedAnswers,
    score: graded.score,
    maxScore: graded.maxScore,
    correctCount: graded.correctCount,
    pointsDelta,
    attemptNumber,
  });

  await Progress.updateOne(
    {
      userId: userOid,
      courseId: course._id,
      lessons: trusted({
        $elemMatch: { lessonId: lesson._id },
      }),
    },
    {
      $set: {
        'lessons.$.bestQuizScore': Math.max(previousBest, graded.score),
        lastLessonId: lesson._id,
      },
      $inc: {
        'lessons.$.quizPointsAwarded': pointsDelta,
        'lessons.$.attempts': 1,
      },
    },
  );

  if (pointsDelta > 0) {
    await User.updateOne({ _id: userOid }, { $inc: { totalPoints: pointsDelta } });
  }

  return {
    correctCount: graded.correctCount,
    score: graded.score,
    maxScore: graded.maxScore,
    pointsDelta,
    passed,
    attemptNumber,
    breakdown: graded.breakdown,
  };
}

export async function submitFinalExam(params: {
  userId: string;
  courseId: string;
  docUrl: string;
  loomUrl?: string | null;
}): Promise<{ submission: ExamSubmissionDto }> {
  const course = await requirePublishedCourse(params.courseId);
  const userOid = new Types.ObjectId(params.userId);

  const quiz = await Quiz.findOne(finalExamFilter(course._id)).select('_id');
  if (!quiz) {
    throw AppError.notFound('Final exam not found');
  }

  const progress = await Progress.findOne({
    userId: userOid,
    courseId: course._id,
  });
  const completedVideos = progress
    ? progress.lessons.filter((row) => row.videoCompletedAt != null).length
    : 0;
  if (course.lessonCount < 1 || completedVideos < course.lessonCount) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Final exam unlocks only after every lesson video is complete',
    );
  }

  const existing = await ExamSubmission.findOne({
    userId: userOid,
    courseId: course._id,
  });
  if (existing?.status === 'graded') {
    throw new AppError(
      'VALIDATION_ERROR',
      'Final exam submission has already been graded and cannot be replaced',
    );
  }

  const now = new Date();
  const loomUrl = params.loomUrl ?? null;
  const maxMarks = RULES.FINAL_EXAM_MAX_MARKS;

  let submission;
  if (existing) {
    existing.docUrl = params.docUrl;
    existing.loomUrl = loomUrl;
    existing.examId = quiz._id;
    existing.status = 'submitted';
    existing.submittedAt = now;
    existing.marksAwarded = null;
    existing.maxMarks = maxMarks;
    existing.passed = null;
    existing.gradedBy = null;
    existing.gradedAt = null;
    existing.feedback = null;
    submission = await existing.save();
  } else {
    submission = await ExamSubmission.create({
      userId: userOid,
      courseId: course._id,
      examId: quiz._id,
      docUrl: params.docUrl,
      loomUrl,
      status: 'submitted',
      submittedAt: now,
      marksAwarded: null,
      maxMarks,
      passed: null,
    });
  }

  // Written submissions award no points until a tutor grades them.
  return { submission: toExamSubmissionDto(submission) };
}

export async function getFinalExamSubmission(params: {
  userId: string;
  courseId: string;
}): Promise<{ submission: ExamSubmissionDto | null }> {
  const course = await requirePublishedCourse(params.courseId);
  const row = await ExamSubmission.findOne({
    userId: new Types.ObjectId(params.userId),
    courseId: course._id,
  }).lean();

  return {
    submission: row ? toExamSubmissionDto(row) : null,
  };
}

export async function listLessonQuizAttempts(params: {
  userId: string;
  lessonId: string;
}): Promise<{ attempts: AttemptHistoryItemDto[] }> {
  const { lesson } = await requirePublishedLesson(params.lessonId);
  const quiz = await Quiz.findOne(lessonQuizFilter(lesson._id)).select('_id');
  if (!quiz) {
    throw AppError.notFound('Quiz not found');
  }

  const rows = await QuizAttempt.find({
    userId: new Types.ObjectId(params.userId),
    quizId: quiz._id,
  })
    .sort({ attemptNumber: 1 })
    .lean();

  return {
    attempts: rows.map((row) => ({
      id: row._id.toString(),
      score: row.score,
      maxScore: row.maxScore,
      correctCount: row.correctCount,
      pointsDelta: row.pointsDelta,
      attemptNumber: row.attemptNumber,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Pure helper for delta awards. */
export function computePointsDelta(score: number, previousBest: number): number {
  return Math.max(0, score - previousBest);
}
