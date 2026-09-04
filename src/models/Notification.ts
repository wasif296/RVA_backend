import {
  Schema,
  model,
  type InferSchemaType,
  type Model,
  type Types,
} from 'mongoose';

export type NotificationType = 'exam_graded' | 'badge_earned';

export interface INotification {
  userId: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  /** null until the recipient marks it read. */
  readAt: Date | null;
  /** Small ids the client needs for the destination link. */
  metadata: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

const NINETY_DAYS_SEC = 90 * 24 * 60 * 60;

const notificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['exam_graded', 'badge_earned'] satisfies NotificationType[],
      required: true,
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    link: { type: String, required: true, trim: true },
    readAt: { type: Date, default: null },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
// Drop stale rows automatically — unbounded notification tables grow unnoticed.
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: NINETY_DAYS_SEC, name: 'notification_ttl_90d' },
);

export type NotificationDocument = InferSchemaType<typeof notificationSchema> & {
  _id: Types.ObjectId;
};

export const Notification: Model<INotification> = model<INotification>(
  'Notification',
  notificationSchema,
);
