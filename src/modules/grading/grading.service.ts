import { Types, trusted } from 'mongoose';
import { RULES, finalExamPassMark } from '../../shared/index.js';
import { Badge } from '../../models/Badge.js';
import { Course } from '../../models/Course.js';
import { ExamSubmission } from '../../models/ExamSubmission.js';
import { Quiz } from '../../models/Quiz.js';
import { User } from '../../models/User.js';
import { AppError } from '../../utils/AppError.js';
import { notifyExamGraded } from '../notifications/notifications.service.js';
import type {
  GradeExamSubmissionBody,
  ListExamSubmissionsQuery,
} from './grading.schema.js';

export type BadgeDto = {
  id: string;
  courseId: string;
  courseTitle: string;
  examSubmissionId: string;
  marksAwarded: number;
  maxMarks: number;
  earnedAt: string;
};

export type AdminExamSubmissionListItemDto = {
  id: string;
  status: 'submitted' | 'graded';
  submittedAt: string;
  learner: { id: string; name: string; email: string };
  course: { id: string; title: string };
  marksAwarded: number | null;
  passed: boolean | null;
};

export type AdminExamSubmissionDetailDto = {
  id: string;
  status: 'submitted' | 'graded';
  submittedAt: string;
  docUrl: string;
  loomUrl: string | null;
  marksAwarded: number | null;
  maxMarks: number;
  passed: boolean | null;
  feedback: string | null;
  gradedAt: string | null;
  gradedBy: { id: string; name: string } | null;
  learner: { id: string; name: string; email: string };
  course: { id: string; title: string };
  exam: {
    id: string;
    title: string;
    instructions: string;
    questions: Array<{ id: string; text: string; order: number }>;
    maxMarks: number;
    passPct: number;
    passMark: number;
  };
};

export type GradeExamSubmissionResultDto = {
  submission: AdminExamSubmissionDetailDto;
  pointsAwarded: number;
  badgeCreated: boolean;
  badge: BadgeDto | null;
};

function toBadgeDto(row: {
  _id: Types.ObjectId;
  courseId: Types.ObjectId;
  courseTitle: string;
  examSubmissionId: Types.ObjectId;
  marksAwarded: number;
  maxMarks: number;
  earnedAt: Date;
}): BadgeDto {
  return {
    id: row._id.toString(),
    courseId: row.courseId.toString(),
    courseTitle: row.courseTitle,
    examSubmissionId: row.examSubmissionId.toString(),
    marksAwarded: row.marksAwarded,
    maxMarks: row.maxMarks,
    earnedAt: row.earnedAt.toISOString(),
  };
}

export async function listBadgesForUser(userId: string): Promise<BadgeDto[]> {
  if (!Types.ObjectId.isValid(userId)) {
    return [];
  }
  const rows = await Badge.find({ userId: new Types.ObjectId(userId) })
    .sort({ earnedAt: -1 })
    .lean();
  return rows.map(toBadgeDto);
}

export async function countUngradedSubmissions(): Promise<number> {
  return ExamSubmission.countDocuments({ status: 'submitted' });
}

export async function listExamSubmissions(
  query: ListExamSubmissionsQuery,
): Promise<{
  data: AdminExamSubmissionListItemDto[];
  meta: {
    page: number;
    limit: number;
    total: number;
    ungradedCount: number;
  };
}> {
  const filter: Record<string, unknown> = {
    status: query.status,
  };

  if (query.courseId) {
    if (!Types.ObjectId.isValid(query.courseId)) {
      throw AppError.validation('Invalid courseId');
    }
    filter.courseId = new Types.ObjectId(query.courseId);
  }

  const search = query.search?.trim();
  if (search) {
    const users = await User.find({
      $or: [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ],
    })
      .select('_id')
      .lean();
    // Avoid $in under sanitizeFilter — constrain via explicit id list match.
    if (users.length === 0) {
      return {
        data: [],
        meta: {
          page: query.page,
          limit: query.limit,
          total: 0,
          ungradedCount: await countUngradedSubmissions(),
        },
      };
    }
    filter.userId = trusted({ $in: users.map((u) => u._id) });
  }

  const skip = (query.page - 1) * query.limit;
  const [rows, total, ungradedCount] = await Promise.all([
    ExamSubmission.find(filter)
      .sort({ submittedAt: query.status === 'submitted' ? 1 : -1 })
      .skip(skip)
      .limit(query.limit)
      .populate<{ userId: { _id: Types.ObjectId; name: string; email: string } }>(
        'userId',
        'name email',
      )
      .populate<{ courseId: { _id: Types.ObjectId; title: string } }>(
        'courseId',
        'title',
      )
      .lean(),
    ExamSubmission.countDocuments(filter),
    countUngradedSubmissions(),
  ]);

  const data: AdminExamSubmissionListItemDto[] = rows.map((row) => {
    const learner =
      row.userId && typeof row.userId === 'object' && 'name' in row.userId
        ? row.userId
        : null;
    const course =
      row.courseId && typeof row.courseId === 'object' && 'title' in row.courseId
        ? row.courseId
        : null;
    const learnerId =
      learner && '_id' in learner
        ? learner._id.toString()
        : String(row.userId);
    const courseId =
      course && '_id' in course
        ? course._id.toString()
        : String(row.courseId);

    return {
      id: row._id.toString(),
      status: row.status,
      submittedAt: row.submittedAt.toISOString(),
      learner: {
        id: learnerId,
        name: learner?.name ?? 'Unknown',
        email: learner?.email ?? '',
      },
      course: {
        id: courseId,
        title: course?.title ?? 'Unknown course',
      },
      marksAwarded: row.marksAwarded ?? null,
      passed: row.passed ?? null,
    };
  });

  return {
    data,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      ungradedCount,
    },
  };
}

async function buildDetailDto(
  submissionId: Types.ObjectId,
): Promise<AdminExamSubmissionDetailDto> {
  const row = await ExamSubmission.findById(submissionId).lean();
  if (!row) {
    throw AppError.notFound('Exam submission not found');
  }

  const [learner, course, exam, grader] = await Promise.all([
    User.findById(row.userId).select('name email').lean(),
    Course.findById(row.courseId).select('title').lean(),
    Quiz.findById(row.examId)
      .select({
        title: 1,
        instructions: 1,
        'questions._id': 1,
        'questions.text': 1,
        'questions.order': 1,
      })
      .lean(),
    row.gradedBy
      ? User.findById(row.gradedBy).select('name').lean()
      : Promise.resolve(null),
  ]);

  if (!exam) {
    throw AppError.notFound('Final exam not found for this submission');
  }

  const questions = (exam.questions ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((q) => ({
      id: q._id.toString(),
      text: q.text,
      order: q.order,
    }));

  return {
    id: row._id.toString(),
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    docUrl: row.docUrl,
    loomUrl: row.loomUrl ?? null,
    marksAwarded: row.marksAwarded ?? null,
    maxMarks: row.maxMarks,
    passed: row.passed ?? null,
    feedback: row.feedback ?? null,
    gradedAt: row.gradedAt ? row.gradedAt.toISOString() : null,
    gradedBy: grader
      ? { id: grader._id.toString(), name: grader.name }
      : null,
    learner: {
      id: row.userId.toString(),
      name: learner?.name ?? 'Unknown',
      email: learner?.email ?? '',
    },
    course: {
      id: row.courseId.toString(),
      title: course?.title ?? 'Unknown course',
    },
    exam: {
      id: exam._id.toString(),
      title: exam.title,
      instructions: exam.instructions ?? '',
      questions,
      maxMarks: RULES.FINAL_EXAM_MAX_MARKS,
      passPct: RULES.FINAL_EXAM_PASS_PCT,
      passMark: finalExamPassMark(row.maxMarks),
    },
  };
}

export async function getExamSubmissionDetail(
  id: string,
): Promise<AdminExamSubmissionDetailDto> {
  if (!Types.ObjectId.isValid(id)) {
    throw AppError.notFound('Exam submission not found');
  }
  return buildDetailDto(new Types.ObjectId(id));
}

/**
 * One-shot grading. Marks feed User.totalPoints, so allowing later edits would
 * mean reversing already-awarded points (a reconciliation problem we are not
 * taking on). Mistakes later need a deliberate admin tool, not an editable field.
 *
 * Atomic guard: update only when status === 'submitted'. A concurrent second
 * call finds nothing to update and returns a clear already-graded error.
 */
export async function gradeExamSubmission(params: {
  submissionId: string;
  graderId: string;
  body: GradeExamSubmissionBody;
}): Promise<GradeExamSubmissionResultDto> {
  if (!Types.ObjectId.isValid(params.submissionId)) {
    throw AppError.notFound('Exam submission not found');
  }
  if (!Types.ObjectId.isValid(params.graderId)) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }

  const submissionOid = new Types.ObjectId(params.submissionId);
  const graderOid = new Types.ObjectId(params.graderId);
  const marksAwarded = params.body.marksAwarded;
  const maxMarks = RULES.FINAL_EXAM_MAX_MARKS;
  const passMark = finalExamPassMark(maxMarks);
  const passed = marksAwarded >= passMark;
  const now = new Date();
  const feedback =
    params.body.feedback && params.body.feedback.trim().length > 0
      ? params.body.feedback.trim()
      : null;

  const updated = await ExamSubmission.findOneAndUpdate(
    { _id: submissionOid, status: 'submitted' },
    {
      $set: {
        status: 'graded',
        marksAwarded,
        maxMarks,
        passed,
        gradedBy: graderOid,
        gradedAt: now,
        feedback,
      },
    },
    { new: true },
  );

  if (!updated) {
    const existing = await ExamSubmission.findById(submissionOid).lean();
    if (!existing) {
      throw AppError.notFound('Exam submission not found');
    }
    if (existing.status === 'graded') {
      throw new AppError(
        'VALIDATION_ERROR',
        'This submission has already been graded and cannot be regraded',
      );
    }
    throw new AppError(
      'VALIDATION_ERROR',
      'Could not grade this submission — please try again',
    );
  }

  await User.updateOne(
    { _id: updated.userId },
    { $inc: { totalPoints: marksAwarded } },
  );

  let badgeCreated = false;
  let badge: BadgeDto | null = null;
  let courseTitle = 'Course';

  const courseDoc = await Course.findById(updated.courseId).select('title').lean();
  courseTitle = courseDoc?.title ?? 'Course';

  if (passed) {
    try {
      const created = await Badge.create({
        userId: updated.userId,
        courseId: updated.courseId,
        courseTitle,
        examSubmissionId: updated._id,
        marksAwarded,
        maxMarks,
        earnedAt: now,
      });
      badgeCreated = true;
      badge = toBadgeDto(created);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: number }).code === 11000
      ) {
        // Unique index: badge already exists for this user/course — do not fail grading.
        const existingBadge = await Badge.findOne({
          userId: updated.userId,
          courseId: updated.courseId,
        }).lean();
        badge = existingBadge ? toBadgeDto(existingBadge) : null;
      } else {
        throw error;
      }
    }
  }

  // Notifications must never fail grading — createNotification swallows errors.
  await notifyExamGraded({
    userId: updated.userId,
    courseId: updated.courseId.toString(),
    courseTitle,
    marksAwarded,
    maxMarks,
    passed,
    badgeId: badge?.id ?? null,
  });

  const submission = await buildDetailDto(submissionOid);
  return {
    submission,
    pointsAwarded: marksAwarded,
    badgeCreated,
    badge,
  };
}
