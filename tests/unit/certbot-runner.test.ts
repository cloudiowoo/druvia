import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runnerPath = join(process.cwd(), 'docker/certbot/run-certbot.sh');

describe('certbot runner', () => {
  it('uses the DNSPod authenticator without the ambiguous bare dns-dnspod option', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'druvia-certbot-'));

    try {
      const binDir = join(tempDir, 'bin');
      const credentialsPath = join(tempDir, 'dnspod.ini');
      const argsPath = join(tempDir, 'certbot-args.txt');

      writeFileSync(credentialsPath, 'dns_dnspod_api_id = id\n');
      spawnSync('mkdir', ['-p', binDir]);
      writeFileSync(
        join(binDir, 'certbot'),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$CERTBOT_ARGS_FILE"\nexit 42\n',
        { mode: 0o755 }
      );

      const result = spawnSync('/bin/sh', [runnerPath, 'issue'], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CERTBOT_ARGS_FILE: argsPath,
          CERTBOT_EMAIL: 'admin@example.com',
          CERTBOT_PRIMARY_DOMAIN: 'example.com',
          CERTBOT_WILDCARD_DOMAIN: '*.example.com',
          CERTBOT_DNSPOD_CREDENTIALS: credentialsPath,
          CERTBOT_OUTPUT_DIR: tempDir,
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(42);
      const args = readFileSync(argsPath, 'utf8').trim().split('\n');

      expect(args).toContain('--authenticator');
      expect(args).toContain('dns-dnspod');
      expect(args).not.toContain('--dns-dnspod');
      expect(args).toContain('--dns-dnspod-credentials');
      expect(args).toContain(credentialsPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
