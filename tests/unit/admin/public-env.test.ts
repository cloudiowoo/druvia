import { afterEach, describe, expect, it, vi } from 'vitest';

import { getPublicApiBaseUrl, getPublicHasuraBaseUrl } from '../../../apps/admin/src/lib/public-env';

describe('public env helpers', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
  const originalHasuraUrl = process.env.NEXT_PUBLIC_HASURA_URL;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
    process.env.NEXT_PUBLIC_HASURA_URL = originalHasuraUrl;
    vi.unstubAllEnvs();
  });

  it('uses same-origin defaults in production when public URLs are omitted', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NEXT_PUBLIC_HASURA_URL;

    expect(getPublicApiBaseUrl()).toBe('');
    expect(getPublicHasuraBaseUrl()).toBe('');
  });

  it('uses localhost defaults outside production when public URLs are omitted', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NEXT_PUBLIC_HASURA_URL;

    expect(getPublicApiBaseUrl()).toBe('http://localhost:3001');
    expect(getPublicHasuraBaseUrl()).toBe('http://localhost:8080');
  });

  it('preserves explicit public URLs in production builds', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_API_URL = 'https://druvia.example.com';
    process.env.NEXT_PUBLIC_HASURA_URL = 'https://druvia.example.com';

    expect(getPublicApiBaseUrl()).toBe('https://druvia.example.com');
    expect(getPublicHasuraBaseUrl()).toBe('https://druvia.example.com');
  });
});
