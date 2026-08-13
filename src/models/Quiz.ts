import {
  Schema,
  model,
  type InferSchemaType,
  type Model,
  type Types,
} from 'mongoose';
import { RULES } from '@shared';

export type QuizScope = 'lesson' | 'final_exam';

export interface IQuizQuestion {
  _id: Types.ObjectId;
  text: string;
  /** Lesson quizzes only — empty / unused for final exams. */
  options: string[];
  /** Lesson quizzes only — absent / unused for final exams. */
  correctIndex?: number;
  order: number;
}

export interface IQuiz {
  scope: QuizScope;
  courseId: Types.ObjectId;
  lessonId?: Types.ObjectId | null;
  title: string;
  /** Learner-facing instructions (final exams). Unused for lesson quizzes. */
  instructions: string;
  pointsPerQuestion: number;
  passingScorePct: number;
  /** null = unlimited. Final exams do not use attempts — always null. */
  maxAttempts: number | null;
  questions: IQuizQuestion[];
  createdAt: Date;
  updatedAt: Date;
}

/** Canonical filter for a lesson-scoped quiz — use everywhere (admin + learner). */
export function lessonQuizFilter(lessonId: Types.ObjectId | string) {
  return { lessonId, scope: 'lesson' as const };
}

/** Canonical filter for a course final exam — use everywhere (admin + learner). */
export function finalExamFilter(courseId: Types.ObjectId | string) {
  return { courseId, scope: 'final_exam' as const };
}

function parentScope(doc: { parent?: () => { scope?: QuizScope } | null }): QuizScope | undefined {
  const parent = typeof doc.parent === 'function' ? doc.parent() : null;
  return parent?.scope;
}

const quizQuestionSchema = new Schema<IQuizQuestion>(
  {
    text: { type: String, required: true, trim: true },
    options: {
      type: [String],
      default: [],
      validate: {
        validator(this: IQuizQuestion & { parent?: () => { scope?: QuizScope } | null }, options: string[]) {
          if (parentScope(this) === 'final_exam') {
            return true;
          }
          return Array.isArray(options) && options.length >= 2;
        },
        message: 'Each question must have at least 2 options',
      },
    },
    correctIndex: {
      type: Number,
      required: false,
      select: false,
      validate: {
        validator(
          this: IQuizQuestion & { parent?: () => { scope?: QuizScope } | null },
          value: number | undefined,
        ) {
          if (parentScope(this) === 'final_exam') {
            return value === undefined || value === null;
          }
          return (
            typeof value === 'number' &&
            Number.isInteger(value) &&
            value >= 0 &&
            Array.isArray(this.options) &&
            value < this.options.length
          );
        },
        message: 'correctIndex must be within the options range',
      },
    },
    order: { type: Number, required: true },
  },
  { _id: true },
);

const quizSchema = new Schema<IQuiz>(
  {
    scope: {
      type: String,
      enum: ['lesson', 'final_exam'] satisfies QuizScope[],
      required: true,
    },
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    lessonId: {
      type: Schema.Types.ObjectId,
      ref: 'Lesson',
      required: function requiredLessonId(this: IQuiz) {
        return this.scope === 'lesson';
      },
      default: null,
    },
    title: { type: String, required: true, trim: true },
    instructions: { type: String, default: '', trim: true },
    pointsPerQuestion: {
      type: Number,
      default: RULES.DEFAULT_POINTS_PER_QUESTION,
      min: 1,
    },
    passingScorePct: {
      type: Number,
      default: RULES.DEFAULT_PASSING_SCORE_PCT,
      min: 0,
      max: 100,
    },
    maxAttempts: {
      type: Number,
      default: null,
      validate: {
        validator(value: number | null) {
          return value === null || (Number.isInteger(value) && value >= 1);
        },
        message: 'maxAttempts must be null (unlimited) or an integer >= 1',
      },
    },
    questions: {
      type: [quizQuestionSchema],
      required: true,
      validate: {
        validator(questions: IQuizQuestion[]) {
          return Array.isArray(questions) && questions.length > 0;
        },
        message: 'Quiz must include at least one question',
      },
    },
  },
  { timestamps: true },
);

quizSchema.pre('validate', function (next) {
  if (this.scope === 'final_exam') {
    this.lessonId = null;
    this.maxAttempts = null;
    this.passingScorePct = RULES.FINAL_EXAM_PASS_PCT;
    this.pointsPerQuestion = RULES.DEFAULT_POINTS_PER_QUESTION;
    if (this.instructions == null) {
      this.instructions = '';
    }
    for (const question of this.questions ?? []) {
      question.options = [];
      question.correctIndex = undefined;
    }
  } else if (this.maxAttempts === undefined) {
    this.maxAttempts = null;
  }
  next();
});

/**
 * insertMany can skip document middleware in some paths; force full validation
 * so required scope/courseId cannot be silently omitted (the failure mode that
 * made learner lookups return null while a row still existed).
 */
quizSchema.pre('insertMany', async function (next, docs) {
  const rows = Array.isArray(docs) ? docs : [docs];
  try {
    for (const row of rows) {
      const doc = new this(row);
      await doc.validate();
    }
    next();
  } catch (error) {
    next(error as Error);
  }
});

// At most one lesson quiz per lesson
quizSchema.index(
  { lessonId: 1 },
  {
    name: 'lesson_quiz_unique',
    unique: true,
    partialFilterExpression: {
      scope: 'lesson',
      lessonId: { $type: 'objectId' },
    },
  },
);

// Non-unique course lookup for lesson quizzes + admin lists
quizSchema.index({ courseId: 1, scope: 1 }, { name: 'course_scope_lookup' });

// At most one final exam per course
quizSchema.index(
  { courseId: 1 },
  {
    name: 'final_exam_unique',
    unique: true,
    partialFilterExpression: { scope: 'final_exam' },
  },
);

export type QuizDocument = InferSchemaType<typeof quizSchema> & {
  _id: Types.ObjectId;
};

export const Quiz: Model<IQuiz> = model<IQuiz>('Quiz', quizSchema);

/**
 * Fail loudly if any Quiz row is missing required identity fields.
 * Uses the raw collection so schema defaults cannot hide the corruption.
 */
export async function assertQuizDocumentsIntegrity(): Promise<void> {
  const invalid = await Quiz.collection
    .find({
      $or: [
        { scope: { $exists: false } },
        { scope: null },
        { scope: '' },
        { courseId: { $exists: false } },
        { courseId: null },
      ],
    })
    .project({ _id: 1, title: 1, lessonId: 1, scope: 1, courseId: 1 })
    .limit(25)
    .toArray();

  if (invalid.length === 0) return;

  const summary = invalid
    .map((row) => {
      const id = String(row._id);
      const title = typeof row.title === 'string' ? row.title : '(untitled)';
      return `${id} (${title})`;
    })
    .join(', ');

  throw new Error(
    `Invalid Quiz document(s) missing scope and/or courseId: ${summary}. Re-run the seed or repair data before serving traffic.`,
  );
}
