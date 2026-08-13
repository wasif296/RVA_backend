import { Types } from 'mongoose';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  Notification,
  type NotificationType,
} from '../../models/Notification.js';

export type NotificationDto = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  readAt: string | null;
  createdAt: string;
  metadata: Record<string, string>;
};

export type CreateNotificationInput = {
  userId: Types.ObjectId | string;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  metadata?: Record<string, string>;
};

function toDto(row: {
  _id: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  readAt?: Date | null;
  createdAt: Date;
  metadata?: Record<string, string> | null;
}): NotificationDto {
  const metadata: Record<string, string> = {};
  if (row.metadata && typeof row.metadata === 'object') {
    for (const [key, value] of Object.entries(row.metadata)) {
      if (typeof value === 'string') metadata[key] = value;
    }
  }
  return {
    id: row._id.toString(),
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    metadata,
  };
}

/**
 * Best-effort create. Callers (e.g. grading) must not fail if this throws —
 * a broken notification must never cost a learner their marks.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<NotificationDto | null> {
  try {
    const userId =
      typeof input.userId === 'string'
        ? new Types.ObjectId(input.userId)
        : input.userId;
    const created = await Notification.create({
      userId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link,
      readAt: null,
      metadata: input.metadata ?? {},
    });
    return toDto(created);
  } catch (error) {
    logger.error(
      { err: error, type: input.type, userId: String(input.userId) },
      'Failed to create notification',
    );
    return null;
  }
}

export async function notifyExamGraded(params: {
  userId: Types.ObjectId | string;
  courseId: string;
  courseTitle: string;
  marksAwarded: number;
  maxMarks: number;
  passed: boolean;
  badgeId?: string | null;
}): Promise<void> {
  const pct =
    params.maxMarks > 0
      ? Math.round((params.marksAwarded / params.maxMarks) * 100)
      : 0;
  const result = params.passed ? 'pass' : 'fail';

  await createNotification({
    userId: params.userId,
    type: 'exam_graded',
    title: `${params.courseTitle} — exam graded`,
    body: `You scored ${params.marksAwarded}/${params.maxMarks} (${pct}%) — ${result}.`,
    link: `/exam/${params.courseId}`,
    metadata: {
      courseId: params.courseId,
    },
  });

  if (params.passed) {
    await createNotification({
      userId: params.userId,
      type: 'badge_earned',
      title: `Badge earned: ${params.courseTitle}`,
      body: `You passed the final exam and earned the ${params.courseTitle} badge.`,
      link: '/progress',
      metadata: {
        courseId: params.courseId,
        ...(params.badgeId ? { badgeId: params.badgeId } : {}),
      },
    });
  }
}

export async function listNotifications(params: {
  userId: string;
  unreadOnly?: boolean;
  page: number;
  limit: number;
}): Promise<{
  data: NotificationDto[];
  meta: { page: number; limit: number; total: number };
}> {
  if (!Types.ObjectId.isValid(params.userId)) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }

  const filter: Record<string, unknown> = {
    userId: new Types.ObjectId(params.userId),
  };
  if (params.unreadOnly) {
    filter.readAt = null;
  }

  const skip = (params.page - 1) * params.limit;
  const [rows, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(params.limit)
      .lean(),
    Notification.countDocuments(filter),
  ]);

  return {
    data: rows.map(toDto),
    meta: {
      page: params.page,
      limit: params.limit,
      total,
    },
  };
}

export async function countUnread(userId: string): Promise<{ unread: number }> {
  if (!Types.ObjectId.isValid(userId)) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  const unread = await Notification.countDocuments({
    userId: new Types.ObjectId(userId),
    readAt: null,
  });
  return { unread };
}

export async function markNotificationRead(params: {
  userId: string;
  notificationId: string;
}): Promise<NotificationDto> {
  if (!Types.ObjectId.isValid(params.userId)) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  if (!Types.ObjectId.isValid(params.notificationId)) {
    throw AppError.notFound('Notification not found');
  }

  const userOid = new Types.ObjectId(params.userId);
  const idOid = new Types.ObjectId(params.notificationId);

  // Scope to the caller — another user's id must look like NOT_FOUND.
  const existing = await Notification.findOne({
    _id: idOid,
    userId: userOid,
  });
  if (!existing) {
    throw AppError.notFound('Notification not found');
  }

  if (existing.readAt == null) {
    existing.readAt = new Date();
    await existing.save();
  }

  return toDto(existing);
}

export async function markAllNotificationsRead(
  userId: string,
): Promise<{ updated: number }> {
  if (!Types.ObjectId.isValid(userId)) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }

  const result = await Notification.updateMany(
    {
      userId: new Types.ObjectId(userId),
      readAt: null,
    },
    { $set: { readAt: new Date() } },
  );

  return { updated: result.modifiedCount };
}
