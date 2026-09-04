import { z } from 'zod';

export const lessonIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const heartbeatBodySchema = z.object({
  deltaSec: z.number().finite(),
  playerPositionSec: z.number().finite().min(0),
});

export type HeartbeatBody = z.infer<typeof heartbeatBodySchema>;
