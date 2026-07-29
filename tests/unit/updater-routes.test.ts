import { describe, expect, it, vi } from 'vitest';
import { createDefaultUpdateStatus } from '../../apps/updater/src/state.js';
import {
  UpdateOperationInProgressError,
  UpdatePreconditionError,
} from '../../apps/updater/src/update-service.js';
import { buildApp } from '../../apps/updater/src/index.js';

function createService() {
  const status = createDefaultUpdateStatus({ currentVersion: '0.1.0', channel: 'stable' });
  return {
    getStatus: vi.fn(async () => status),
    checkForUpdates: vi.fn(async () => ({ operationId: 'op-check', status })),
    downloadUpdate: vi.fn(async () => ({ operationId: 'op-download', status })),
    applyUpdate: vi.fn(async () => ({ operationId: 'op-apply', status })),
    rollbackUpdate: vi.fn(async () => ({ operationId: 'op-rollback', status })),
    restartServices: vi.fn(async () => ({ operationId: 'op-restart', status })),
  };
}

describe('updater routes', () => {
  it('keeps health public and protects every internal route with the updater secret', async () => {
    const service = createService();
    const app = buildApp({
      updaterSecret: 'secret',
      service,
    });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', service: 'druvia-updater' });

    const unauthorized = await app.inject({ method: 'GET', url: '/internal/update/status' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid updater secret' },
    });

    const authorized = await app.inject({
      method: 'GET',
      url: '/internal/update/status',
      headers: { 'x-druvia-updater-secret': 'secret' },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().phase).toBe('idle');
  });

  it('returns 202 for mutating internal operations and maps updater locks to 409', async () => {
    const service = createService();
    service.downloadUpdate.mockRejectedValueOnce(new UpdateOperationInProgressError('existing-op'));
    const app = buildApp({
      updaterSecret: 'secret',
      service,
    });

    const restart = await app.inject({
      method: 'POST',
      url: '/internal/restart',
      headers: { 'x-druvia-updater-secret': 'secret' },
    });
    expect(restart.statusCode).toBe(202);
    expect(restart.json().operationId).toBe('op-restart');
    expect(service.restartServices).toHaveBeenCalledTimes(1);

    const locked = await app.inject({
      method: 'POST',
      url: '/internal/update/download',
      headers: { 'x-druvia-updater-secret': 'secret' },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toEqual({
      error: { code: 'UPDATE_IN_PROGRESS', message: 'Update operation is already in progress', operationId: 'existing-op' },
    });
  });

  it('maps updater precondition errors to 409 instead of a generic server error', async () => {
    const service = createService();
    service.applyUpdate.mockRejectedValueOnce(new UpdatePreconditionError(
      'UPDATE_NOT_READY',
      'No downloaded update is ready to apply'
    ));
    const app = buildApp({
      updaterSecret: 'secret',
      service,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/update/apply',
      headers: { 'x-druvia-updater-secret': 'secret' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: 'UPDATE_NOT_READY', message: 'No downloaded update is ready to apply' },
    });
  });
});
