import { Types } from 'mongoose';
import { RULES } from '../../shared/index.js';
import { Course } from '../../models/Course.js';
import { Lesson } from '../../models/Lesson.js';
import { Progress } from '../../models/Progress.js';
import { Quiz, lessonQuizFilter } from '../../models/Quiz.js';
import { AppError } from '../../utils/AppError.js';
import { parseYouTubeVideoId } from '../../utils/youtube.js';
import type {
  CreateLessonBody,
  ReorderLessonsBody,
  UpdateLessonBody,
} from './lessons.schema.js';

export type LessonDto = {
  id: string;
  courseId: string;
  title: string;
  description: string;
  youtubeVideoId: string;
  durationSec: number;
  requiredWatchSec: number;
  watchTargetOverridden: boolean;
  order: number;
  isOptional: boolean;
  hasQuiz: boolean;
  createdAt: string;
  updatedAt: string;
  /** Present when duration changed under an existing manual watch-target override. */
  warning?: string;
};

function requiredWatchSecFor(durationSec: number): number {
  return Math.ceil(durationSec * RULES.VIDEO_COMPLETION_RATIO);
}

function assertRequiredWatchSecFitsDuration(
  requiredWatchSec: number,
  durationSec: number,
): void {
  if (requiredWatchSec > durationSec) {
    throw AppError.validation(
      `requiredWatchSec (${requiredWatchSec}) cannot be greater than durationSec (${durationSec})`,
    );
  }
}

function toLessonDto(
  lesson: {
    _id: Types.ObjectId;
    courseId: Types.ObjectId;
    title: string;
    description: string;
    youtubeVideoId: string;
    durationSec: number;
    requiredWatchSec: number;
    watchTargetOverridden?: boolean;
    order: number;
    isOptional: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  hasQuiz: boolean,
  warning?: string,
): LessonDto {
  return {
    id: lesson._id.toString(),
    courseId: lesson.courseId.toString(),
    title: lesson.title,
    description: lesson.description,
    youtubeVideoId: lesson.youtubeVideoId,
    durationSec: lesson.durationSec,
    requiredWatchSec: lesson.requiredWatchSec,
    watchTargetOverridden: Boolean(lesson.watchTargetOverridden),
    order: lesson.order,
    isOptional: lesson.isOptional,
    hasQuiz,
    createdAt: lesson.createdAt.toISOString(),
    updatedAt: lesson.updatedAt.toISOString(),
    ...(warning ? { warning } : {}),
  };
}

async function quizIdsForLessons(
  lessonIds: Types.ObjectId[],
): Promise<Set<string>> {
  if (lessonIds.length === 0) return new Set();
  // Avoid `{ lessonId: { $in } }` under global sanitizeFilter (casts $in as a value).
  const quizzes = await Promise.all(
    lessonIds.map((id) => Quiz.exists(lessonQuizFilter(id))),
  );
  const hasQuiz = new Set<string>();
  quizzes.forEach((exists, index) => {
    if (exists) hasQuiz.add(lessonIds[index]!.toString());
  });
  return hasQuiz;
}

async function recomputeCourseStats(courseId: Types.ObjectId): Promise<void> {
  const lessons = await Lesson.find({ courseId }).select('durationSec').lean();
  await Course.updateOne(
    { _id: courseId },
    {
      $set: {
        lessonCount: lessons.length,
        totalDurationSec: lessons.reduce((sum, row) => sum + row.durationSec, 0),
      },
    },
  );
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

export async function listLessons(courseId: string): Promise<LessonDto[]> {
  await requireCourse(courseId);

  const lessons = await Lesson.find({ courseId }).sort({ order: 1 });
  const hasQuiz = await quizIdsForLessons(lessons.map((l) => l._id));

  return lessons.map((lesson) =>
    toLessonDto(lesson, hasQuiz.has(lesson._id.toString())),
  );
}

export async function createLesson(params: {
  courseId: string;
  body: CreateLessonBody;
}): Promise<LessonDto> {
  const course = await requireCourse(params.courseId);
  const youtubeVideoId = parseYouTubeVideoId(params.body.youtubeVideoId);
  const durationSec = params.body.durationSec;

  let requiredWatchSec = requiredWatchSecFor(durationSec);
  let watchTargetOverridden = false;
  if (params.body.requiredWatchSec !== undefined) {
    assertRequiredWatchSecFitsDuration(params.body.requiredWatchSec, durationSec);
    requiredWatchSec = params.body.requiredWatchSec;
    watchTargetOverridden = true;
  }

  const maxOrder = await Lesson.findOne({ courseId: course._id })
    .sort({ order: -1 })
    .select('order')
    .lean();
  const order = (maxOrder?.order ?? 0) + 10;

  const lesson = await Lesson.create({
    courseId: course._id,
    title: params.body.title,
    description: params.body.description,
    youtubeVideoId,
    durationSec,
    requiredWatchSec,
    watchTargetOverridden,
    order,
    isOptional: params.body.isOptional ?? false,
  });

  await recomputeCourseStats(course._id);

  return toLessonDto(lesson, false);
}

export async function updateLesson(params: {
  lessonId: string;
  body: UpdateLessonBody;
}): Promise<LessonDto> {
  if (!Types.ObjectId.isValid(params.lessonId)) {
    throw AppError.notFound('Lesson not found');
  }

  const lesson = await Lesson.findById(params.lessonId);
  if (!lesson) {
    throw AppError.notFound('Lesson not found');
  }

  if (params.body.title !== undefined) {
    lesson.title = params.body.title;
  }
  if (params.body.description !== undefined) {
    lesson.description = params.body.description;
  }
  if (params.body.youtubeVideoId !== undefined) {
    lesson.youtubeVideoId = parseYouTubeVideoId(params.body.youtubeVideoId);
  }
  if (params.body.isOptional !== undefined) {
    lesson.isOptional = params.body.isOptional;
  }

  const durationChanged = params.body.durationSec !== undefined;
  const nextDurationSec = params.body.durationSec ?? lesson.durationSec;
  const requestedWatchSec = params.body.requiredWatchSec;
  let warning: string | undefined;

  if (durationChanged) {
    lesson.durationSec = params.body.durationSec!;
  }

  if (requestedWatchSec !== undefined) {
    if (requestedWatchSec === null) {
      lesson.watchTargetOverridden = false;
      lesson.requiredWatchSec = requiredWatchSecFor(nextDurationSec);
    } else {
      assertRequiredWatchSecFitsDuration(requestedWatchSec, nextDurationSec);
      lesson.requiredWatchSec = requestedWatchSec;
      lesson.watchTargetOverridden = true;
    }
  } else if (durationChanged) {
    if (lesson.watchTargetOverridden) {
      warning =
        `requiredWatchSec (${lesson.requiredWatchSec}) was left unchanged because it was ` +
        `manually overridden; it may no longer suit the new durationSec (${nextDurationSec})`;
    } else {
      lesson.requiredWatchSec = requiredWatchSecFor(nextDurationSec);
    }
  }

  await lesson.save();
  await recomputeCourseStats(lesson.courseId);

  const hasQuiz = await Quiz.exists(lessonQuizFilter(lesson._id));
  return toLessonDto(lesson, Boolean(hasQuiz), warning);
}

export async function deleteLesson(lessonId: string): Promise<void> {
  if (!Types.ObjectId.isValid(lessonId)) {
    throw AppError.notFound('Lesson not found');
  }

  const lesson = await Lesson.findById(lessonId);
  if (!lesson) {
    throw AppError.notFound('Lesson not found');
  }

  const course = await Course.findById(lesson.courseId);
  if (!course) {
    throw AppError.notFound('Course not found');
  }

  const lessonCount = await Lesson.countDocuments({ courseId: course._id });
  if (course.status === 'published' && lessonCount <= 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Cannot delete the last lesson of a published course. Unpublish the course first.',
    );
  }

  const oid = lesson._id;
  await Quiz.deleteOne(lessonQuizFilter(oid));
  await Progress.updateMany(
    { 'lessons.lessonId': oid },
    { $pull: { lessons: { lessonId: oid } } },
  );
  await Progress.updateMany(
    { lastLessonId: oid },
    { $unset: { lastLessonId: 1 } },
  );
  await lesson.deleteOne();
  await recomputeCourseStats(course._id);
}

export async function reorderLessons(params: {
  courseId: string;
  body: ReorderLessonsBody;
}): Promise<LessonDto[]> {
  const course = await requireCourse(params.courseId);
  const { lessonIds } = params.body;

  if (new Set(lessonIds).size !== lessonIds.length) {
    throw new AppError(
      'VALIDATION_ERROR',
      'lessonIds must not contain duplicates',
    );
  }

  for (const id of lessonIds) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'lessonIds must contain only valid lesson ids for this course',
      );
    }
  }

  const existing = await Lesson.find({ courseId: course._id }).select('_id');
  const existingSet = new Set(existing.map((row) => row._id.toString()));

  if (existingSet.size !== lessonIds.length) {
    throw new AppError(
      'VALIDATION_ERROR',
      'lessonIds must contain exactly the lessons for this course',
    );
  }

  for (const id of lessonIds) {
    if (!existingSet.has(id)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'lessonIds must contain exactly the lessons for this course',
      );
    }
  }

  // Two-phase in one ordered bulkWrite: move to unique temp orders first so
  // intermediate states never collide on the { courseId, order } unique index.
  const tempOps = lessonIds.map((id, index) => ({
    updateOne: {
      filter: { _id: new Types.ObjectId(id), courseId: course._id },
      update: { $set: { order: -(index + 1) } },
    },
  }));
  const finalOps = lessonIds.map((id, index) => ({
    updateOne: {
      filter: { _id: new Types.ObjectId(id), courseId: course._id },
      update: { $set: { order: (index + 1) * 10 } },
    },
  }));

  await Lesson.bulkWrite([...tempOps, ...finalOps], { ordered: true });
  await recomputeCourseStats(course._id);

  return listLessons(params.courseId);
}

export type LearningLessonDto = {
  id: string;
  courseId: string;
  title: string;
  description: string;
  youtubeVideoId: string;
  durationSec: number;
  requiredWatchSec: number;
  order: number;
  isOptional: boolean;
};

export type LearningCourseNavLessonDto = {
  id: string;
  title: string;
  order: number;
  durationSec: number;
  videoCompletedAt: string | null;
  hasQuiz: boolean;
};

export type LearningProgressDto = {
  watchedSec: number;
  videoCompletedAt: string | null;
  videoPointsAwarded: number;
  bestQuizScore: number | null;
  quizPointsAwarded: number;
  quizAttempts: number;
};

export type LearningQuizSummaryDto = {
  exists: true;
  title: string;
  questionCount: number;
  maxPoints: number;
};

export type LearningLessonDetailDto = {
  lesson: LearningLessonDto;
  courseNav: {
    courseId: string;
    courseTitle: string;
    lessons: LearningCourseNavLessonDto[];
    prevLessonId: string | null;
    nextLessonId: string | null;
  };
  progress: LearningProgressDto;
  quiz: LearningQuizSummaryDto | null;
};

type LearningAggRow = {
  _id: Types.ObjectId;
  courseId: Types.ObjectId;
  title: string;
  description: string;
  youtubeVideoId: string;
  durationSec: number;
  requiredWatchSec: number;
  order: number;
  isOptional: boolean;
  course?: {
    _id: Types.ObjectId;
    title: string;
    status: string;
  } | null;
  progress?: {
    lessons?: Array<{
      lessonId: Types.ObjectId;
      watchedSec?: number;
      videoCompletedAt?: Date | null;
      videoPointsAwarded?: boolean;
      bestQuizScore?: number;
      quizPointsAwarded?: number;
      attempts?: number;
    }>;
  } | null;
  siblings: Array<{
    id: Types.ObjectId;
    title: string;
    order: number;
    durationSec: number;
    hasQuiz: boolean;
    videoCompletedAt: Date | null;
  }>;
  quizDoc?: {
    title: string;
    pointsPerQuestion: number;
    questionCount: number;
  } | null;
};

/**
 * Learner learning-page payload in one Lesson.aggregate.
 * Never returns quiz question content. Progress is always the caller's.
 */
export async function getLessonLearningDetail(params: {
  lessonId: string;
  userId: string;
}): Promise<LearningLessonDetailDto> {
  if (!Types.ObjectId.isValid(params.lessonId) || !Types.ObjectId.isValid(params.userId)) {
    throw AppError.notFound('Lesson not found');
  }

  const lessonOid = new Types.ObjectId(params.lessonId);
  const userOid = new Types.ObjectId(params.userId);
  const videoPoints = RULES.VIDEO_POINTS;

  const rows = await Lesson.aggregate<LearningAggRow>([
    { $match: { _id: lessonOid } },
    {
      $lookup: {
        from: 'courses',
        localField: 'courseId',
        foreignField: '_id',
        as: 'courseDocs',
      },
    },
    {
      $addFields: {
        course: { $arrayElemAt: ['$courseDocs', 0] },
      },
    },
    {
      $match: {
        'course.status': 'published',
      },
    },
    {
      $lookup: {
        from: 'progresses',
        let: { courseId: '$courseId' },
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
              title: 1,
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
        progress: { $arrayElemAt: ['$progressDocs', 0] },
        quizDoc: { $arrayElemAt: ['$quizDocs', 0] },
      },
    },
    {
      $lookup: {
        from: 'lessons',
        let: {
          courseId: '$courseId',
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
                { $project: { _id: 1 } },
                { $limit: 1 },
              ],
              as: 'siblingQuizDocs',
            },
          },
          {
            $addFields: {
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
              order: 1,
              durationSec: 1,
              hasQuiz: {
                $gt: [{ $size: '$siblingQuizDocs' }, 0],
              },
              videoCompletedAt: {
                $ifNull: ['$progressLesson.videoCompletedAt', null],
              },
            },
          },
        ],
        as: 'siblings',
      },
    },
    {
      $project: {
        title: 1,
        description: 1,
        youtubeVideoId: 1,
        durationSec: 1,
        requiredWatchSec: 1,
        order: 1,
        isOptional: 1,
        courseId: 1,
        course: 1,
        progress: 1,
        quizDoc: '$quizDoc',
        siblings: 1,
      },
    },
  ]);

  const row = rows[0];
  if (!row || !row.course) {
    throw AppError.notFound('Lesson not found');
  }

  const siblings = row.siblings ?? [];
  const index = siblings.findIndex((s) => s.id.toString() === lessonOid.toString());
  const prevLessonId =
    index > 0 ? siblings[index - 1]!.id.toString() : null;
  const nextLessonId =
    index >= 0 && index < siblings.length - 1
      ? siblings[index + 1]!.id.toString()
      : null;

  const progressLessons = row.progress?.lessons ?? [];
  const own = progressLessons.find(
    (pl) => pl.lessonId.toString() === lessonOid.toString(),
  );

  const attempts = own?.attempts ?? 0;
  const progress: LearningProgressDto = {
    watchedSec: own?.watchedSec ?? 0,
    videoCompletedAt: own?.videoCompletedAt
      ? new Date(own.videoCompletedAt).toISOString()
      : null,
    videoPointsAwarded: own?.videoPointsAwarded ? videoPoints : 0,
    bestQuizScore: attempts > 0 ? (own?.bestQuizScore ?? 0) : null,
    quizPointsAwarded: own?.quizPointsAwarded ?? 0,
    quizAttempts: attempts,
  };

  let quiz: LearningQuizSummaryDto | null = null;
  if (row.quizDoc && row.quizDoc.title != null) {
    quiz = {
      exists: true,
      title: row.quizDoc.title,
      questionCount: row.quizDoc.questionCount,
      maxPoints:
        (row.quizDoc.pointsPerQuestion ?? 0) * (row.quizDoc.questionCount ?? 0),
    };
  }

  return {
    lesson: {
      id: row._id.toString(),
      courseId: row.courseId.toString(),
      title: row.title,
      description: row.description,
      youtubeVideoId: row.youtubeVideoId,
      durationSec: row.durationSec,
      requiredWatchSec: row.requiredWatchSec,
      order: row.order,
      isOptional: Boolean(row.isOptional),
    },
    courseNav: {
      courseId: row.course._id.toString(),
      courseTitle: row.course.title,
      lessons: siblings.map((s) => ({
        id: s.id.toString(),
        title: s.title,
        order: s.order,
        durationSec: s.durationSec,
        videoCompletedAt: s.videoCompletedAt
          ? new Date(s.videoCompletedAt).toISOString()
          : null,
        hasQuiz: Boolean(s.hasQuiz),
      })),
      prevLessonId,
      nextLessonId,
    },
    progress,
    quiz,
  };
}
