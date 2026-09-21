import {
  SERVICE_ENVIRONMENTS,
  type ProjectRuntimeContext,
  type ServiceEnvironment,
} from '@druvia/shared'
import { getClient, queryOne } from '../../db/index.js'
import { logActivity } from '../activity/activity.service.js'

interface RuntimeContextRow {
  service_environment: string
  revision: string | number
  updated_at: Date | string | null
}

type EnabledProjectRuntimeContext = Extract<ProjectRuntimeContext, { enabled: true }>

interface TransactionRuntimeContextRow {
  project_id: string
  service_environment: string | null
  revision: string | number | null
  updated_at: Date | string | null
}

interface RuntimeContextClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[] }>
  release(error?: Error): void
}

interface ProjectRuntimeContextDependencies {
  queryOne<T>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null>
  getClient(): Promise<RuntimeContextClient>
  logActivity: typeof logActivity
}

interface SetProjectRuntimeContextInput {
  projectId: string
  serviceEnvironment: ServiceEnvironment
  actorUserId: string
  requestId?: string
}

interface DisableProjectRuntimeContextInput {
  projectId: string
  actorUserId: string
  requestId?: string
}

export const HASURA_SERVICE_ENVIRONMENT_HEADER = 'x-hasura-druvia-service-environment'

export class ProjectRuntimeContextError extends Error {
  readonly code = 'PROJECT_RUNTIME_CONTEXT_UNAVAILABLE'
  readonly statusCode = 503

  constructor() {
    super('Project runtime context is unavailable')
    this.name = 'ProjectRuntimeContextError'
  }
}

export class ProjectRuntimeContextNotFoundError extends Error {
  readonly code = 'PROJECT_NOT_FOUND'
  readonly statusCode = 404

  constructor() {
    super('Project not found')
    this.name = 'ProjectRuntimeContextNotFoundError'
  }
}

function isServiceEnvironment(value: unknown): value is ServiceEnvironment {
  return typeof value === 'string'
    && (SERVICE_ENVIRONMENTS as readonly string[]).includes(value)
}

function normalizeRevision(value: unknown): number | null {
  const revision = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null
}

function normalizeUpdatedAt(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeRuntimeContext(row: RuntimeContextRow): EnabledProjectRuntimeContext {
  const revision = normalizeRevision(row.revision)
  const updatedAt = normalizeUpdatedAt(row.updated_at)
  if (!isServiceEnvironment(row.service_environment) || revision === null || updatedAt === null) {
    throw new ProjectRuntimeContextError()
  }

  return {
    enabled: true,
    serviceEnvironment: row.service_environment,
    revision,
    updatedAt,
  }
}

export function getRuntimeContextHasuraSessionVariables(
  runtimeContext: ProjectRuntimeContext,
): Record<string, string> {
  return runtimeContext.enabled
    ? { [HASURA_SERVICE_ENVIRONMENT_HEADER]: runtimeContext.serviceEnvironment }
    : {}
}

export function createProjectRuntimeContextService(dependencies: ProjectRuntimeContextDependencies) {
  return {
    async getProjectRuntimeContext(projectId: string): Promise<ProjectRuntimeContext> {
      try {
        const row = await dependencies.queryOne<RuntimeContextRow>(
          `SELECT service_environment, revision, updated_at
             FROM druvia_project_runtime_contexts
            WHERE project_id = $1`,
          [projectId],
        )

        return row ? normalizeRuntimeContext(row) : { enabled: false }
      } catch (error) {
        if (error instanceof ProjectRuntimeContextError) throw error
        throw new ProjectRuntimeContextError()
      }
    },

    async getProjectRuntimeContextInTransaction(
      client: RuntimeContextClient,
      projectId: string,
    ): Promise<ProjectRuntimeContext> {
      const result = await client.query(
        `SELECT p.project_id, c.service_environment, c.revision, c.updated_at
           FROM druvia_projects p
           LEFT JOIN druvia_project_runtime_contexts c ON c.project_id = p.project_id
          WHERE p.project_id = $1
          FOR KEY SHARE OF p`,
        [projectId],
      )
      const row = result.rows[0] as TransactionRuntimeContextRow | undefined
      if (!row) throw new ProjectRuntimeContextNotFoundError()
      if (row.service_environment === null || row.revision === null) return { enabled: false }
      return normalizeRuntimeContext({
        service_environment: row.service_environment,
        revision: row.revision,
        updated_at: row.updated_at,
      })
    },

    async setProjectRuntimeContext(input: SetProjectRuntimeContextInput): Promise<ProjectRuntimeContext> {
      if (!isServiceEnvironment(input.serviceEnvironment)) {
        throw new ProjectRuntimeContextError()
      }

      const client = await dependencies.getClient()
      let transactionStarted = false
      let releaseError: Error | undefined
      try {
        await client.query('BEGIN')
        transactionStarted = true

        const project = await client.query(
          `SELECT project_id
             FROM druvia_projects
            WHERE project_id = $1
            FOR UPDATE`,
          [input.projectId],
        )
        if (!project.rows[0]) throw new ProjectRuntimeContextNotFoundError()

        const currentResult = await client.query(
          `SELECT service_environment, revision, updated_at
             FROM druvia_project_runtime_contexts
            WHERE project_id = $1
            FOR UPDATE`,
          [input.projectId],
        )
        const currentRow = currentResult.rows[0] as RuntimeContextRow | undefined
        const current: ProjectRuntimeContext = currentRow
          ? normalizeRuntimeContext(currentRow)
          : { enabled: false as const }

        if (current.enabled && current.serviceEnvironment === input.serviceEnvironment) {
          await client.query('COMMIT')
          return current
        }

        const result = await client.query(
          `INSERT INTO druvia_project_runtime_contexts
             (project_id, service_environment, revision, created_by, updated_by)
           VALUES ($1, $2, 1, $3, $3)
           ON CONFLICT (project_id) DO UPDATE
             SET service_environment = EXCLUDED.service_environment,
                 revision = druvia_project_runtime_contexts.revision + 1,
                 updated_by = EXCLUDED.updated_by
           RETURNING service_environment, revision, updated_at`,
          [input.projectId, input.serviceEnvironment, input.actorUserId],
        )
        const nextRow = result.rows[0] as RuntimeContextRow | undefined
        if (!nextRow) throw new ProjectRuntimeContextError()
        const next = normalizeRuntimeContext(nextRow)

        await client.query(
          `INSERT INTO druvia_project_runtime_context_fences (project_id)
           VALUES ($1)
           ON CONFLICT (project_id) DO NOTHING`,
          [input.projectId],
        )

        const oldServiceEnvironment = current.enabled ? current.serviceEnvironment : null
        await dependencies.logActivity(
          input.actorUserId,
          'project.runtime_context_updated',
          'project',
          input.projectId,
          {
            oldServiceEnvironment,
            serviceEnvironment: next.serviceEnvironment,
            revision: next.revision,
            ...(input.requestId ? { requestId: input.requestId } : {}),
          },
          client as never,
        )

        await client.query('COMMIT')
        return next
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query('ROLLBACK')
          } catch (rollbackError) {
            releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
          }
        }
        throw releaseError ?? error
      } finally {
        client.release(releaseError)
      }
    },

    async disableProjectRuntimeContext(input: DisableProjectRuntimeContextInput): Promise<ProjectRuntimeContext> {
      const client = await dependencies.getClient()
      let transactionStarted = false
      let releaseError: Error | undefined
      try {
        await client.query('BEGIN')
        transactionStarted = true

        const project = await client.query(
          `SELECT project_id
             FROM druvia_projects
            WHERE project_id = $1
            FOR UPDATE`,
          [input.projectId],
        )
        if (!project.rows[0]) throw new ProjectRuntimeContextNotFoundError()

        const currentResult = await client.query(
          `SELECT service_environment, revision, updated_at
             FROM druvia_project_runtime_contexts
            WHERE project_id = $1
            FOR UPDATE`,
          [input.projectId],
        )
        const currentRow = currentResult.rows[0] as RuntimeContextRow | undefined
        const current: ProjectRuntimeContext = currentRow
          ? normalizeRuntimeContext(currentRow)
          : { enabled: false as const }
        if (!current.enabled) {
          await client.query('COMMIT')
          return current
        }

        await client.query(
          'DELETE FROM druvia_project_runtime_contexts WHERE project_id = $1',
          [input.projectId],
        )
        await dependencies.logActivity(
          input.actorUserId,
          'project.runtime_context_disabled',
          'project',
          input.projectId,
          {
            oldServiceEnvironment: current.serviceEnvironment,
            revision: current.revision,
            ...(input.requestId ? { requestId: input.requestId } : {}),
          },
          client as never,
        )
        await client.query('COMMIT')
        return { enabled: false }
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query('ROLLBACK')
          } catch (rollbackError) {
            releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
          }
        }
        throw releaseError ?? error
      } finally {
        client.release(releaseError)
      }
    },
  }
}

const service = createProjectRuntimeContextService({ queryOne, getClient, logActivity })

export const getProjectRuntimeContext = service.getProjectRuntimeContext
export const getProjectRuntimeContextInTransaction = service.getProjectRuntimeContextInTransaction
export const setProjectRuntimeContext = service.setProjectRuntimeContext
export const disableProjectRuntimeContext = service.disableProjectRuntimeContext
