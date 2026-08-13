import { z } from 'zod';

/** Query is intentionally empty of userId — identity comes from the access token only. */
export const progressSummaryQuerySchema = z
  .object({})
  .passthrough()
  .transform(() => ({}));
