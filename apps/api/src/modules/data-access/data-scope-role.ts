import { createHash } from 'node:crypto'

export type DataScopeActor = 'authenticated' | 'anonymous'

export interface DataScopeRoleInput {
  projectId: string
  environmentId?: number
  actor: DataScopeActor
}

const ROLE_SUFFIXES: Record<DataScopeActor, string> = {
  authenticated: 'user',
  anonymous: 'anon',
}

export function resolveDataScopeRole(input: DataScopeRoleInput): string {
  if (!input.projectId.trim()) {
    throw new Error('Project ID is required')
  }
  if (
    input.environmentId !== undefined
    && (!Number.isInteger(input.environmentId) || input.environmentId <= 0)
  ) {
    throw new Error('Environment ID must be a positive integer')
  }

  const suffix = ROLE_SUFFIXES[input.actor]
  if (!suffix) {
    throw new Error(`Unsupported data scope actor: ${String(input.actor)}`)
  }

  const scopeIdentity = input.environmentId === undefined
    ? `project:${input.projectId}:prod`
    : `project:${input.projectId}:environment:${input.environmentId}`
  const scopeHash = createHash('sha256')
    .update(scopeIdentity)
    .digest('hex')
    .slice(0, 20)

  return `druvia_v1_s_${scopeHash}_${suffix}`
}
