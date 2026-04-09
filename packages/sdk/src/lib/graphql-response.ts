import type { DruviaError } from '../types.js'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function getTopLevelMessage(payload: JsonRecord): string | null {
  return nonEmptyString(payload.message)
}

function buildBadResponseError(payload: JsonRecord | null, fallbackMessage: string): DruviaError {
  return {
    code: 'BAD_RESPONSE',
    message: (payload ? getTopLevelMessage(payload) : null) ?? fallbackMessage,
  }
}

function parseGraphqlErrorsArray(payload: JsonRecord): DruviaError | null {
  if (!Array.isArray(payload.errors) || payload.errors.length === 0) {
    return null
  }

  const firstError = isRecord(payload.errors[0]) ? payload.errors[0] : null

  return {
    code: 'GRAPHQL_ERROR',
    message: firstError && nonEmptyString(firstError.message)
      ? firstError.message as string
      : 'GraphQL request failed',
  }
}

function parseTopLevelError(payload: JsonRecord): DruviaError | null {
  if (!('error' in payload) || payload.error == null) {
    return null
  }

  if (isRecord(payload.error)) {
    return {
      code: nonEmptyString(payload.error.code) ?? 'GRAPHQL_ERROR',
      message: nonEmptyString(payload.error.message)
        ?? getTopLevelMessage(payload)
        ?? 'GraphQL request failed',
    }
  }

  const topLevelErrorMessage = nonEmptyString(payload.error)
  if (topLevelErrorMessage) {
    return {
      code: 'BAD_RESPONSE',
      message: getTopLevelMessage(payload) ?? topLevelErrorMessage,
    }
  }

  return buildBadResponseError(payload, 'GraphQL response contained an invalid error payload')
}

export async function readGraphqlResponsePayload(response: Response): Promise<unknown | null> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export type GraphqlResponseParseResult =
  | { data: JsonRecord; error: null }
  | { data: null; error: DruviaError }

export function parseGraphqlResponsePayload(payload: unknown): GraphqlResponseParseResult {
  if (!isRecord(payload)) {
    return {
      data: null,
      error: buildBadResponseError(null, 'GraphQL response was empty or malformed'),
    }
  }

  const graphqlError = parseGraphqlErrorsArray(payload)
  if (graphqlError) {
    return { data: null, error: graphqlError }
  }

  const topLevelError = parseTopLevelError(payload)
  if (topLevelError) {
    return { data: null, error: topLevelError }
  }

  if (!('data' in payload)) {
    return {
      data: null,
      error: buildBadResponseError(payload, 'GraphQL response did not contain a data field'),
    }
  }

  if (!isRecord(payload.data)) {
    return {
      data: null,
      error: buildBadResponseError(payload, 'GraphQL response did not contain usable data'),
    }
  }

  if (Object.keys(payload.data).length === 0) {
    return {
      data: null,
      error: buildBadResponseError(payload, 'GraphQL response data was empty'),
    }
  }

  return {
    data: payload.data,
    error: null,
  }
}
