import { describe, expect, it } from 'vitest';
import {
  DRUVIA_MUTATING_UPDATE_PHASES,
  DRUVIA_RELEASE_CHANNELS,
  isDruviaUpdateMutatingPhase,
} from '../../packages/shared/src/update.js';

describe('Druvia update shared contract', () => {
  it('exports stable release channels and mutating phases', () => {
    expect(DRUVIA_RELEASE_CHANNELS).toEqual(['stable', 'beta', 'nightly']);
    expect(DRUVIA_MUTATING_UPDATE_PHASES).toEqual([
      'checking',
      'downloading',
      'applying',
      'restarting',
      'verifying',
    ]);
  });

  it('detects mutating update phases', () => {
    expect(isDruviaUpdateMutatingPhase('checking')).toBe(true);
    expect(isDruviaUpdateMutatingPhase('ready_to_apply')).toBe(false);
  });
});
