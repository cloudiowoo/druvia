import { describe, expect, it } from 'vitest';
import {
  createStructuredLogEntry,
  serializeError,
  type StructuredLogLevel,
} from '../../packages/shared/src/logging/index.js';

function expectIsoTimestamp(value: string) {
  expect(value).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  );
}

describe('shared logging helpers', () => {
  it('serializes native errors with stable fields', () => {
    const error = new Error('boom');
    error.name = 'BoomError';
    Object.assign(error, { code: 'BOOM' });

    expect(serializeError(error)).toMatchObject({
      name: 'BoomError',
      code: 'BOOM',
      message: 'boom',
    });
    expect(serializeError(error).stack).toBeTypeOf('string');
  });

  it('serializes plain thrown objects with code and message', () => {
    expect(serializeError({ code: 'E_FAIL', message: 'failed' })).toEqual({
      name: 'Error',
      code: 'E_FAIL',
      message: 'failed',
    });
  });

  it('falls back safely for unknown thrown values', () => {
    expect(serializeError('bad')).toEqual({
      name: 'Error',
      message: 'bad',
    });
  });

  it('does not throw when serializing circular objects', () => {
    const error: Record<string, unknown> = {};
    error.self = error;

    expect(() => serializeError(error)).not.toThrow();
    expect(serializeError(error)).toEqual({
      name: 'Error',
      message: '[unserializable object]',
    });
  });

  it('creates structured log entries with context and error payload', () => {
    const level: StructuredLogLevel = 'warn';
    const entry = createStructuredLogEntry({
      level,
      service: 'api',
      msg: 'rate limit degraded',
      env: 'test',
      context: {
        module: 'ratelimit',
        requestId: 'req_123',
        projectId: 'proj_123',
      },
      err: { code: 'REDIS_DOWN', message: 'redis unavailable' },
      ts: '2026-03-27T12:00:00.000Z',
    });

    expect(entry).toEqual({
      ts: '2026-03-27T12:00:00.000Z',
      level: 'warn',
      service: 'api',
      msg: 'rate limit degraded',
      env: 'test',
      module: 'ratelimit',
      requestId: 'req_123',
      projectId: 'proj_123',
      err: {
        name: 'Error',
        code: 'REDIS_DOWN',
        message: 'redis unavailable',
      },
    });
  });

  it('generates an ISO timestamp when one is not provided', () => {
    const entry = createStructuredLogEntry({
      level: 'info',
      service: 'api',
      msg: 'started',
    });

    expectIsoTimestamp(entry.ts);
    expect(entry).toMatchObject({
      level: 'info',
      service: 'api',
      msg: 'started',
    });
  });
});
