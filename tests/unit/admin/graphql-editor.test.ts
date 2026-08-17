import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildGraphqlCredentialHeaders,
  buildProjectGraphqlEndpoint,
} from '../../../apps/admin/src/lib/project-graphql.js'

describe('project GraphQL application credentials', () => {
  it('builds API-key headers without an Authorization bearer', () => {
    expect(buildGraphqlCredentialHeaders('apikey', ' druvia-key ')).toEqual({
      apikey: 'druvia-key',
    })
  })

  it('builds Project access-token headers without an API key', () => {
    expect(buildGraphqlCredentialHeaders('project_user', ' project-token ')).toEqual({
      Authorization: 'Bearer project-token',
    })
  })

  it('does not produce executable headers for an empty credential', () => {
    expect(buildGraphqlCredentialHeaders('apikey', '   ')).toBeNull()
    expect(buildGraphqlCredentialHeaders('project_user', '')).toBeNull()
  })

  it('builds the Druvia project proxy endpoint with an encoded project id', () => {
    expect(buildProjectGraphqlEndpoint('https://api.druvia.io/', 'project/a'))
      .toBe('https://api.druvia.io/api/v1/projects/project%2Fa/graphql')
  })

  it('does not read the platform login token in the GraphQL editor', () => {
    const source = readFileSync(
      'apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/GraphQLEditor.tsx',
      'utf8'
    )

    expect(source).not.toContain("from '@/lib/api'")
    expect(source).not.toContain('api.getToken()')
  })

  it('disables execution without credentials and clears credentials on mode change', () => {
    const source = readFileSync(
      'apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/GraphQLEditor.tsx',
      'utf8'
    )

    expect(source).toContain('disabled={loading || !credentialHeaders}')
    expect(source).toContain("setCredential('')")
    expect(source).toContain('setShowCredential(false)')
  })
})
