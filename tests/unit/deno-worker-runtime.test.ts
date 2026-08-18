import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { getElapsedDurationMs } from '../../docker/deno-worker/logging.ts';
import { createInvocationDeno } from '../../docker/deno-worker/function-environment.ts';

describe('deno worker runtime duration', () => {
  it('uses actual elapsed time instead of timeout budget for crash durations', () => {
    expect(getElapsedDurationMs(1_000, 1_240)).toBe(240);
  });

  it('exposes only invocation secrets through the Function Deno environment shim', () => {
    const inheritedGet = vi.fn(() => 'inherited-container-secret');
    const runtimeDeno = {
      env: { get: inheritedGet },
      serve: vi.fn(),
      version: { deno: '2.0.6' },
    };
    const functionDeno = createInvocationDeno(runtimeDeno, {
      APP_SECRET: 'function-secret',
    }) as typeof runtimeDeno & {
      env: {
        get(name: string): string | undefined;
        has(name: string): boolean;
        set(name: string, value: string): void;
        delete(name: string): void;
        toObject(): Record<string, string>;
      };
    };

    expect(functionDeno.env.get('APP_SECRET')).toBe('function-secret');
    expect(functionDeno.env.get('DENO_WORKER_SECRET')).toBeUndefined();
    expect(functionDeno.env.has('APP_SECRET')).toBe(true);
    functionDeno.env.set('LOCAL_ONLY', 'value');
    expect(functionDeno.env.toObject()).toEqual({
      APP_SECRET: 'function-secret',
      LOCAL_ONLY: 'value',
    });
    functionDeno.env.delete('APP_SECRET');
    expect(functionDeno.env.get('APP_SECRET')).toBeUndefined();
    expect(inheritedGet).not.toHaveBeenCalled();
    expect(functionDeno.version).toEqual({ deno: '2.0.6' });
  });

  it('does not persist Function environment mutations into a later invocation', () => {
    const runtimeDeno = { env: {} };
    const first = createInvocationDeno(runtimeDeno, { TOKEN: 'first' }) as {
      env: { set(name: string, value: string): void; get(name: string): string | undefined };
    };
    first.env.set('MUTATED', 'yes');

    const second = createInvocationDeno(runtimeDeno, { TOKEN: 'second' }) as {
      env: { get(name: string): string | undefined };
    };

    expect(second.env.get('TOKEN')).toBe('second');
    expect(second.env.get('MUTATED')).toBeUndefined();
  });

  it('denies inherited environment access in the child Worker and keeps credentials out of messages', () => {
    const mainSource = readFileSync('docker/deno-worker/main.ts', 'utf8');
    const executorSource = readFileSync('docker/deno-worker/executor.ts', 'utf8');
    const postMessageStart = mainSource.indexOf('worker.postMessage({')
    const postMessageEnd = mainSource.indexOf('\n    });', postMessageStart)
    const postMessageSource = mainSource.slice(postMessageStart, postMessageEnd)

    expect(mainSource).toContain('env: false')
    expect(postMessageStart).toBeGreaterThan(-1)
    expect(postMessageSource).not.toContain('workerSecret')
    expect(executorSource).not.toContain('Deno.env.get(')
  });
});
