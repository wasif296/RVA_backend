import {
  Schema,
  model,
  type InferSchemaType,
  type Model,
  type Types,
} from 'mongoose';

export interface IProgressLesson {
  lessonId: Types.ObjectId;
  watchedSec: number;
  lastHeartbeatAt?: Date;
  firstHeartbeatAt?: Date;
  videoCompletedAt?: Date;
  videoPointsAwarded: boolean;
  bestQuizScore: number;
  quizPointsAwarded: number;
  attempts: number;
}

export interface IProgress {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  lessons: IProgressLesson[];
  lastLessonId?: Types.ObjectId;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const progressLessonSchema = new Schema<IProgressLesson>(
  {
    lessonId: { type: Schema.Types.ObjectId, ref: 'Lesson', required: true },
    watchedSec: { type: Number, default: 0, min: 0 },
    lastHeartbeatAt: { type: Date },
    firstHeartbeatAt: { type: Date },
    videoCompletedAt: { type: Date },
    videoPointsAwarded: { type: Boolean, default: false },
    bestQuizScore: { type: Number, default: 0, min: 0 },
    quizPointsAwarded: { type: Number, default: 0, min: 0 },
    attempts: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const progressSchema = new Schema<IProgress>(
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
    lessons: { type: [progressLessonSchema], default: [] },
    lastLessonId: { type: Schema.Types.ObjectId, ref: 'Lesson' },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

progressSchema.index({ userId: 1, courseId: 1 }, { unique: true });

export type ProgressDocument = InferSchemaType<typeof progressSchema> & {
  _id: Types.ObjectId;
};

export const Progress: Model<IProgress> = model<IProgress>('Progress', progressSchema);
