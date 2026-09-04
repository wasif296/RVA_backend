import {
  Schema,
  model,
  type InferSchemaType,
  type Model,
  type Types,
} from 'mongoose';

export interface IQuizAttempt {
  userId: Types.ObjectId;
  lessonId: Types.ObjectId;
  quizId: Types.ObjectId;
  answers: number[];
  score: number;
  maxScore: number;
  correctCount: number;
  pointsDelta: number;
  attemptNumber: number;
  createdAt: Date;
}

const quizAttemptSchema = new Schema<IQuizAttempt>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lessonId: {
      type: Schema.Types.ObjectId,
      ref: 'Lesson',
      required: true,
    },
    quizId: {
      type: Schema.Types.ObjectId,
      ref: 'Quiz',
      required: true,
    },
    answers: { type: [Number], required: true },
    score: { type: Number, required: true, min: 0 },
    maxScore: { type: Number, required: true, min: 0 },
    correctCount: { type: Number, required: true, min: 0 },
    pointsDelta: { type: Number, required: true },
    attemptNumber: { type: Number, required: true, min: 1 },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

quizAttemptSchema.index({ userId: 1, lessonId: 1 });

export type QuizAttemptDocument = InferSchemaType<typeof quizAttemptSchema> & {
  _id: Types.ObjectId;
};

export const QuizAttempt: Model<IQuizAttempt> = model<IQuizAttempt>(
  'QuizAttempt',
  quizAttemptSchema,
);
