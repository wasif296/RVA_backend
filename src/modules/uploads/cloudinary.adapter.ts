import { randomUUID } from 'node:crypto';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import type { StorageAdapter } from './storage.adapter.js';

const THUMBNAIL_FOLDER = 'rva/thumbnails';

export type CloudinaryCredentials = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
};

type CloudinaryClient = typeof cloudinary;

export class CloudinaryAdapter implements StorageAdapter {
  private readonly client: CloudinaryClient;

  constructor(
    credentials: CloudinaryCredentials,
    client: CloudinaryClient = cloudinary,
  ) {
    if (!credentials.cloudName || !credentials.apiKey || !credentials.apiSecret) {
      throw new Error(
        'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are required',
      );
    }
    this.client = client;
    this.client.config({
      cloud_name: credentials.cloudName,
      api_key: credentials.apiKey,
      api_secret: credentials.apiSecret,
      secure: true,
    });
  }

  async save(params: { data: Buffer; extension: string }): Promise<{ key: string }> {
    void params.extension;
    const publicId = randomUUID();

    const uploaded = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = this.client.uploader.upload_stream(
        {
          folder: THUMBNAIL_FOLDER,
          public_id: publicId,
          resource_type: 'image',
          format: 'webp',
        },
        (error, result) => {
          if (error || !result) {
            reject(error ?? new Error('Cloudinary upload failed'));
            return;
          }
          resolve(result);
        },
      );
      stream.end(params.data);
    });

    return { key: uploaded.public_id };
  }

  async delete(key: string): Promise<void> {
    await this.client.uploader.destroy(key, { resource_type: 'image' });
  }

  getPublicUrl(key: string): string {
    const url = this.client.url(key, {
      secure: true,
      resource_type: 'image',
      type: 'upload',
      sign_url: false,
    });
    if (url.startsWith('https://')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`;
    return `https://${url}`;
  }
}
