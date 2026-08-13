import {
  Schema,
  model,
  type InferSchemaType,
  type Model,
  type Types,
} from 'mongoose';
import { RULES } from '@shared';

export type ExamSubmissionStatus = 'submitted' | 'graded';

export interface IExamSubmission {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  examId: Types.ObjectId;
  loomUrl?: string | null;
  docUrl: string;
  status: ExamSubmissionStatus;
  submittedAt: Date;
  /** null until a tutor grades the submission (next phase). */
  marksAwarded: number | null;
  /** Frozen at submission time — always FINAL_EXAM_MAX_MARKS today. */
  maxMarks: number;
  passed: boolean | null;
  gradedBy?: Types.ObjectId | null;
  gradedAt?: Date | null;
  feedback?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const examSubmissionSchema = new Schema<IExamSubmission>(
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
    examId: {
      type: Schema.Types.ObjectId,
      ref: 'Quiz',
      required: true,
    },
    loomUrl: { type: String, default: null, trim: true },
    docUrl: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['submitted', 'graded'] satisfies ExamSubmissionStatus[],
      required: true,
      default: 'submitted',
    },
    submittedAt: { type: Date, required: true },
    marksAwarded: { type: Number, default: null, min: 0 },
    maxMarks: {
      type: Number,
      required: true,
      default: RULES.FINAL_EXAM_MAX_MARKS,
    },
    passed: { type: Boolean, default: null },
    gradedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    gradedAt: { type: Date, default: null },
    feedback: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

// One written submission per learner per course.
examSubmissionSchema.index(
  { userId: 1, courseId: 1 },
  { name: 'exam_submission_user_course_unique', unique: true },
);

examSubmissionSchema.index({ courseId: 1, status: 1 });
examSubmissionSchema.index({ examId: 1 });

export type ExamSubmissionDocument = InferSchemaType<typeof examSubmissionSchema> & {
  _id: Types.ObjectId;
};

export const ExamSubmission: Model<IExamSubmission> = model<IExamSubmission>(
  'ExamSubmission',
  examSubmissionSchema,
);
