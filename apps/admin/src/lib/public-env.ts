function resolvePublicBaseUrl(value: string | undefined, developmentDefault: string) {
  if (value !== undefined) {
    return value;
  }

  return process.env.NODE_ENV === 'production' ? '' : developmentDefault;
}

export function getPublicApiBaseUrl() {
  return resolvePublicBaseUrl(process.env.NEXT_PUBLIC_API_URL, 'http://localhost:3001');
}

export function getPublicHasuraBaseUrl() {
  return resolvePublicBaseUrl(process.env.NEXT_PUBLIC_HASURA_URL, 'http://localhost:8080');
}
