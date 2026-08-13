import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { AppError } from '../../utils/AppError.js';
import { getStorageAdapter } from './storage.adapter.js';

const MAX_BYTES = 5 * 1024 * 1024;

export const thumbnailUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: 1,
  },
});

type DetectedImage = {
  format: 'jpeg' | 'png' | 'webp';
};

/**
 * Validate real file signatures — never trust client mimetype or extension.
 * Classic bypass: rename an executable to .png.
 */
export function detectImageMagicBytes(buffer: Buffer): DetectedImage | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { format: 'jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { format: 'png' };
  }

  // WEBP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { format: 'webp' };
  }

  return null;
}

export function handleThumbnailMulterError(
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      next(AppError.validation('File too large. Maximum size is 5MB.'));
      return;
    }
    next(AppError.validation(err.message));
    return;
  }
  next(err);
}

export async function uploadThumbnail(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const file = req.file;
    if (!file || !file.buffer) {
      throw AppError.validation('Missing file field "file"');
    }

    const detected = detectImageMagicBytes(file.buffer);
    if (!detected) {
      throw AppError.validation(
        'Invalid image. Only JPEG, PNG, and WebP files are accepted.',
      );
    }

    // Re-encode through sharp: strips EXIF, drops embedded payloads, kills polyglots.
    // Never store the original client bytes.
    const processed = await sharp(file.buffer, { failOn: 'error' })
      .rotate()
      .resize(1280, 720, {
        fit: 'cover',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer();

    const storage = getStorageAdapter();
    const { key } = await storage.save({ data: processed, extension: 'webp' });
    const url = storage.getPublicUrl(key);

    res.status(201).json({ url, publicId: key });
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    if (error instanceof Error && /unsupported|Input buffer/i.test(error.message)) {
      next(
        AppError.validation(
          'Invalid image. Only JPEG, PNG, and WebP files are accepted.',
        ),
      );
      return;
    }
    next(error);
  }
}
