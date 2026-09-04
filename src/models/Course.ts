import {
  Schema,
  model,
  type InferSchemaType,
  type Model,
  type Types,
} from 'mongoose';
import type { CourseLevel, CourseStatus } from '../shared/index.js';

export interface ICourse {
  title: string;
  slug: string;
  description: string;
  thumbnailUrl?: string;
  /** Cloudinary public_id only. Null for https URLs and legacy local-disk paths. */
  thumbnailPublicId?: string | null;
  category: string;
  level: CourseLevel;
  status: CourseStatus;
  lessonCount: number;
  totalDurationSec: number;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const courseSchema = new Schema<ICourse>(
  {
    title: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    description: { type: String, required: true },
    thumbnailUrl: { type: String },
    thumbnailPublicId: { type: String, default: null },
    category: { type: String, required: true, trim: true },
    level: {
      type: String,
      enum: ['beginner', 'intermediate', 'advanced'] satisfies CourseLevel[],
      required: true,
    },
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'] satisfies CourseStatus[],
      required: true,
    },
    lessonCount: { type: Number, default: 0 },
    totalDurationSec: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export type CourseDocument = InferSchemaType<typeof courseSchema> & {
  _id: Types.ObjectId;
};

export const Course: Model<ICourse> = model<ICourse>('Course', courseSchema);
