import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createAdminServerLogger } from '../../../apps/admin/src/lib/server-logger';
import { api } from '../../../apps/admin/src/lib/api';

describe('admin server logger', () => {
  it('writes structured logs to stdout/stderr', () => {
    const write = vi.fn();
    const logger = createAdminServerLogger({
      service: 'admin',
      env: 'test',
      module: 'api-client',
      write,
    });

    logger.error('upstream api request failed', { path: '/api/v1/projects/proj_123' }, new Error('boom'));

    expect(write).toHaveBeenCalledTimes(1);
    const [level, line] = write.mock.calls[0];
    expect(level).toBe('error');
    expect(JSON.parse(line)).toMatchObject({
      level: 'error',
      service: 'admin',
      env: 'test',
      module: 'api-client',
      path: '/api/v1/projects/proj_123',
      msg: 'upstream api request failed',
      err: {
        name: 'Error',
        message: 'boom',
      },
    });
  });

  it('does not throw on circular error payloads', () => {
    const write = vi.fn();
    const logger = createAdminServerLogger({
      service: 'admin',
      env: 'test',
      module: 'api-client',
      write,
    });
    const error: Record<string, unknown> = {};
    error.self = error;

    expect(() => logger.error('circular error payload', undefined, error)).not.toThrow();
    expect(JSON.parse(String(write.mock.calls[0]?.[1] ?? '{}'))).toMatchObject({
      level: 'error',
      service: 'admin',
      env: 'test',
      module: 'api-client',
      msg: 'circular error payload',
      err: {
        name: 'Error',
        message: '[unserializable object]',
      },
    });
  });
});

describe('admin api server-side logging', () => {
  const originalFetch = global.fetch;
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  beforeEach(() => {
    stderrWrite.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    api.setToken(null);
  });

  it('logs upstream api failures during server-side requests', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 500,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'boom' },
      }),
    } satisfies Partial<Response>);

    const response = await api.getProject('proj_123');

    expect(response.success).toBe(false);
    expect(stderrWrite).toHaveBeenCalled();
    expect(String(stderrWrite.mock.calls.at(-1)?.[0] ?? '')).toContain('"service":"admin"');
    expect(String(stderrWrite.mock.calls.at(-1)?.[0] ?? '')).toContain('"module":"api-client"');
    expect(String(stderrWrite.mock.calls.at(-1)?.[0] ?? '')).toContain('"projectId":"proj_123"');
  });

  it('does not log expected 4xx business failures as operational warnings', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'bad request' },
      }),
    } satisfies Partial<Response>);

    const response = await api.getProject('proj_123');

    expect(response.success).toBe(false);
    expect(stderrWrite).not.toHaveBeenCalled();
  });
});
