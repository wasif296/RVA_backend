import {
  Schema,
  model,
  type InferSchemaType,
  type Model,
  type Types,
} from 'mongoose';
import { RULES } from '../shared/index.js';

export interface ILesson {
  courseId: Types.ObjectId;
  title: string;
  description: string;
  youtubeVideoId: string;
  durationSec: number;
  requiredWatchSec: number;
  /** True when an admin set requiredWatchSec explicitly (not the 90% default). */
  watchTargetOverridden: boolean;
  order: number;
  sectionId?: Types.ObjectId | null;
  isOptional: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const lessonSchema = new Schema<ILesson>(
  {
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    youtubeVideoId: { type: String, required: true, trim: true },
    durationSec: { type: Number, required: true, min: 1 },
    requiredWatchSec: { type: Number, min: 1 },
    watchTargetOverridden: { type: Boolean, default: false },
    order: { type: Number, required: true },
    sectionId: { type: Schema.Types.ObjectId, default: null },
    isOptional: { type: Boolean, default: false },
  },
  { timestamps: true },
);

lessonSchema.index({ courseId: 1, order: 1 }, { unique: true });

lessonSchema.pre('validate', function (next) {
  if (this.requiredWatchSec == null && typeof this.durationSec === 'number') {
    this.requiredWatchSec = Math.ceil(this.durationSec * RULES.VIDEO_COMPLETION_RATIO);
  }
  next();
});

export type LessonDocument = InferSchemaType<typeof lessonSchema> & {
  _id: Types.ObjectId;
};

export const Lesson: Model<ILesson> = model<ILesson>('Lesson', lessonSchema);
