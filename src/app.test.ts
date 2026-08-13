import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const app = createApp();

describe('Phase 1 foundation', () => {
  it('GET /api/health returns 200 with a valid db value', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(['disconnected', 'connected', 'connecting', 'disconnecting', 'unknown']).toContain(
      res.body.db,
    );
    expect(typeof res.body.uptimeSec).toBe('number');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('unknown route returns 404 with NOT_FOUND', async () => {
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('malformed JSON returns a body containing error.code', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error.code).toBe('string');
  });
});
