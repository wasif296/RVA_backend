import { Types, trusted, type PipelineStage } from 'mongoose';
import { RULES, finalExamPassMark } from '../../shared/index.js';
import { User } from '../../models/User.js';
import { AppError } from '../../utils/AppError.js';
import {
  listBadgesForUser,
  type BadgeDto,
} from '../grading/grading.service.js';

/** Shared progress math — used by dashboard and course detail. */
export function computeProgressPct(
  completedLessonCount: number,
  lessonCount: number,
): number {
  if (lessonCount <= 0) return 0;
  return Math.min(100, Math.round((completedLessonCount / lessonCount) * 1000) / 10);
}

export function computeFinalExamUnlocked(params: {
  completedLessonCount: number;
  lessonCount: number;
  finalExamExists: boolean;
}): boolean {
  return (
    params.finalExamExists &&
    params.lessonCount > 0 &&
    params.completedLessonCount === params.lessonCount
  );
}

export type InProgressCourseDto = {
  courseId: string;
  courseTitle: string;
  thumbnailUrl: string | null;
  lessonId: string;
  lessonTitle: string;
  courseProgressPct: number;
  completedLessonCount: number;
  lessonCount: number;
  lastActivityAt: string;
};

export type ProgressCourseDto = {
  courseId: string;
  title: string;
  thumbnailUrl: string | null;
  category: string;
  level: string;
  lessonCount: number;
  completedLessonCount: number;
  progressPct: number;
  totalPointsEarned: number;
  finalExamUnlocked: boolean;
  finalExamCompleted: boolean;
  lastLessonId: string | null;
};

export type ProgressSummaryDto = {
  totalPoints: number;
  coursesStarted: number;
  coursesCompleted: number;
  lessonsCompleted: number;
  inProgress: InProgressCourseDto[];
  courses: ProgressCourseDto[];
  badges: BadgeDto[];
};

type AggCourse = {
  courseId: Types.ObjectId;
  title: string;
  thumbnailUrl?: string | null;
  category: string;
  level: string;
  lessonCount: number;
  completedLessonCount: number;
  progressPct: number;
  totalPointsEarned: number;
  finalExamUnlocked: boolean;
  finalExamCompleted: boolean;
  lastLessonId?: Types.ObjectId | null;
  lastLessonTitle?: string | null;
  lastActivityAt?: Date | null;
  hasProgress: boolean;
  hasStarted: boolean;
};

type AggResult = {
  totalPoints: number;
  courses: AggCourse[];
};

/**
 * Builds the learner dashboard payload in a single User.aggregate pipeline.
 * Identity is always the authenticated userId — never a client-supplied id.
 */
export async function getProgressSummary(userId: string): Promise<ProgressSummaryDto> {
  if (!Types.ObjectId.isValid(userId)) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }

  const uid = new Types.ObjectId(userId);
  const videoPoints = RULES.VIDEO_POINTS;

  const rows = await User.aggregate<AggResult>([
    { $match: { _id: uid } },
    {
      $lookup: {
        from: 'courses',
        let: { uid: '$_id' },
        pipeline: [
          { $match: { status: 'published' } },
          { $sort: { title: 1 } },
          {
            $lookup: {
              from: 'progresses',
              let: { courseId: '$_id', uid: '$$uid' },
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
                { $project: { _id: 1 } },
                { $limit: 1 },
              ],
              as: 'finalExamDocs',
            },
          },
          {
            $addFields: {
              progress: { $arrayElemAt: ['$progressDocs', 0] },
              finalExamId: { $arrayElemAt: ['$finalExamDocs._id', 0] },
            },
          },
          {
            $lookup: {
              from: 'examsubmissions',
              let: { courseId: '$_id', uid: '$$uid' },
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
              let: { lessonId: '$progress.lastLessonId' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $ne: ['$$lessonId', null] },
                        { $eq: ['$_id', '$$lessonId'] },
                      ],
                    },
                  },
                },
                { $project: { title: 1 } },
                { $limit: 1 },
              ],
              as: 'lastLessonDocs',
            },
          },
          {
            $addFields: {
              completedLessonCount: {
                $size: {
                  $filter: {
                    input: { $ifNull: ['$progress.lessons', []] },
                    as: 'lesson',
                    cond: { $gt: ['$$lesson.videoCompletedAt', null] },
                  },
                },
              },
              lessonPoints: {
                $reduce: {
                  input: { $ifNull: ['$progress.lessons', []] },
                  initialValue: 0,
                  in: {
                    $add: [
                      '$$value',
                      {
                        $cond: [
                          { $eq: ['$$this.videoPointsAwarded', true] },
                          videoPoints,
                          0,
                        ],
                      },
                      { $ifNull: ['$$this.quizPointsAwarded', 0] },
                    ],
                  },
                },
              },
              finalSubmission: { $arrayElemAt: ['$finalSubmissionDocs', 0] },
              lastLessonTitle: { $arrayElemAt: ['$lastLessonDocs.title', 0] },
            },
          },
          {
            $addFields: {
              progressPct: {
                $cond: [
                  { $lte: ['$lessonCount', 0] },
                  0,
                  {
                    $min: [
                      100,
                      {
                        $multiply: [
                          { $divide: ['$completedLessonCount', '$lessonCount'] },
                          100,
                        ],
                      },
                    ],
                  },
                ],
              },
              finalExamUnlocked: {
                $and: [
                  { $gt: ['$lessonCount', 0] },
                  { $eq: ['$completedLessonCount', '$lessonCount'] },
                  { $ne: [{ $ifNull: ['$finalExamId', null] }, null] },
                ],
              },
              finalExamCompleted: {
                $ne: [{ $ifNull: ['$finalSubmission._id', null] }, null],
              },
              examPoints: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$finalSubmission.status', 'graded'] },
                      { $ne: ['$finalSubmission.marksAwarded', null] },
                    ],
                  },
                  { $ifNull: ['$finalSubmission.marksAwarded', 0] },
                  0,
                ],
              },
              hasProgress: { $cond: [{ $ifNull: ['$progress._id', false] }, true, false] },
              hasStarted: {
                $gt: [
                  {
                    $size: {
                      $filter: {
                        input: { $ifNull: ['$progress.lessons', []] },
                        as: 'lesson',
                        cond: { $gt: [{ $ifNull: ['$$lesson.watchedSec', 0] }, 0] },
                      },
                    },
                  },
                  0,
                ],
              },
              lastActivityAt: { $ifNull: ['$progress.updatedAt', null] },
              lastLessonId: { $ifNull: ['$progress.lastLessonId', null] },
            },
          },
          {
            $addFields: {
              totalPointsEarned: {
                $add: ['$lessonPoints', '$examPoints'],
              },
            },
          },
          {
            $project: {
              _id: 0,
              courseId: '$_id',
              title: 1,
              thumbnailUrl: 1,
              category: 1,
              level: 1,
              lessonCount: 1,
              completedLessonCount: 1,
              progressPct: 1,
              totalPointsEarned: 1,
              finalExamUnlocked: 1,
              finalExamCompleted: 1,
              lastLessonId: 1,
              lastLessonTitle: 1,
              lastActivityAt: 1,
              hasProgress: 1,
              hasStarted: 1,
            },
          },
        ],
        as: 'courses',
      },
    },
    {
      $project: {
        _id: 0,
        totalPoints: 1,
        courses: 1,
      },
    },
  ]);

  const row = rows[0];
  if (!row) {
    throw AppError.notFound('User not found');
  }

  const courses: ProgressCourseDto[] = row.courses.map((course) => ({
    courseId: course.courseId.toString(),
    title: course.title,
    thumbnailUrl: course.thumbnailUrl ?? null,
    category: course.category,
    level: course.level,
    lessonCount: course.lessonCount,
    completedLessonCount: course.completedLessonCount,
    progressPct: computeProgressPct(course.completedLessonCount, course.lessonCount),
    totalPointsEarned: course.totalPointsEarned,
    finalExamUnlocked: Boolean(course.finalExamUnlocked),
    finalExamCompleted: Boolean(course.finalExamCompleted),
    lastLessonId: course.lastLessonId ? course.lastLessonId.toString() : null,
  }));

  let coursesStarted = 0;
  let coursesCompleted = 0;
  let lessonsCompleted = 0;

  for (const course of row.courses) {
    if (course.hasProgress || course.completedLessonCount > 0) {
      coursesStarted += 1;
    }
    if (course.lessonCount > 0 && course.completedLessonCount === course.lessonCount) {
      coursesCompleted += 1;
    }
    lessonsCompleted += course.completedLessonCount;
  }

  const inProgress: InProgressCourseDto[] = [...row.courses]
    .filter((course) => {
      const isComplete =
        course.lessonCount > 0 &&
        course.completedLessonCount === course.lessonCount;
      return (
        Boolean(course.hasStarted) &&
        !isComplete &&
        Boolean(course.lastLessonId) &&
        Boolean(course.lastLessonTitle) &&
        Boolean(course.lastActivityAt)
      );
    })
    .sort((a, b) => {
      const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 3)
    .map((course) => ({
      courseId: course.courseId.toString(),
      courseTitle: course.title,
      thumbnailUrl: course.thumbnailUrl ?? null,
      lessonId: course.lastLessonId!.toString(),
      lessonTitle: course.lastLessonTitle!,
      courseProgressPct: Math.round(course.progressPct * 10) / 10,
      completedLessonCount: course.completedLessonCount,
      lessonCount: course.lessonCount,
      lastActivityAt: new Date(course.lastActivityAt!).toISOString(),
    }));

  return {
    totalPoints: row.totalPoints ?? 0,
    coursesStarted,
    coursesCompleted,
    lessonsCompleted,
    inProgress,
    courses,
    badges: await listBadgesForUser(userId),
  };
}

/* -------------------------------------------------------------------------- */
/* Phase 15 — full progress detail + admin views                              */
/* -------------------------------------------------------------------------- */

export type LearnerProgressLessonDto = {
  lessonId: string;
  title: string;
  videoCompletedAt: string | null;
  videoPointsAwarded: number;
  bestQuizScore: number | null;
  quizMaxScore: number | null;
  quizPointsAwarded: number;
  quizAttempts: number;
};

export type LearnerProgressFinalExamDto = {
  exists: true;
  unlocked: boolean;
  maxMarks: number;
  passMark: number;
  submissionStatus: null | 'submitted' | 'graded';
  marksAwarded: number | null;
  passed: boolean | null;
};

export type LearnerProgressCourseDto = {
  courseId: string;
  title: string;
  progressPct: number;
  completedLessonCount: number;
  lessonCount: number;
  pointsEarned: number;
  pointsAvailable: number;
  startedAt: string | null;
  completedAt: string | null;
  lessons: LearnerProgressLessonDto[];
  finalExam: LearnerProgressFinalExamDto | null;
};

export type LearnerProgressDetailDto = {
  totals: {
    totalPoints: number;
    videoPoints: number;
    quizPoints: number;
    examPoints: number;
    lessonsCompleted: number;
    coursesCompleted: number;
    quizzesTaken: number;
    examsTaken: number;
  };
  courses: LearnerProgressCourseDto[];
  badges: BadgeDto[];
};

export type AdminProgressRowDto = {
  userId: string;
  name: string;
  email: string;
  isActive: boolean;
  coursesStarted: number;
  coursesCompleted: number;
  lessonsCompleted: number;
  totalPoints: number;
  lastActivityAt: string | null;
};

export type AdminProgressListQuery = {
  page: number;
  limit: number;
  search?: string;
  courseId?: string;
  sort?: 'totalPoints' | '-totalPoints' | 'lastActivityAt' | '-lastActivityAt';
};

type DetailAggLesson = {
  lessonId: Types.ObjectId;
  title: string;
  videoCompletedAt: Date | null;
  videoPointsAwarded: boolean;
  bestQuizScore: number | null;
  quizMaxScore: number | null;
  quizPointsAwarded: number;
  quizAttempts: number;
};

type DetailAggCourse = {
  courseId: Types.ObjectId;
  title: string;
  lessonCount: number;
  completedLessonCount: number;
  progressPct: number;
  pointsEarned: number;
  pointsAvailable: number;
  videoPoints: number;
  quizPoints: number;
  examPoints: number;
  quizzesTaken: number;
  examsTaken: number;
  startedAt?: Date | null;
  completedAt?: Date | null;
  lessons: DetailAggLesson[];
  finalExam: {
    exists: true;
    unlocked: boolean;
    maxMarks: number;
    passMark: number;
    submissionStatus: null | 'submitted' | 'graded';
    marksAwarded: number | null;
    passed: boolean | null;
  } | null;
};

/**
 * Full learner progress breakdown for one user.
 * Identity is always the provided userId from the trusted caller (token or admin path).
 */
export async function getLearnerProgressDetail(
  userId: string,
): Promise<LearnerProgressDetailDto> {
  if (!Types.ObjectId.isValid(userId)) {
    throw AppError.notFound('User not found');
  }

  const uid = new Types.ObjectId(userId);
  const videoPoints = RULES.VIDEO_POINTS;

  const rows = await User.aggregate<{
    courses: DetailAggCourse[];
  }>([
    { $match: { _id: uid } },
    {
      $lookup: {
        from: 'courses',
        let: { uid: '$_id' },
        pipeline: [
          { $match: { status: 'published' } },
          { $sort: { title: 1 } },
          {
            $lookup: {
              from: 'progresses',
              let: { courseId: '$_id', uid: '$$uid' },
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
              let: { courseId: '$_id', uid: '$$uid' },
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
                { $match: { $expr: { $eq: ['$courseId', '$$courseId'] } } },
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
                          questionCount: {
                            $size: { $ifNull: ['$questions', []] },
                          },
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
                    lessonId: '$_id',
                    title: 1,
                    videoCompletedAt: {
                      $ifNull: ['$progressLesson.videoCompletedAt', null],
                    },
                    videoPointsAwarded: {
                      $ifNull: ['$progressLesson.videoPointsAwarded', false],
                    },
                    quizAttempts: { $ifNull: ['$progressLesson.attempts', 0] },
                    quizPointsAwarded: {
                      $ifNull: ['$progressLesson.quizPointsAwarded', 0],
                    },
                    bestQuizScore: {
                      $cond: [
                        { $gt: [{ $ifNull: ['$progressLesson.attempts', 0] }, 0] },
                        { $ifNull: ['$progressLesson.bestQuizScore', 0] },
                        null,
                      ],
                    },
                    quizMaxScore: {
                      $cond: [
                        { $ifNull: ['$quizDoc._id', false] },
                        {
                          $multiply: [
                            { $ifNull: ['$quizDoc.pointsPerQuestion', 0] },
                            { $ifNull: ['$quizDoc.questionCount', 0] },
                          ],
                        },
                        null,
                      ],
                    },
                  },
                },
              ],
              as: 'lessons',
            },
          },
          {
            $addFields: {
              finalSubmission: { $arrayElemAt: ['$finalSubmissionDocs', 0] },
              completedLessonCount: {
                $size: {
                  $filter: {
                    input: '$lessons',
                    as: 'l',
                    cond: { $ne: ['$$l.videoCompletedAt', null] },
                  },
                },
              },
              videoPoints: {
                $multiply: [
                  {
                    $size: {
                      $filter: {
                        input: '$lessons',
                        as: 'l',
                        cond: { $eq: ['$$l.videoPointsAwarded', true] },
                      },
                    },
                  },
                  videoPoints,
                ],
              },
              quizPoints: {
                $sum: '$lessons.quizPointsAwarded',
              },
              quizMaxTotal: {
                $sum: {
                  $map: {
                    input: '$lessons',
                    as: 'l',
                    in: { $ifNull: ['$$l.quizMaxScore', 0] },
                  },
                },
              },
              quizzesTaken: {
                $sum: {
                  $map: {
                    input: '$lessons',
                    as: 'l',
                    in: { $ifNull: ['$$l.quizAttempts', 0] },
                  },
                },
              },
            },
          },
          {
            $addFields: {
              examPoints: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$finalSubmission.status', 'graded'] },
                      { $ne: ['$finalSubmission.marksAwarded', null] },
                    ],
                  },
                  { $ifNull: ['$finalSubmission.marksAwarded', 0] },
                  0,
                ],
              },
              examsTaken: {
                $cond: [
                  { $ne: [{ $ifNull: ['$finalSubmission._id', null] }, null] },
                  1,
                  0,
                ],
              },
              finalExamMax: {
                $cond: [
                  { $ifNull: ['$finalExamRaw._id', false] },
                  RULES.FINAL_EXAM_MAX_MARKS,
                  0,
                ],
              },
            },
          },
          {
            $addFields: {
              pointsAvailable: {
                $add: [
                  { $multiply: ['$lessonCount', videoPoints] },
                  '$quizMaxTotal',
                  '$finalExamMax',
                ],
              },
              pointsEarned: {
                $add: ['$videoPoints', '$quizPoints', '$examPoints'],
              },
              progressPct: {
                $cond: [
                  { $lte: ['$lessonCount', 0] },
                  0,
                  {
                    $min: [
                      100,
                      {
                        $multiply: [
                          { $divide: ['$completedLessonCount', '$lessonCount'] },
                          100,
                        ],
                      },
                    ],
                  },
                ],
              },
              finalExam: {
                $cond: [
                  { $ifNull: ['$finalExamRaw._id', false] },
                  {
                    exists: true,
                    unlocked: {
                      $and: [
                        { $gt: ['$lessonCount', 0] },
                        { $eq: ['$completedLessonCount', '$lessonCount'] },
                      ],
                    },
                    maxMarks: '$finalExamMax',
                    passMark: finalExamPassMark(),
                    submissionStatus: {
                      $ifNull: ['$finalSubmission.status', null],
                    },
                    marksAwarded: {
                      $cond: [
                        { $eq: ['$finalSubmission.status', 'graded'] },
                        { $ifNull: ['$finalSubmission.marksAwarded', null] },
                        null,
                      ],
                    },
                    passed: {
                      $cond: [
                        { $eq: ['$finalSubmission.status', 'graded'] },
                        { $ifNull: ['$finalSubmission.passed', null] },
                        null,
                      ],
                    },
                  },
                  null,
                ],
              },
            },
          },
          {
            $project: {
              _id: 0,
              courseId: '$_id',
              title: 1,
              lessonCount: 1,
              completedLessonCount: 1,
              progressPct: 1,
              pointsEarned: 1,
              pointsAvailable: 1,
              videoPoints: 1,
              quizPoints: 1,
              examPoints: 1,
              quizzesTaken: 1,
              examsTaken: 1,
              startedAt: { $ifNull: ['$progress.startedAt', null] },
              completedAt: { $ifNull: ['$progress.completedAt', null] },
              lessons: 1,
              finalExam: 1,
            },
          },
        ],
        as: 'courses',
      },
    },
    { $project: { _id: 0, courses: 1 } },
  ]);

  const row = rows[0];
  if (!row) {
    throw AppError.notFound('User not found');
  }

  const courses: LearnerProgressCourseDto[] = row.courses.map((course) => ({
    courseId: course.courseId.toString(),
    title: course.title,
    progressPct: computeProgressPct(course.completedLessonCount, course.lessonCount),
    completedLessonCount: course.completedLessonCount,
    lessonCount: course.lessonCount,
    pointsEarned: course.pointsEarned,
    pointsAvailable: course.pointsAvailable,
    startedAt: course.startedAt ? new Date(course.startedAt).toISOString() : null,
    completedAt: course.completedAt
      ? new Date(course.completedAt).toISOString()
      : null,
    lessons: course.lessons.map((lesson) => ({
      lessonId: lesson.lessonId.toString(),
      title: lesson.title,
      videoCompletedAt: lesson.videoCompletedAt
        ? new Date(lesson.videoCompletedAt).toISOString()
        : null,
      videoPointsAwarded: lesson.videoPointsAwarded ? videoPoints : 0,
      bestQuizScore: lesson.bestQuizScore,
      quizMaxScore: lesson.quizMaxScore,
      quizPointsAwarded: lesson.quizPointsAwarded ?? 0,
      quizAttempts: lesson.quizAttempts ?? 0,
    })),
    finalExam: course.finalExam
      ? {
          exists: true,
          unlocked: Boolean(course.finalExam.unlocked),
          maxMarks: course.finalExam.maxMarks,
          passMark: course.finalExam.passMark,
          submissionStatus: course.finalExam.submissionStatus,
          marksAwarded: course.finalExam.marksAwarded,
          passed: course.finalExam.passed,
        }
      : null,
  }));

  let videoPointsTotal = 0;
  let quizPointsTotal = 0;
  let examPointsTotal = 0;
  let lessonsCompleted = 0;
  let coursesCompleted = 0;
  let quizzesTaken = 0;
  let examsTaken = 0;

  for (const course of row.courses) {
    videoPointsTotal += course.videoPoints;
    quizPointsTotal += course.quizPoints;
    examPointsTotal += course.examPoints;
    lessonsCompleted += course.completedLessonCount;
    quizzesTaken += course.quizzesTaken;
    examsTaken += course.examsTaken;
    if (course.lessonCount > 0 && course.completedLessonCount === course.lessonCount) {
      coursesCompleted += 1;
    }
  }

  return {
    totals: {
      totalPoints: videoPointsTotal + quizPointsTotal + examPointsTotal,
      videoPoints: videoPointsTotal,
      quizPoints: quizPointsTotal,
      examPoints: examPointsTotal,
      lessonsCompleted,
      coursesCompleted,
      quizzesTaken,
      examsTaken,
    },
    courses,
    badges: await listBadgesForUser(userId),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Admin paginated progress table — one User.aggregate, no per-user loops.
 */
export async function listAdminProgress(
  query: AdminProgressListQuery,
): Promise<{ data: AdminProgressRowDto[]; meta: { page: number; limit: number; total: number } }> {
  const sortKey = query.sort ?? '-totalPoints';
  const sortField = sortKey.startsWith('-') ? sortKey.slice(1) : sortKey;
  const sortDir = sortKey.startsWith('-') ? -1 : 1;
  const sortStage: Record<string, 1 | -1> = {
    [sortField === 'lastActivityAt' ? 'lastActivityAt' : 'totalPoints']: sortDir as 1 | -1,
    _id: 1,
  };

  const match: Record<string, unknown> = { role: 'user' };
  if (query.search?.trim()) {
    const pattern = escapeRegex(query.search.trim());
    match.$or = trusted([
      { name: { $regex: pattern, $options: 'i' } },
      { email: { $regex: pattern, $options: 'i' } },
    ]);
  }

  const courseOid =
    query.courseId && Types.ObjectId.isValid(query.courseId)
      ? new Types.ObjectId(query.courseId)
      : null;

  const progressDocsScoped = courseOid
    ? {
        $filter: {
          input: '$progressDocs',
          as: 'p',
          cond: { $eq: ['$$p.courseId', courseOid] },
        },
      }
    : '$progressDocs';

  const publishedCoursesScoped = courseOid
    ? {
        $filter: {
          input: '$publishedCourses',
          as: 'c',
          cond: { $eq: ['$$c._id', courseOid] },
        },
      }
    : '$publishedCourses';

  const skip = (query.page - 1) * query.limit;

  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      $lookup: {
        from: 'progresses',
        localField: '_id',
        foreignField: 'userId',
        as: 'progressDocs',
      },
    },
    {
      $lookup: {
        from: 'quizattempts',
        localField: '_id',
        foreignField: 'userId',
        as: 'attemptDocs',
      },
    },
    {
      $lookup: {
        from: 'examsubmissions',
        localField: '_id',
        foreignField: 'userId',
        as: 'examSubmissionDocs',
      },
    },
    {
      $lookup: {
        from: 'courses',
        pipeline: [
          { $match: { status: 'published' } },
          { $project: { _id: 1, lessonCount: 1 } },
        ],
        as: 'publishedCourses',
      },
    },
    {
      $addFields: {
        coursesStarted: {
          $size: {
            $filter: {
              input: progressDocsScoped,
              as: 'p',
              cond: {
                $or: [
                  { $gt: [{ $size: { $ifNull: ['$$p.lessons', []] } }, 0] },
                  { $ne: ['$$p.startedAt', null] },
                ],
              },
            },
          },
        },
        lessonsCompleted: {
          $sum: {
            $map: {
              input: progressDocsScoped,
              as: 'p',
              in: {
                $size: {
                  $filter: {
                    input: { $ifNull: ['$$p.lessons', []] },
                    as: 'l',
                    cond: { $ne: ['$$l.videoCompletedAt', null] },
                  },
                },
              },
            },
          },
        },
        coursesCompleted: {
          $size: {
            $filter: {
              input: publishedCoursesScoped,
              as: 'c',
              cond: {
                $let: {
                  vars: {
                    prog: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: '$progressDocs',
                            as: 'p',
                            cond: { $eq: ['$$p.courseId', '$$c._id'] },
                          },
                        },
                        0,
                      ],
                    },
                  },
                  in: {
                    $and: [
                      { $gt: ['$$c.lessonCount', 0] },
                      {
                        $eq: [
                          {
                            $size: {
                              $filter: {
                                input: { $ifNull: ['$$prog.lessons', []] },
                                as: 'l',
                                cond: { $ne: ['$$l.videoCompletedAt', null] },
                              },
                            },
                          },
                          '$$c.lessonCount',
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        lastActivityAt: {
          $max: {
            $concatArrays: [
              {
                $map: {
                  input: '$progressDocs',
                  as: 'p',
                  in: '$$p.updatedAt',
                },
              },
              {
                $reduce: {
                  input: '$progressDocs',
                  initialValue: [] as unknown[],
                  in: {
                    $concatArrays: [
                      '$$value',
                      {
                        $map: {
                          input: { $ifNull: ['$$this.lessons', []] },
                          as: 'l',
                          in: '$$l.lastHeartbeatAt',
                        },
                      },
                      {
                        $map: {
                          input: { $ifNull: ['$$this.lessons', []] },
                          as: 'l',
                          in: '$$l.videoCompletedAt',
                        },
                      },
                    ],
                  },
                },
              },
              {
                $map: {
                  input: '$attemptDocs',
                  as: 'a',
                  in: '$$a.createdAt',
                },
              },
              {
                $map: {
                  input: '$examSubmissionDocs',
                  as: 's',
                  in: '$$s.submittedAt',
                },
              },
              {
                $map: {
                  input: '$examSubmissionDocs',
                  as: 's',
                  in: '$$s.gradedAt',
                },
              },
            ],
          },
        },
      },
    },
  ];

  if (courseOid) {
    pipeline.push({
      $match: {
        $expr: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: '$progressDocs',
                  as: 'p',
                  cond: { $eq: ['$$p.courseId', courseOid] },
                },
              },
            },
            0,
          ],
        },
      },
    });
  }

  pipeline.push({
    $facet: {
      meta: [{ $count: 'total' }],
      data: [
        { $sort: sortStage },
        { $skip: skip },
        { $limit: query.limit },
        {
          $project: {
            _id: 1,
            name: 1,
            email: 1,
            isActive: 1,
            totalPoints: 1,
            coursesStarted: 1,
            coursesCompleted: 1,
            lessonsCompleted: 1,
            lastActivityAt: 1,
          },
        },
      ],
    },
  });

  const rows = await User.aggregate<{
    data: Array<{
      _id: Types.ObjectId;
      name: string;
      email: string;
      isActive: boolean;
      totalPoints: number;
      coursesStarted: number;
      coursesCompleted: number;
      lessonsCompleted: number;
      lastActivityAt: Date | null;
    }>;
    meta: Array<{ total: number }>;
  }>(pipeline);

  const facet = rows[0] ?? { data: [], meta: [] };
  const total = facet.meta[0]?.total ?? 0;

  return {
    data: facet.data.map((row) => ({
      userId: row._id.toString(),
      name: row.name,
      email: row.email,
      isActive: row.isActive,
      coursesStarted: row.coursesStarted,
      coursesCompleted: row.coursesCompleted,
      lessonsCompleted: row.lessonsCompleted,
      totalPoints: row.totalPoints ?? 0,
      lastActivityAt: row.lastActivityAt
        ? new Date(row.lastActivityAt).toISOString()
        : null,
    })),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
    },
  };
}
