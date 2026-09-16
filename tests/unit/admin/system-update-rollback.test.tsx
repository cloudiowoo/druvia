// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DruviaUpdateStatus } from '@druvia/shared';
import { SystemUpdatePanel } from '../../../apps/admin/src/components/system-update/SystemUpdatePanel.js';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({ api: { getSystemUpdateStatus: vi.fn(), rollbackSystemUpdate: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const baseStatus: DruviaUpdateStatus = {
  enabled: true, phase: 'succeeded', currentVersion: '0.2.0', availableVersion: null,
  channel: 'stable', releaseNotesUrl: null, migration: null, operationId: null,
  startedAt: null, finishedAt: null, message: null, error: null,
};

describe('system update rollback availability', () => {
  beforeEach(() => vi.clearAllMocks());

  async function renderStatus(status: DruviaUpdateStatus) {
    vi.mocked(api.getSystemUpdateStatus).mockResolvedValue({ success: true, data: status });
    render(<SystemUpdatePanel />);
    return screen.findByRole('button', { name: '回滚' });
  }

  it('allows rollback after a completed update with a matching persisted backup', async () => {
    const button = await renderStatus({
      ...baseStatus,
      lastAppliedBackup: { operationId: 'op-apply', targetVersion: '0.2.0' },
    });
    expect(button).toBeEnabled();
  });

  it('requires confirmation that rolling back release files will not restore the database', async () => {
    vi.mocked(api.rollbackSystemUpdate).mockResolvedValue({ success: true, data: { operationId: 'op-rollback', status: baseStatus } });
    const button = await renderStatus({
      ...baseStatus, lastAppliedBackup: { operationId: 'op-apply', targetVersion: '0.2.0' },
    });
    fireEvent.click(button);
    expect(screen.getByText(/不会恢复数据库/)).toBeInTheDocument();
    expect(api.rollbackSystemUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认回滚' }));
    await waitFor(() => expect(api.rollbackSystemUpdate).toHaveBeenCalledOnce());
  });

  it('does not offer rollback for a failed update check without a usable backup', async () => {
    const button = await renderStatus({ ...baseStatus, phase: 'failed', operationId: 'op-check' });
    expect(button).toBeDisabled();
  });

  it('allows recovery of a failed apply with a backup operation id', async () => {
    const button = await renderStatus({
      ...baseStatus, phase: 'failed', operationId: 'op-apply', applyStage: 'files_switched',
    });
    expect(button).toBeEnabled();
  });
});
