import { AppError } from './AppError.js';

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Accepts a bare 11-character YouTube video ID or a full URL
 * (watch?v=, youtu.be/, /embed/, /shorts/) and returns the ID.
 */
export function parseYouTubeVideoId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new AppError(
      'VALIDATION_ERROR',
      'YouTube video ID or URL is required',
    );
  }

  if (VIDEO_ID_RE.test(trimmed)) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(
      'VALIDATION_ERROR',
      'Must be a YouTube URL or an 11-character video ID',
    );
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0]?.split('?')[0];
    if (id && VIDEO_ID_RE.test(id)) {
      return id;
    }
  }

  if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtube-nocookie.com'
  ) {
    const fromQuery = url.searchParams.get('v');
    if (fromQuery && VIDEO_ID_RE.test(fromQuery)) {
      return fromQuery;
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const kind = segments[0]?.toLowerCase();
    if (
      kind === 'embed' ||
      kind === 'shorts' ||
      kind === 'v' ||
      kind === 'live'
    ) {
      const id = segments[1]?.split('?')[0];
      if (id && VIDEO_ID_RE.test(id)) {
        return id;
      }
    }
  }

  throw new AppError(
    'VALIDATION_ERROR',
    'Must be a YouTube URL or an 11-character video ID',
  );
}
