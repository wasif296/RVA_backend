import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { CloudinaryAdapter } from './cloudinary.adapter.js';

/**
 * Swap this at deploy time (Cloudinary / S3) without touching routes or services.
 * Routes, services, and tests must depend on this interface only.
 */
export interface StorageAdapter {
  save(params: { data: Buffer; extension: string }): Promise<{ key: string; url?: string }>;
  delete(key: string): Promise<void>;
  getPublicUrl(key: string): string;
}

function assertSafeKey(key: string): string {
  const base = path.basename(key);
  if (base !== key || key.includes('..') || key.includes('/') || key.includes('\\')) {
    throw new Error('Invalid storage key');
  }
  return base;
}

export class LocalDiskAdapter implements StorageAdapter {
  constructor(
    private readonly uploadDir: string,
    private readonly publicBaseUrl: string,
  ) {}

  async ensureReady(): Promise<void> {
    await mkdir(this.uploadDir, { recursive: true });
  }

  async save(params: { data: Buffer; extension: string }): Promise<{ key: string }> {
    await this.ensureReady();
    const ext = params.extension.replace(/^\./, '').toLowerCase();
    const key = `${randomUUID()}.${ext}`;
    const destination = path.join(this.uploadDir, key);

    // Refuse to write outside the upload directory even if key were ever tainted.
    const resolved = path.resolve(destination);
    const root = path.resolve(this.uploadDir);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error('Refusing to write outside upload directory');
    }

    await pipeline(Readable.from(params.data), createWriteStream(resolved));
    return { key };
  }

  async delete(key: string): Promise<void> {
    const safe = assertSafeKey(key);
    const target = path.join(this.uploadDir, safe);
    const resolved = path.resolve(target);
    const root = path.resolve(this.uploadDir);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error('Refusing to delete outside upload directory');
    }
    await unlink(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  getPublicUrl(key: string): string {
    const safe = assertSafeKey(key);
    const base = this.publicBaseUrl.replace(/\/$/, '');
    return `${base}/${safe}`;
  }
}

let storageSingleton: StorageAdapter | null = null;

export function createStorageAdapter(
  driver: 'local' | 'cloudinary' = env.STORAGE_DRIVER,
): StorageAdapter {
  if (driver === 'cloudinary') {
    return new CloudinaryAdapter({
      cloudName: env.CLOUDINARY_CLOUD_NAME ?? '',
      apiKey: env.CLOUDINARY_API_KEY ?? '',
      apiSecret: env.CLOUDINARY_API_SECRET ?? '',
    });
  }
  return new LocalDiskAdapter(
    path.resolve(env.UPLOAD_DIR),
    env.PUBLIC_UPLOAD_BASE_URL,
  );
}

export function setStorageAdapter(adapter: StorageAdapter): void {
  storageSingleton = adapter;
}

export function getStorageAdapter(): StorageAdapter {
  if (!storageSingleton) {
    storageSingleton = createStorageAdapter();
  }
  return storageSingleton;
}

/** Test helper — reset singleton between suites when UPLOAD_DIR changes. */
export function resetStorageAdapterForTests(): void {
  storageSingleton = null;
}
