import {
  Schema,
  model,
  type InferSchemaType,
  type Model,
  type Types,
} from 'mongoose';

export type InvitePurpose = 'invite' | 'password_reset';

export interface IInviteToken {
  userId: Types.ObjectId;
  /** argon2 hash of the raw token — a leaked database must not hand over working links. */
  tokenHash: string;
  purpose: InvitePurpose;
  expiresAt: Date;
  usedAt?: Date;
  createdBy?: Types.ObjectId;
  createdAt: Date;
}

const inviteTokenSchema = new Schema<IInviteToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    purpose: {
      type: String,
      enum: ['invite', 'password_reset'] satisfies InvitePurpose[],
      required: true,
    },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

inviteTokenSchema.index({ userId: 1, purpose: 1 });
inviteTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type InviteTokenDocument = InferSchemaType<typeof inviteTokenSchema> & {
  _id: Types.ObjectId;
};

export const InviteToken: Model<IInviteToken> = model<IInviteToken>(
  'InviteToken',
  inviteTokenSchema,
);
