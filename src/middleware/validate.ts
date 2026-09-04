import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';

type RequestSource = 'body' | 'query' | 'params';

export function validate(schema: ZodTypeAny, source: RequestSource) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req[source]);
      Object.defineProperty(req, source, {
        value: parsed,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}
