import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAdapter } from '../../apps/api/src/adapters/storage/local.adapter.js';
it('keeps private backups owner-readable only, including replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'druvia-private-backup-'));
  try {
    const adapter = new LocalAdapter({ basePath: root, publicUrl: '/storage' });
    await adapter.upload(Buffer.from('synthetic'), 'backups/one.dump', { acl: 'private' });
    expect((await stat(join(root, 'backups/one.dump'))).mode & 0o777).toBe(0o600);
    await writeFile(join(root, 'legacy.dump'), 'synthetic', { mode: 0o644 });
    await adapter.upload(Buffer.from('replacement'), 'legacy.dump', { acl: 'private' });
    expect((await stat(join(root, 'legacy.dump'))).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
