import { describe, expect, it, vi } from 'vitest';
import { createApiLogger, toFastifySerializedError } from '../../apps/api/src/lib/logger.js';
import { runWithApiLogContext } from '../../apps/api/src/lib/log-context.js';

describe('api logger', () => {
  it('writes structured info logs to the provided sink', () => {
    const write = vi.fn();
    const logger = createApiLogger({
      service: 'api',
      env: 'test',
      module: 'redis',
      write,
    });

    logger.info('redis connected', { projectId: 'proj_123' });

    expect(write).toHaveBeenCalledTimes(1);
    const [level, line] = write.mock.calls[0];
    expect(level).toBe('info');
    expect(JSON.parse(line)).toMatchObject({
      level: 'info',
      service: 'api',
      env: 'test',
      module: 'redis',
      msg: 'redis connected',
      projectId: 'proj_123',
    });
  });

  it('carries child context into error logs', () => {
    const write = vi.fn();
    const logger = createApiLogger({
      service: 'api',
      env: 'test',
      module: 'functions',
      write,
    }).child({ projectId: 'proj_456', requestId: 'req_123' });

    logger.error('invoke failed', { functionName: 'wx-login-register' }, { code: 'INVOKE_FAILED', message: 'boom' });

    expect(write).toHaveBeenCalledTimes(1);
    const [level, line] = write.mock.calls[0];
    expect(level).toBe('error');
    expect(JSON.parse(line)).toMatchObject({
      level: 'error',
      service: 'api',
      env: 'test',
      module: 'functions',
      projectId: 'proj_456',
      requestId: 'req_123',
      functionName: 'wx-login-register',
      msg: 'invoke failed',
      err: {
        name: 'Error',
        code: 'INVOKE_FAILED',
        message: 'boom',
      },
    });
  });

  it('serializes fastify errors with required type field', () => {
    const error = new Error('boom');
    error.name = 'BoomError';
    Object.assign(error, { code: 'BOOM' });

    expect(toFastifySerializedError(error)).toMatchObject({
      type: 'BoomError',
      name: 'BoomError',
      message: 'boom',
      code: 'BOOM',
    });
    expect(toFastifySerializedError(error).stack).toBeTypeOf('string');
  });

  it('inherits active request context automatically', () => {
    const write = vi.fn();
    const logger = createApiLogger({
      service: 'api',
      env: 'test',
      module: 'project',
      write,
    });

    runWithApiLogContext({ requestId: 'req_123', projectId: 'proj_123' }, () => {
      logger.warn('project cleanup failed');
    });

    expect(write).toHaveBeenCalledTimes(1);
    const [level, line] = write.mock.calls[0];
    expect(level).toBe('warn');
    expect(JSON.parse(line)).toMatchObject({
      level: 'warn',
      service: 'api',
      env: 'test',
      module: 'project',
      requestId: 'req_123',
      projectId: 'proj_123',
      msg: 'project cleanup failed',
    });
  });
});
