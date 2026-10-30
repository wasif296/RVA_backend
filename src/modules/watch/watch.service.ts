/**
 * Threat model: this is client-trusted. There is no server-verifiable proof of
 * YouTube playback. The goal is to raise the cost of cheating, not to prevent it.
 * Do not write comments or tests that claim manipulation is prevented.
 */
import { Types, trusted } from 'mongoose';
import { RULES } from '../../shared/index.js';
import { Course } from '../../models/Course.js';
import { Lesson } from '../../models/Lesson.js';
import { Progress, type IProgressLesson } from '../../models/Progress.js';
import { User } from '../../models/User.js';
import { AppError } from '../../utils/AppError.js';

const MAX_DELTA_SEC = 20;
const MIN_HEARTBEAT_GAP_SEC = 12;
/**
 * Wall-clock anti-cheat slack: one full max heartbeat interval.
 * Required because (1) firstHeartbeatAt is stamped when the first flush arrives,
 * already carrying accrued play, and (2) client flush gaps (~12.5–15s) plus
 * timer drift can trail claimed deltaSec by a small amount. Still rejects
 * impossible claims (e.g. 300s watch inside 30s wall time).
 */
const WALL_CLOCK_TOLERANCE_SEC = MAX_DELTA_SEC;

export type WatchProgressDto = {
  watchedSec: number;
  videoCompletedAt: string | null;
  videoPointsAwarded: number;
  bestQuizScore: number | null;
  quizPointsAwarded: number;
  quizAttempts: number;
};

export type WatchHeartbeatResult = {
  progress: WatchProgressDto;
  completed: boolean;
  pointsAwarded: number;
};

function rejectHeartbeat(message: string): never {
  throw new AppError('HEARTBEAT_REJECTED', message);
}

function toProgressDto(lesson: IProgressLesson | undefined): WatchProgressDto {
  const attempts = lesson?.attempts ?? 0;
  return {
    watchedSec: lesson?.watchedSec ?? 0,
    videoCompletedAt: lesson?.videoCompletedAt
      ? new Date(lesson.videoCompletedAt).toISOString()
      : null,
    videoPointsAwarded: lesson?.videoPointsAwarded ? RULES.VIDEO_POINTS : 0,
    bestQuizScore: attempts > 0 ? (lesson?.bestQuizScore ?? 0) : null,
    quizPointsAwarded: lesson?.quizPointsAwarded ?? 0,
    quizAttempts: attempts,
  };
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

function findLessonEntry(
  lessons: IProgressLesson[],
  lessonId: Types.ObjectId,
): IProgressLesson | undefined {
  return lessons.find((row) => row.lessonId.equals(lessonId));
}

/**
 * Atomically marks the lesson video complete and awards VIDEO_POINTS once.
 * Idempotent: a second call returns the current state without error.
 */
async function tryAwardVideoPoints(params: {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  lessonId: Types.ObjectId;
  requiredWatchSec: number;
  lessonCount: number;
  now: Date;
}): Promise<{ awarded: boolean; progress: InstanceType<typeof Progress> | null }> {
  // Atomic guard is videoPointsAwarded:false. Callers already verified watchedSec.
  // Avoid $gte in the filter — sanitizeFilter + nested operators are fragile even with trusted().
  const result = await Progress.updateOne(
    {
      userId: params.userId,
      courseId: params.courseId,
      lessons: trusted({
        $elemMatch: {
          lessonId: params.lessonId,
          videoPointsAwarded: false,
        },
      }),
    },
    {
      $set: {
        'lessons.$.videoCompletedAt': params.now,
        'lessons.$.videoPointsAwarded': true,
        lastLessonId: params.lessonId,
      },
    },
  );

  const progress = await Progress.findOne({
    userId: params.userId,
    courseId: params.courseId,
  });

  if (result.modifiedCount === 0) {
    return { awarded: false, progress };
  }

  await User.updateOne(
    { _id: params.userId },
    { $inc: { totalPoints: RULES.VIDEO_POINTS } },
  );

  if (progress) {
    const completedCount = progress.lessons.filter(
      (row) => row.videoCompletedAt != null,
    ).length;
    if (
      params.lessonCount > 0 &&
      completedCount >= params.lessonCount &&
      !progress.completedAt
    ) {
      progress.completedAt = params.now;
      await progress.save();
    }
  }

  return { awarded: true, progress };
}

export async function postHeartbeat(params: {
  userId: string;
  lessonId: string;
  deltaSec: number;
  playerPositionSec: number;
}): Promise<WatchHeartbeatResult> {
  const { lesson, course } = await requirePublishedLesson(params.lessonId);
  const userOid = new Types.ObjectId(params.userId);
  const lessonOid = lesson._id;
  const now = new Date();
  const deltaSec = params.deltaSec;

  if (!(deltaSec > 0)) {
    rejectHeartbeat('deltaSec must be positive');
  }
  if (deltaSec > MAX_DELTA_SEC) {
    rejectHeartbeat(`deltaSec cannot exceed ${MAX_DELTA_SEC}`);
  }

  let progress = await Progress.findOne({
    userId: userOid,
    courseId: course._id,
  });

  if (!progress) {
    progress = await Progress.create({
      userId: userOid,
      courseId: course._id,
      startedAt: now,
      lastLessonId: lessonOid,
      lessons: [
        {
          lessonId: lessonOid,
          watchedSec: 0,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });
  }

  let entry = findLessonEntry(progress.lessons, lessonOid);
  if (!entry) {
    progress.lessons.push({
      lessonId: lessonOid,
      watchedSec: 0,
      videoPointsAwarded: false,
      bestQuizScore: 0,
      quizPointsAwarded: 0,
      attempts: 0,
    });
    entry = progress.lessons[progress.lessons.length - 1]!;
  }

  if (entry.lastHeartbeatAt) {
    const gapSec = (now.getTime() - entry.lastHeartbeatAt.getTime()) / 1000;
    if (gapSec < MIN_HEARTBEAT_GAP_SEC) {
      rejectHeartbeat(
        `Heartbeats must be at least ${MIN_HEARTBEAT_GAP_SEC} seconds apart`,
      );
    }
  }

  const newWatched = entry.watchedSec + deltaSec;
  const maxWatched = lesson.durationSec * 1.5;
  if (newWatched > maxWatched) {
    rejectHeartbeat('watchedSec cannot exceed durationSec × 1.5');
  }

  // On first heartbeat, backdate firstHeartbeatAt by deltaSec so elapsed wall
  // time can cover the claimed watch for this opening delta (otherwise elapsed
  // starts at 0 while watchedSec is already ~15).
  if (!entry.firstHeartbeatAt) {
    entry.firstHeartbeatAt = new Date(now.getTime() - deltaSec * 1000);
  }

  const elapsedSec =
    (now.getTime() - entry.firstHeartbeatAt.getTime()) / 1000;
  if (elapsedSec + WALL_CLOCK_TOLERANCE_SEC < newWatched) {
    rejectHeartbeat(
      'Accumulated watch time cannot exceed real elapsed time since first heartbeat',
    );
  }

  entry.watchedSec = newWatched;
  entry.lastHeartbeatAt = now;
  if (!progress.startedAt) {
    progress.startedAt = now;
  }
  progress.lastLessonId = lessonOid;
  await progress.save();

  let pointsAwarded = 0;
  let completed = Boolean(entry.videoCompletedAt);

  if (newWatched >= lesson.requiredWatchSec && !entry.videoPointsAwarded) {
    const award = await tryAwardVideoPoints({
      userId: userOid,
      courseId: course._id,
      lessonId: lessonOid,
      requiredWatchSec: lesson.requiredWatchSec,
      lessonCount: course.lessonCount,
      now,
    });
    if (award.awarded) {
      pointsAwarded = RULES.VIDEO_POINTS;
    }
    progress = award.progress ?? progress;
    entry = findLessonEntry(progress.lessons, lessonOid);
    completed = Boolean(entry?.videoCompletedAt);
  } else if (entry.videoCompletedAt) {
    completed = true;
  }

  return {
    progress: toProgressDto(entry),
    completed,
    pointsAwarded,
  };
}

export async function completeVideo(params: {
  userId: string;
  lessonId: string;
}): Promise<WatchHeartbeatResult> {
  const { lesson, course } = await requirePublishedLesson(params.lessonId);
  const userOid = new Types.ObjectId(params.userId);
  const lessonOid = lesson._id;
  const now = new Date();

  const progress = await Progress.findOne({
    userId: userOid,
    courseId: course._id,
  });
  const entry = progress
    ? findLessonEntry(progress.lessons, lessonOid)
    : undefined;

  if (!entry || entry.watchedSec < lesson.requiredWatchSec) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Video is not ready to complete — watch the required duration first',
    );
  }

  if (entry.videoPointsAwarded) {
    return {
      progress: toProgressDto(entry),
      completed: true,
      pointsAwarded: 0,
    };
  }

  const award = await tryAwardVideoPoints({
    userId: userOid,
    courseId: course._id,
    lessonId: lessonOid,
    requiredWatchSec: lesson.requiredWatchSec,
    lessonCount: course.lessonCount,
    now,
  });

  const latest = award.progress
    ? findLessonEntry(award.progress.lessons, lessonOid)
    : entry;

  return {
    progress: toProgressDto(latest),
    completed: Boolean(latest?.videoCompletedAt),
    pointsAwarded: award.awarded ? RULES.VIDEO_POINTS : 0,
  };
}
