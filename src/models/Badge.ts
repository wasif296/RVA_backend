import {
  Schema,
  model,
  type InferSchemaType,
  type Model,
  type Types,
} from 'mongoose';
import { RULES } from '@shared';

export interface IBadge {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  /** Frozen course title at award time. */
  courseTitle: string;
  examSubmissionId: Types.ObjectId;
  marksAwarded: number;
  maxMarks: number;
  earnedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const badgeSchema = new Schema<IBadge>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    courseTitle: { type: String, required: true, trim: true },
    examSubmissionId: {
      type: Schema.Types.ObjectId,
      ref: 'ExamSubmission',
      required: true,
    },
    marksAwarded: { type: Number, required: true, min: 0 },
    maxMarks: {
      type: Number,
      required: true,
      default: RULES.FINAL_EXAM_MAX_MARKS,
    },
    earnedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// One badge per learner per course — grading is one-shot, but enforce at the data layer too.
badgeSchema.index(
  { userId: 1, courseId: 1 },
  { name: 'badge_user_course_unique', unique: true },
);

badgeSchema.index({ userId: 1, earnedAt: -1 });

export type BadgeDocument = InferSchemaType<typeof badgeSchema> & {
  _id: Types.ObjectId;
};

export const Badge: Model<IBadge> = model<IBadge>('Badge', badgeSchema);
