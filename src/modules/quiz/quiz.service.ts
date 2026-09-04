import { Types } from 'mongoose';
import { RULES, finalExamPassMark } from '../../shared/index.js';
import { Course } from '../../models/Course.js';
import { ExamSubmission } from '../../models/ExamSubmission.js';
import { Lesson } from '../../models/Lesson.js';
import { Quiz, finalExamFilter, lessonQuizFilter, type QuizScope } from '../../models/Quiz.js';
import { QuizAttempt } from '../../models/QuizAttempt.js';
import { AppError } from '../../utils/AppError.js';
import type { UpsertFinalExamBody, UpsertQuizBody } from './quiz.schema.js';

export type AdminQuizQuestionDto = {
  id: string;
  text: string;
  options: string[];
  correctIndex: number;
  order: number;
};

export type AdminQuizDto = {
  id: string;
  scope: QuizScope;
  courseId: string;
  lessonId: string | null;
  title: string;
  pointsPerQuestion: number;
  passingScorePct: number;
  maxAttempts: number | null;
  questions: AdminQuizQuestionDto[];
  attemptCount: number;
  currentTotal: number;
  requiredTotal: number | null;
  mismatchWarning: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminFinalExamQuestionDto = {
  id: string;
  text: string;
  order: number;
};

export type AdminFinalExamDto = {
  id: string;
  courseId: string;
  title: string;
  instructions: string;
  questions: AdminFinalExamQuestionDto[];
  maxMarks: number;
  passPct: number;
  passMark: number;
  submissionCount: number;
  createdAt: string;
  updatedAt: string;
};

type QuizWithAnswers = {
  _id: Types.ObjectId;
  scope: QuizScope;
  courseId: Types.ObjectId;
  lessonId?: Types.ObjectId | null;
  title: string;
  instructions?: string;
  pointsPerQuestion: number;
  passingScorePct: number;
  maxAttempts?: number | null;
  questions: Array<{
    _id: Types.ObjectId;
    text: string;
    options: string[];
    correctIndex?: number;
    order: number;
  }>;
  createdAt: Date;
  updatedAt: Date;
};

/** Admin read/write DTO for lesson quizzes — the ONLY shape that may include correctIndex. */
function toAdminQuizDto(quiz: QuizWithAnswers, attemptCount: number): AdminQuizDto {
  const currentTotal = quiz.questions.length * quiz.pointsPerQuestion;

  return {
    id: quiz._id.toString(),
    scope: quiz.scope,
    courseId: quiz.courseId.toString(),
    lessonId: quiz.lessonId ? quiz.lessonId.toString() : null,
    title: quiz.title,
    pointsPerQuestion: quiz.pointsPerQuestion,
    passingScorePct: quiz.passingScorePct,
    maxAttempts: quiz.maxAttempts ?? null,
    questions: quiz.questions.map((question) => {
      if (typeof question.correctIndex !== 'number') {
        throw new AppError(
          'INTERNAL_ERROR',
          'Quiz admin DTO built without correctIndex selected',
        );
      }
      return {
        id: question._id.toString(),
        text: question.text,
        options: question.options,
        correctIndex: question.correctIndex,
        order: question.order,
      };
    }),
    attemptCount,
    currentTotal,
    requiredTotal: null,
    mismatchWarning: null,
    createdAt: quiz.createdAt.toISOString(),
    updatedAt: quiz.updatedAt.toISOString(),
  };
}

function toAdminFinalExamDto(
  quiz: QuizWithAnswers,
  submissionCount: number,
): AdminFinalExamDto {
  return {
    id: quiz._id.toString(),
    courseId: quiz.courseId.toString(),
    title: quiz.title,
    instructions: quiz.instructions ?? '',
    questions: quiz.questions
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((question) => ({
        id: question._id.toString(),
        text: question.text,
        order: question.order,
      })),
    maxMarks: RULES.FINAL_EXAM_MAX_MARKS,
    passPct: RULES.FINAL_EXAM_PASS_PCT,
    passMark: finalExamPassMark(),
    submissionCount,
    createdAt: quiz.createdAt.toISOString(),
    updatedAt: quiz.updatedAt.toISOString(),
  };
}

function mapLessonQuestions(body: UpsertQuizBody) {
  return body.questions.map((question, index) => ({
    text: question.text,
    options: question.options,
    correctIndex: question.correctIndex,
    order: (index + 1) * 10,
  }));
}

function mapExamQuestions(body: UpsertFinalExamBody) {
  return body.questions.map((question, index) => ({
    text: question.text,
    options: [] as string[],
    order: (index + 1) * 10,
  }));
}

async function requireLesson(lessonId: string) {
  if (!Types.ObjectId.isValid(lessonId)) {
    throw AppError.notFound('Lesson not found');
  }
  const lesson = await Lesson.findById(lessonId);
  if (!lesson) {
    throw AppError.notFound('Lesson not found');
  }
  return lesson;
}

async function requireCourse(courseId: string) {
  if (!Types.ObjectId.isValid(courseId)) {
    throw AppError.notFound('Course not found');
  }
  const course = await Course.findById(courseId);
  if (!course) {
    throw AppError.notFound('Course not found');
  }
  return course;
}

async function withAttemptWarning(
  quiz: QuizWithAnswers,
): Promise<{ quiz: AdminQuizDto; warning?: string }> {
  const attemptCount = await QuizAttempt.countDocuments({ quizId: quiz._id });
  const dto = toAdminQuizDto(quiz, attemptCount);
  if (attemptCount > 0) {
    return {
      quiz: dto,
      warning: `This quiz already has ${attemptCount} attempt${attemptCount === 1 ? '' : 's'}. Historical attempts keep their own maxScore and are not rescored.`,
    };
  }
  return { quiz: dto };
}

/**
 * Lesson quiz admin read — one of exactly two paths that may include correctIndex.
 */
export async function getLessonQuizForAdmin(lessonId: string): Promise<AdminQuizDto> {
  const lesson = await requireLesson(lessonId);
  const quiz = await Quiz.findOne(lessonQuizFilter(lesson._id)).select(
    '+questions.correctIndex',
  );
  if (!quiz) {
    throw AppError.notFound('Quiz not found');
  }
  const attemptCount = await QuizAttempt.countDocuments({ quizId: quiz._id });
  return toAdminQuizDto(quiz, attemptCount);
}

export async function upsertLessonQuiz(params: {
  lessonId: string;
  body: UpsertQuizBody;
}): Promise<{ quiz: AdminQuizDto; warning?: string }> {
  const lesson = await requireLesson(params.lessonId);
  const questions = mapLessonQuestions(params.body);

  let quiz = await Quiz.findOne(lessonQuizFilter(lesson._id)).select(
    '+questions.correctIndex',
  );

  if (quiz) {
    quiz.title = params.body.title;
    quiz.pointsPerQuestion = params.body.pointsPerQuestion;
    quiz.passingScorePct = params.body.passingScorePct;
    quiz.courseId = lesson.courseId;
    quiz.scope = 'lesson';
    quiz.questions = questions as typeof quiz.questions;
    await quiz.save();
  } else {
    const created = await Quiz.create({
      scope: 'lesson',
      courseId: lesson.courseId,
      lessonId: lesson._id,
      title: params.body.title,
      pointsPerQuestion: params.body.pointsPerQuestion,
      passingScorePct: params.body.passingScorePct,
      maxAttempts: null,
      questions,
    });
    quiz = await Quiz.findById(created._id).select('+questions.correctIndex');
    if (!quiz) {
      throw new AppError('INTERNAL_ERROR', 'Quiz was created but could not be reloaded');
    }
  }

  return withAttemptWarning(quiz);
}

export async function deleteLessonQuiz(lessonId: string): Promise<void> {
  const lesson = await requireLesson(lessonId);
  const quiz = await Quiz.findOne(lessonQuizFilter(lesson._id));
  if (!quiz) {
    throw AppError.notFound('Quiz not found');
  }
  await quiz.deleteOne();
}

function applyFinalExamFields(
  quiz: {
    title: string;
    instructions?: string;
    lessonId?: Types.ObjectId | null;
    maxAttempts?: number | null;
    passingScorePct: number;
    pointsPerQuestion: number;
    questions: unknown;
  },
  body: UpsertFinalExamBody,
  questions: ReturnType<typeof mapExamQuestions>,
) {
  quiz.title = body.title;
  quiz.instructions = body.instructions ?? '';
  quiz.lessonId = null;
  quiz.maxAttempts = null;
  quiz.passingScorePct = RULES.FINAL_EXAM_PASS_PCT;
  quiz.pointsPerQuestion = RULES.DEFAULT_POINTS_PER_QUESTION;
  quiz.questions = questions;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

export async function getFinalExamForAdmin(courseId: string): Promise<AdminFinalExamDto> {
  const course = await requireCourse(courseId);
  const quiz = await Quiz.findOne(finalExamFilter(course._id));
  if (!quiz) {
    throw AppError.notFound('Final exam not found');
  }
  const submissionCount = await ExamSubmission.countDocuments({ examId: quiz._id });
  return toAdminFinalExamDto(quiz, submissionCount);
}

export async function upsertFinalExam(params: {
  courseId: string;
  body: UpsertFinalExamBody;
}): Promise<{ exam: AdminFinalExamDto; warning?: string }> {
  const course = await requireCourse(params.courseId);
  const questions = mapExamQuestions(params.body);
  const filter = finalExamFilter(course._id);

  let quiz = await Quiz.findOne(filter);

  if (quiz) {
    applyFinalExamFields(quiz, params.body, questions);
    await quiz.save();
  } else {
    try {
      const created = await Quiz.create({
        scope: 'final_exam',
        courseId: course._id,
        lessonId: null,
        title: params.body.title,
        instructions: params.body.instructions ?? '',
        pointsPerQuestion: RULES.DEFAULT_POINTS_PER_QUESTION,
        passingScorePct: RULES.FINAL_EXAM_PASS_PCT,
        maxAttempts: null,
        questions,
      });
      quiz = await Quiz.findById(created._id);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Concurrent create lost the race — fall through to update the winner.
      quiz = await Quiz.findOne(filter);
      if (!quiz) {
        throw new AppError('INTERNAL_ERROR', 'Final exam could not be saved');
      }
      applyFinalExamFields(quiz, params.body, questions);
      await quiz.save();
    }
    if (!quiz) {
      throw new AppError(
        'INTERNAL_ERROR',
        'Final exam was created but could not be reloaded',
      );
    }
  }

  const submissionCount = await ExamSubmission.countDocuments({ examId: quiz._id });
  const exam = toAdminFinalExamDto(quiz, submissionCount);
  if (submissionCount > 0) {
    return {
      exam,
      warning: `This exam already has ${submissionCount} submission${submissionCount === 1 ? '' : 's'}. Existing submissions are not changed.`,
    };
  }
  return { exam };
}

export async function deleteFinalExam(courseId: string): Promise<void> {
  const course = await requireCourse(courseId);
  const quiz = await Quiz.findOne(finalExamFilter(course._id));
  if (!quiz) {
    throw AppError.notFound('Final exam not found');
  }
  await quiz.deleteOne();
}
