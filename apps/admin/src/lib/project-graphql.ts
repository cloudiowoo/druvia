export type GraphqlCredentialMode = 'apikey' | 'project_user';

export function buildGraphqlCredentialHeaders(
  mode: GraphqlCredentialMode,
  credential: string
): Record<string, string> | null {
  const value = credential.trim();
  if (!value) return null;

  return mode === 'apikey'
    ? { apikey: value }
    : { Authorization: `Bearer ${value}` };
}

export function buildProjectGraphqlEndpoint(apiBaseUrl: string, projectId: string): string {
  const baseUrl = apiBaseUrl.replace(/\/+$/, '');
  return `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/graphql`;
}
