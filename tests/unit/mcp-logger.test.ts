import { describe, expect, it, vi } from 'vitest';
import { createMcpLogger } from '../../packages/mcp-server/src/logger.js';

describe('mcp logger', () => {
  it('writes structured startup logs', () => {
    const write = vi.fn();
    const logger = createMcpLogger({
      service: 'mcp-server',
      env: 'test',
      context: {
        projectId: 'proj_123',
      },
      write,
    });

    logger.info('mcp server started');

    expect(write).toHaveBeenCalledTimes(1);
    const [level, line] = write.mock.calls[0];
    expect(level).toBe('info');
    expect(JSON.parse(line)).toMatchObject({
      level: 'info',
      service: 'mcp-server',
      env: 'test',
      projectId: 'proj_123',
      msg: 'mcp server started',
    });
  });

  it('serializes fatal errors with context', () => {
    const write = vi.fn();
    const logger = createMcpLogger({
      service: 'mcp-server',
      env: 'test',
      context: {
        projectId: 'proj_123',
      },
      write,
    });

    logger.error('fatal error', { module: 'startup' }, new Error('boom'));

    expect(write).toHaveBeenCalledTimes(1);
    const [level, line] = write.mock.calls[0];
    expect(level).toBe('error');
    expect(JSON.parse(line)).toMatchObject({
      level: 'error',
      service: 'mcp-server',
      env: 'test',
      projectId: 'proj_123',
      module: 'startup',
      msg: 'fatal error',
      err: {
        name: 'Error',
        message: 'boom',
      },
    });
  });

  it('does not throw on circular error payloads', () => {
    const write = vi.fn();
    const logger = createMcpLogger({
      service: 'mcp-server',
      env: 'test',
      write,
    });
    const error: Record<string, unknown> = {};
    error.self = error;

    expect(() => logger.error('fatal error', undefined, error)).not.toThrow();
    expect(JSON.parse(String(write.mock.calls[0]?.[1] ?? '{}'))).toMatchObject({
      level: 'error',
      service: 'mcp-server',
      env: 'test',
      msg: 'fatal error',
      err: {
        name: 'Error',
        message: '[unserializable object]',
      },
    });
  });

  it('writes info logs to stderr by default to avoid stdio protocol corruption', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    createMcpLogger({
      service: 'mcp-server',
      env: 'test',
    }).info('mcp server started');

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalledTimes(1);

    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });
});
