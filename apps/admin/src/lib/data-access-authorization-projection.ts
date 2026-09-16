export interface AuthorizationProjectionContract {
  contractVersion: 1
  policyVersion: 2
  view: {
    name: string
    projectionMode: 'sparse_allow_list'
    key: string[]
    columns: Record<string, 'uuid' | 'boolean' | 'text'>
    clientPermissions: { select: false; insert: false; update: false; delete: false }
  }
  relationships: Array<{
    table: string
    name: string
    type: 'object'
    mapping: Record<string, string>
    ownerColumn: string
    actorColumn: string
    allowColumn: string
  }>
}

export interface AuthorizationProjectionOperation {
  operationId: string
  projectId: string
  schemaName: string
  status: 'preview_ready' | 'applying' | 'recovering' | 'completed'
    | 'failed' | 'recovery_required' | 'superseded'
  sourceDigest: string
  targetDigest: string
  dependencyDigest: string
  baselineRevisions: Record<string, string>
  tables: Array<{
    table: string
    relationship: string
    ownerColumn: string
    allowColumn: string
  }>
}
