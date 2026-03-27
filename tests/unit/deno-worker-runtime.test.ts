import { describe, expect, it } from 'vitest';
import { getElapsedDurationMs } from '../../docker/deno-worker/logging.ts';

describe('deno worker runtime duration', () => {
  it('uses actual elapsed time instead of timeout budget for crash durations', () => {
    expect(getElapsedDurationMs(1_000, 1_240)).toBe(240);
  });
});
