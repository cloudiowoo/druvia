export function resolveWorkerApiBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const explicitInternalBaseUrl = env.INTERNAL_API_BASE_URL?.trim()
    || env.DRUVIA_INTERNAL_API_URL?.trim()
    || env.DRUVIA_API_URL?.trim()

  return explicitInternalBaseUrl || undefined
}
