import { describe, expect, it, vi } from 'vitest';
import { createDenoLogger, createExecutionConsole } from '../../docker/deno-worker/logging.ts';

describe('deno worker logging', () => {
  it('writes structured worker logs with execution context', () => {
    const write = vi.fn();
    const logger = createDenoLogger({
      service: 'deno-worker',
      env: 'test',
      context: {
        projectId: 'proj_123',
        functionName: 'wx-login-register',
        executionId: 'exec_123',
      },
      write,
    });

    logger.info('function execution started');

    expect(write).toHaveBeenCalledTimes(1);
    const [level, line] = write.mock.calls[0];
    expect(level).toBe('info');
    expect(JSON.parse(line)).toMatchObject({
      level: 'info',
      service: 'deno-worker',
      env: 'test',
      projectId: 'proj_123',
      functionName: 'wx-login-register',
      executionId: 'exec_123',
      msg: 'function execution started',
    });
  });

  it('converts console calls into structured logs', () => {
    const write = vi.fn();
    const logger = createDenoLogger({
      service: 'deno-worker',
      env: 'test',
      context: {
        projectId: 'proj_123',
        functionName: 'upload-avatar',
        executionId: 'exec_456',
      },
      write,
    });
    const executionConsole = createExecutionConsole(logger);

    executionConsole.error('upload failed', { code: 'UPLOAD_FAILED', detail: 'disk full' });

    expect(write).toHaveBeenCalledTimes(1);
    const [level, line] = write.mock.calls[0];
    expect(level).toBe('error');
    expect(JSON.parse(line)).toMatchObject({
      level: 'error',
      service: 'deno-worker',
      env: 'test',
      projectId: 'proj_123',
      functionName: 'upload-avatar',
      executionId: 'exec_456',
      msg: 'upload failed {"code":"UPLOAD_FAILED","detail":"disk full"}',
    });
  });

  it('preserves native console methods outside the structured overrides', () => {
    const write = vi.fn();
    const logger = createDenoLogger({
      service: 'deno-worker',
      env: 'test',
      write,
    });

    const executionConsole = createExecutionConsole(logger);

    expect(typeof executionConsole.trace).toBe('function');
  });

  it('does not throw on circular error payloads', () => {
    const write = vi.fn();
    const logger = createDenoLogger({
      service: 'deno-worker',
      env: 'test',
      write,
    });
    const error: Record<string, unknown> = {};
    error.self = error;

    expect(() => logger.error('worker crashed', undefined, error)).not.toThrow();
    expect(JSON.parse(String(write.mock.calls[0]?.[1] ?? '{}'))).toMatchObject({
      level: 'error',
      service: 'deno-worker',
      env: 'test',
      msg: 'worker crashed',
      err: {
        name: 'Error',
        message: '[unserializable object]',
      },
    });
  });
});
