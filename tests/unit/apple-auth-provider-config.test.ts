import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AppleProviderConfigError,
  validateAppleProviderConfiguration,
} from '../../apps/api/src/modules/auth-admin/apple-provider-config.js';

let privateKeyPem: string;

beforeAll(async () => {
  const keys = await generateKeyPair('ES256', { extractable: true });
  privateKeyPem = await exportPKCS8(keys.privateKey);
});

describe('Apple provider configuration', () => {
  it('accepts a native Bundle ID configuration with a parseable ES256 private key', async () => {
    await expect(validateAppleProviderConfiguration({
      clientId: 'com.example.pitchetch',
      privateKeyPem,
      config: {
        teamId: 'TEAMID1234',
        keyId: 'KEYID12345',
        allowedAudiences: ['com.example.pitchetch'],
        flow: 'native',
      },
    })).resolves.toEqual({
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      allowedAudiences: ['com.example.pitchetch'],
      flow: 'native',
    });
  });

  it.each([
    ['invalid team ID', { teamId: 'too-short', keyId: 'KEYID12345', allowedAudiences: ['com.example.app'] }],
    ['duplicate audience', { teamId: 'TEAMID1234', keyId: 'KEYID12345', allowedAudiences: ['com.example.app', 'com.example.app'] }],
    ['client ID outside allowlist', { teamId: 'TEAMID1234', keyId: 'KEYID12345', allowedAudiences: ['com.other.app'] }],
    ['invalid audience syntax', { teamId: 'TEAMID1234', keyId: 'KEYID12345', allowedAudiences: ['.com.example'] }],
  ])('rejects %s', async (_label, config) => {
    await expect(validateAppleProviderConfiguration({
      clientId: 'com.example.app',
      privateKeyPem,
      config,
    })).rejects.toBeInstanceOf(AppleProviderConfigError);
  });

  it('rejects a non-EC private key before persistence', async () => {
    const rsa = await generateKeyPair('RS256', { extractable: true });
    const rsaPem = await exportPKCS8(rsa.privateKey);

    await expect(validateAppleProviderConfiguration({
      clientId: 'com.example.app',
      privateKeyPem: rsaPem,
      config: {
        teamId: 'TEAMID1234',
        keyId: 'KEYID12345',
        allowedAudiences: ['com.example.app'],
      },
    })).rejects.toMatchObject({ code: 'APPLE_PRIVATE_KEY_INVALID' });
  });
});
