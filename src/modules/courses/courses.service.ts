import { Types, trusted } from 'mongoose';
import {
  RULES,
  finalExamPassMark,
  type CourseLevel,
  type CourseStatus,
  type Paginated,
  type Role,
} from '../../shared/index.js';
import { Course } from '../../models/Course.js';
import { Lesson } from '../../models/Lesson.js';
import { Progress } from '../../models/Progress.js';
import { Quiz } from '../../models/Quiz.js';
import { QuizAttempt } from '../../models/QuizAttempt.js';
import { ExamSubmission } from '../../models/ExamSubmission.js';
import { Badge } from '../../models/Badge.js';
import { Notification } from '../../models/Notification.js';
import { User } from '../../models/User.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../utils/logger.js';
import { slugify } from '../../utils/slugify.js';
import {
  computeFinalExamUnlocked,
  computeProgressPct,
} from '../progress/progress.service.js';
import { getStorageAdapter } from '../uploads/storage.adapter.js';
import type {
  CreateCourseBody,
  ListCoursesQuery,
  UpdateCourseBody,
} from './courses.schema.js';

export type CourseDto = {
  id: string;
  title: string;
  slug: string;
  description: string;
  thumbnailUrl: string | null;
  thumbnailPublicId?: string | null;
  category: string;
  level: CourseLevel;
  status: CourseStatus;
  lessonCount: number;
  totalDurationSec: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

function toCourseDto(
  course: {
    _id: Types.ObjectId;
    title: string;
    slug: string;
    description: string;
    thumbnailUrl?: string | null;
    thumbnailPublicId?: string | null;
    category: string;
    level: CourseLevel;
    status: CourseStatus;
    lessonCount: number;
    totalDurationSec: number;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
  },
  opts?: { includePublicId?: boolean },
): CourseDto {
  const dto: CourseDto = {
    id: course._id.toString(),
    title: course.title,
    slug: course.slug,
    description: course.description,
    thumbnailUrl: course.thumbnailUrl ?? null,
    category: course.category,
    level: course.level,
    status: course.status,
    lessonCount: course.lessonCount,
    totalDurationSec: course.totalDurationSec,
    createdBy: course.createdBy.toString(),
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
  };
  if (opts?.includePublicId !== false) {
    dto.thumbnailPublicId = course.thumbnailPublicId ?? null;
  }
  return dto;
}

async function deleteStoredThumbnail(publicId: string): Promise<void> {
  try {
    await getStorageAdapter().delete(publicId);
  } catch (error) {
    logger.warn(
      { err: error, publicId },
      'Failed to delete stored thumbnail asset',
    );
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function visibilityFilter(role: Role): Record<string, unknown> {
  if (role === 'super_admin') {
    return {};
  }
  return { status: 'published' };
}

async function uniqueSlug(baseTitle: string): Promise<string> {
  const base = slugify(baseTitle) || 'course';
  let candidate = base;
  let suffix = 2;

  while (await Course.exists({ slug: candidate })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

export async function listCourses(params: {
  query: ListCoursesQuery;
  role: Role;
}): Promise<Paginated<CourseDto>> {
  const filter: Record<string, unknown> = {
    ...visibilityFilter(params.role),
  };

  // Never let a 'user' widen visibility via ?status=
  if (params.role === 'super_admin' && params.query.status) {
    filter.status = params.query.status;
  }

  if (params.query.category) {
    filter.category = params.query.category;
  }
  if (params.query.level) {
    filter.level = params.query.level;
  }
  if (params.query.search) {
    const pattern = escapeRegex(params.query.search);
    filter.$or = trusted([
      { title: { $regex: pattern, $options: 'i' } },
      { description: { $regex: pattern, $options: 'i' } },
      { category: { $regex: pattern, $options: 'i' } },
    ]);
  }

  const skip = (params.query.page - 1) * params.query.limit;
  const [rows, total] = await Promise.all([
    Course.find(filter).sort({ createdAt: -1 }).skip(skip).limit(params.query.limit),
    Course.countDocuments(filter),
  ]);

  return {
    data: rows.map((row) =>
      toCourseDto(row, { includePublicId: params.role === 'super_admin' }),
    ),
    meta: {
      page: params.query.page,
      limit: params.query.limit,
      total,
    },
  };
}

export async function getCourseById(params: {
  courseId: string;
  role: Role;
}): Promise<CourseDto> {
  if (!Types.ObjectId.isValid(params.courseId)) {
    throw AppError.notFound('Course not found');
  }

  const course = await Course.findById(params.courseId);
  if (!course) {
    throw AppError.notFound('Course not found');
  }

  if (params.role !== 'super_admin' && course.status !== 'published') {
    throw AppError.notFound('Course not found');
  }

  return toCourseDto(course, {
    includePublicId: params.role === 'super_admin',
  });
}

export type CourseDetailLessonDto = {
  id: string;
  title: string;
  description: string;
  durationSec: number;
  order: number;
  isOptional: boolean;
  hasQuiz: boolean;
  quizMaxPoints: number | null;
  videoCompletedAt: string | null;
  videoPointsAwarded: number;
  bestQuizScore: number | null;
  quizPointsAwarded: number;
  quizAttempts: number;
};

export type CourseDetailFinalExamDto = {
  exists: true;
  unlocked: boolean;
  title: string;
  maxMarks: number;
  passMark: number;
  submissionStatus: null | 'submitted' | 'graded';
  marksAwarded: number | null;
  passed: boolean | null;
};

export type CourseDetailDto = {
  course: {
    id: string;
    title: string;
    slug: string;
    description: string;
    thumbnailUrl: string | null;
    category: string;
    level: CourseLevel;
    lessonCount: number;
    totalDurationSec: number;
  };
  lessons: CourseDetailLessonDto[];
  finalExam: CourseDetailFinalExamDto | null;
  summary: {
    completedLessonCount: number;
    progressPct: number;
    totalPointsEarned: number;
    lastLessonId: string | null;
  };
};

type DetailAggRow = {
  _id: Types.ObjectId;
  title: string;
  slug: string;
  description: string;
  thumbnailUrl?: string | null;
  category: string;
  level: CourseLevel;
  lessonCount: number;
  totalDurationSec: number;
  lessons: Array<{
    id: Types.ObjectId;
    title: string;
    description: string;
    durationSec: number;
    order: number;
    isOptional: boolean;
    hasQuiz: boolean;
    quizMaxPoints: number | null;
    videoCompletedAt: Date | null;
    videoPointsAwarded: boolean;
    bestQuizScore: number;
    quizPointsAwarded: number;
    quizAttempts: number;
  }>;
  progress?: {
    lastLessonId?: Types.ObjectId | null;
    lessons?: Array<{
      videoCompletedAt?: Date | null;
      videoPointsAwarded?: boolean;
      quizPointsAwarded?: number;
    }>;
  } | null;
  finalExamDoc?: {
    _id?: Types.ObjectId;
    title: string;
  } | null;
  finalSubmission?: {
    status: 'submitted' | 'graded';
    marksAwarded: number | null;
    passed: boolean | null;
  } | null;
};

/**
 * Learner course detail in a single Course.aggregate — never leaks quiz content.
 * Progress is always resolved from the authenticated userId.
 */
export async function getCourseDetailForLearner(params: {
  courseId: string;
  userId: string;
}): Promise<CourseDetailDto> {
  if (!Types.ObjectId.isValid(params.courseId) || !Types.ObjectId.isValid(params.userId)) {
    throw AppError.notFound('Course not found');
  }

  const courseOid = new Types.ObjectId(params.courseId);
  const userOid = new Types.ObjectId(params.userId);
  const videoPoints = RULES.VIDEO_POINTS;

  const rows = await Course.aggregate<DetailAggRow>([
    {
      $match: {
        _id: courseOid,
        status: 'published',
      },
    },
    {
      $lookup: {
        from: 'progresses',
        let: { courseId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$courseId', '$$courseId'] },
                  { $eq: ['$userId', userOid] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: 'progressDocs',
      },
    },
    {
      $lookup: {
        from: 'quizzes',
        let: { courseId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$courseId', '$$courseId'] },
                  { $eq: ['$scope', 'final_exam'] },
                ],
              },
            },
          },
          {
            $project: {
              title: 1,
            },
          },
          { $limit: 1 },
        ],
        as: 'finalExamDocs',
      },
    },
    {
      $addFields: {
        progress: { $arrayElemAt: ['$progressDocs', 0] },
        finalExamRaw: { $arrayElemAt: ['$finalExamDocs', 0] },
      },
    },
    {
      $lookup: {
        from: 'examsubmissions',
        let: { courseId: '$_id', uid: userOid },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$courseId', '$$courseId'] },
                  { $eq: ['$userId', '$$uid'] },
                ],
              },
            },
          },
          {
            $project: {
              status: 1,
              marksAwarded: 1,
              passed: 1,
            },
          },
          { $limit: 1 },
        ],
        as: 'finalSubmissionDocs',
      },
    },
    {
      $lookup: {
        from: 'lessons',
        let: {
          courseId: '$_id',
          progressLessons: { $ifNull: ['$progress.lessons', []] },
        },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$courseId', '$$courseId'] },
            },
          },
          { $sort: { order: 1 } },
          {
            $lookup: {
              from: 'quizzes',
              let: { lessonId: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$lessonId', '$$lessonId'] },
                        { $eq: ['$scope', 'lesson'] },
                      ],
                    },
                  },
                },
                {
                  $project: {
                    pointsPerQuestion: 1,
                    questionCount: { $size: { $ifNull: ['$questions', []] } },
                  },
                },
                { $limit: 1 },
              ],
              as: 'quizDocs',
            },
          },
          {
            $addFields: {
              quizDoc: { $arrayElemAt: ['$quizDocs', 0] },
              progressLesson: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: '$$progressLessons',
                      as: 'pl',
                      cond: { $eq: ['$$pl.lessonId', '$_id'] },
                    },
                  },
                  0,
                ],
              },
            },
          },
          {
            $project: {
              _id: 0,
              id: '$_id',
              title: 1,
              description: 1,
              durationSec: 1,
              order: 1,
              isOptional: 1,
              hasQuiz: { $cond: [{ $ne: ['$quizDoc', null] }, true, false] },
              quizMaxPoints: {
                $cond: [
                  { $ne: ['$quizDoc', null] },
                  {
                    $multiply: [
                      { $ifNull: ['$quizDoc.pointsPerQuestion', 0] },
                      { $ifNull: ['$quizDoc.questionCount', 0] },
                    ],
                  },
                  null,
                ],
              },
              videoCompletedAt: {
                $ifNull: ['$progressLesson.videoCompletedAt', null],
              },
              videoPointsAwarded: {
                $ifNull: ['$progressLesson.videoPointsAwarded', false],
              },
              bestQuizScore: {
                $cond: [
                  {
                    $gt: [{ $ifNull: ['$progressLesson.attempts', 0] }, 0],
                  },
                  { $ifNull: ['$progressLesson.bestQuizScore', 0] },
                  null,
                ],
              },
              quizPointsAwarded: {
                $ifNull: ['$progressLesson.quizPointsAwarded', 0],
              },
              quizAttempts: { $ifNull: ['$progressLesson.attempts', 0] },
            },
          },
        ],
        as: 'lessons',
      },
    },
    {
      $project: {
        title: 1,
        slug: 1,
        description: 1,
        thumbnailUrl: 1,
        category: 1,
        level: 1,
        lessonCount: 1,
        totalDurationSec: 1,
        lessons: 1,
        progress: 1,
        // Direct reference — avoid $cond document construction, which can yield
        // a truthy { title: null, ... } object when no exam exists.
        finalExamDoc: '$finalExamRaw',
        finalSubmission: { $arrayElemAt: ['$finalSubmissionDocs', 0] },
      },
    },
  ]);

  const row = rows[0];
  if (!row) {
    throw AppError.notFound('Course not found');
  }

  const lessons: CourseDetailLessonDto[] = row.lessons.map((lesson) => {
    const videoCompletedAt = lesson.videoCompletedAt
      ? new Date(lesson.videoCompletedAt).toISOString()
      : null;
    return {
      id: lesson.id.toString(),
      title: lesson.title,
      description: lesson.description,
      durationSec: lesson.durationSec,
      order: lesson.order,
      isOptional: Boolean(lesson.isOptional),
      hasQuiz: Boolean(lesson.hasQuiz),
      quizMaxPoints: lesson.quizMaxPoints,
      videoCompletedAt,
      videoPointsAwarded: lesson.videoPointsAwarded ? videoPoints : 0,
      bestQuizScore: lesson.bestQuizScore,
      quizPointsAwarded: lesson.quizPointsAwarded ?? 0,
      quizAttempts: lesson.quizAttempts ?? 0,
    };
  });

  const completedLessonCount = lessons.filter((l) => l.videoCompletedAt != null).length;
  const lessonCount = row.lessonCount;
  const lessonPoints = lessons.reduce(
    (sum, l) => sum + l.videoPointsAwarded + l.quizPointsAwarded,
    0,
  );
  const submission = row.finalSubmission ?? null;
  const finalExamPoints =
    submission?.status === 'graded' && typeof submission.marksAwarded === 'number'
      ? submission.marksAwarded
      : 0;

  const examDoc =
    row.finalExamDoc && row.finalExamDoc.title != null ? row.finalExamDoc : null;
  const finalExists = examDoc != null;
  const unlocked = computeFinalExamUnlocked({
    completedLessonCount,
    lessonCount,
    finalExamExists: finalExists,
  });

  let finalExam: CourseDetailFinalExamDto | null = null;
  if (examDoc) {
    finalExam = {
      exists: true,
      unlocked,
      title: examDoc.title,
      maxMarks: RULES.FINAL_EXAM_MAX_MARKS,
      passMark: finalExamPassMark(),
      submissionStatus: submission?.status ?? null,
      marksAwarded:
        submission?.status === 'graded' ? (submission.marksAwarded ?? null) : null,
      passed: submission?.status === 'graded' ? (submission.passed ?? null) : null,
    };
  }

  return {
    course: {
      id: row._id.toString(),
      title: row.title,
      slug: row.slug,
      description: row.description,
      thumbnailUrl: row.thumbnailUrl ?? null,
      category: row.category,
      level: row.level,
      lessonCount,
      totalDurationSec: row.totalDurationSec ?? 0,
    },
    lessons,
    finalExam,
    summary: {
      completedLessonCount,
      progressPct: computeProgressPct(completedLessonCount, lessonCount),
      totalPointsEarned: lessonPoints + finalExamPoints,
      lastLessonId: row.progress?.lastLessonId
        ? row.progress.lastLessonId.toString()
        : null,
    },
  };
}

export async function createCourse(params: {
  body: CreateCourseBody;
  createdById: string;
}): Promise<CourseDto> {
  if (params.body.status === 'published') {
    throw new AppError(
      'VALIDATION_ERROR',
      'A course with zero lessons cannot be published',
    );
  }

  const slug = await uniqueSlug(params.body.title);
  const course = await Course.create({
    title: params.body.title,
    slug,
    description: params.body.description,
    thumbnailUrl: params.body.thumbnailUrl,
    thumbnailPublicId: params.body.thumbnailPublicId ?? null,
    category: params.body.category,
    level: params.body.level,
    status: params.body.status ?? 'draft',
    lessonCount: 0,
    totalDurationSec: 0,
    createdBy: new Types.ObjectId(params.createdById),
  });

  return toCourseDto(course);
}

export async function updateCourse(params: {
  courseId: string;
  body: UpdateCourseBody;
}): Promise<CourseDto> {
  if (!Types.ObjectId.isValid(params.courseId)) {
    throw AppError.notFound('Course not found');
  }

  const course = await Course.findById(params.courseId);
  if (!course) {
    throw AppError.notFound('Course not found');
  }

  if (params.body.status === 'published' && course.lessonCount < 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      'A course with zero lessons cannot be published',
    );
  }

  const previousPublicId = course.thumbnailPublicId ?? null;

  if (params.body.title !== undefined) {
    course.title = params.body.title;
    // Slug is immutable after creation — do not regenerate.
  }
  if (params.body.description !== undefined) {
    course.description = params.body.description;
  }
  if (params.body.thumbnailUrl !== undefined) {
    course.thumbnailUrl = params.body.thumbnailUrl ?? undefined;
  }
  if (params.body.thumbnailPublicId !== undefined) {
    course.thumbnailPublicId = params.body.thumbnailPublicId ?? null;
  }
  if (params.body.category !== undefined) {
    course.category = params.body.category;
  }
  if (params.body.level !== undefined) {
    course.level = params.body.level;
  }
  if (params.body.status !== undefined) {
    course.status = params.body.status;
  }

  await course.save();

  const nextPublicId = course.thumbnailPublicId ?? null;
  if (previousPublicId && previousPublicId !== nextPublicId) {
    await deleteStoredThumbnail(previousPublicId);
  }

  return toCourseDto(course);
}

export type CourseDeletionImpact = {
  learnersWithProgress: number;
  pointsAtStake: number;
};

function lessonPointsEarned(lessons: { videoPointsAwarded?: boolean; quizPointsAwarded?: number }[]): number {
  let points = 0;
  for (const lesson of lessons) {
    if (lesson.videoPointsAwarded) {
      points += RULES.VIDEO_POINTS;
    }
    points += lesson.quizPointsAwarded ?? 0;
  }
  return points;
}

async function coursePointsByUser(courseId: Types.ObjectId): Promise<{
  learnersWithProgress: number;
  pointsAtStake: number;
  pointsByUser: Map<string, number>;
}> {
  const [progressRows, examRows] = await Promise.all([
    Progress.find({ courseId }).select('userId lessons').lean(),
    ExamSubmission.find({ courseId, status: 'graded' }).select('userId marksAwarded').lean(),
  ]);

  const pointsByUser = new Map<string, number>();
  const add = (userId: Types.ObjectId, amount: number) => {
    if (amount <= 0) return;
    const key = userId.toString();
    pointsByUser.set(key, (pointsByUser.get(key) ?? 0) + amount);
  };

  for (const row of progressRows) {
    add(row.userId, lessonPointsEarned(row.lessons ?? []));
  }
  for (const row of examRows) {
    if (typeof row.marksAwarded === 'number') {
      add(row.userId, row.marksAwarded);
    }
  }

  let pointsAtStake = 0;
  for (const amount of pointsByUser.values()) {
    pointsAtStake += amount;
  }

  return {
    learnersWithProgress: progressRows.length,
    pointsAtStake,
    pointsByUser,
  };
}

export async function getCourseDeletionImpact(params: {
  courseId: string;
}): Promise<CourseDeletionImpact> {
  if (!Types.ObjectId.isValid(params.courseId)) {
    throw AppError.notFound('Course not found');
  }

  const course = await Course.findById(params.courseId).select('_id');
  if (!course) {
    throw AppError.notFound('Course not found');
  }

  const impact = await coursePointsByUser(course._id);
  return {
    learnersWithProgress: impact.learnersWithProgress,
    pointsAtStake: impact.pointsAtStake,
  };
}

async function subtractCoursePoints(pointsByUser: Map<string, number>): Promise<void> {
  if (pointsByUser.size === 0) return;

  const ids = [...pointsByUser.keys()].map((id) => new Types.ObjectId(id));
  const users = await User.find({ _id: trusted({ $in: ids }) })
    .select('totalPoints')
    .lean();

  if (users.length === 0) return;

  await User.bulkWrite(
    users.map((user) => {
      const remove = pointsByUser.get(user._id.toString()) ?? 0;
      return {
        updateOne: {
          filter: { _id: user._id },
          update: {
            $set: { totalPoints: Math.max(0, (user.totalPoints ?? 0) - remove) },
          },
        },
      };
    }),
  );
}

export async function deleteCourse(params: {
  courseId: string;
}): Promise<void> {
  if (!Types.ObjectId.isValid(params.courseId)) {
    throw AppError.notFound('Course not found');
  }

  const course = await Course.findById(params.courseId);
  if (!course) {
    throw AppError.notFound('Course not found');
  }

  const courseId = course._id;
  const impact = await coursePointsByUser(courseId);
  await subtractCoursePoints(impact.pointsByUser);

  const lessons = await Lesson.find({ courseId }).select('_id').lean();
  const lessonIds = lessons.map((lesson) => lesson._id);
  if (lessonIds.length > 0) {
    await QuizAttempt.deleteMany({
      lessonId: trusted({ $in: lessonIds }),
    });
  }

  await Promise.all([
    Quiz.deleteMany({ courseId }),
    ExamSubmission.deleteMany({ courseId }),
    Badge.deleteMany({ courseId }),
    Progress.deleteMany({ courseId }),
    Lesson.deleteMany({ courseId }),
    Notification.deleteMany({ 'metadata.courseId': courseId.toString() }),
  ]);

  const publicId = course.thumbnailPublicId ?? null;
  await course.deleteOne();
  if (publicId) {
    await deleteStoredThumbnail(publicId);
  }
}
