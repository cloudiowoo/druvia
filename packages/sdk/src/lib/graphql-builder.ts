export interface FilterItem {
  column: string
  op: string
  value: unknown
}

export interface OrderByItem {
  column: string
  ascending: boolean
}

export interface QueryState {
  table: string
  selectFields: string
  filters: FilterItem[]
  orderBy: OrderByItem[]
  offset: number | undefined
  limit: number | undefined
  isSingle: boolean
}

/** Parse select string into GraphQL field list */
function parseSelectFields(fields: string): string {
  return fields
    .split(',')
    .map(f => f.trim())
    .map(f => {
      const nestedMatch = f.match(/^(\w+)\((.+)\)$/)
      if (nestedMatch) {
        const [, rel, subFields] = nestedMatch
        return `${rel} { ${parseSelectFields(subFields)} }`
      }
      return f
    })
    .join('\n    ')
}

export function escapeGraphQLString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

function serializeValue(value: unknown): string {
  if (typeof value === 'string') return `"${escapeGraphQLString(value)}"`
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(', ')}]`
  if (value === null) return 'null'
  if (typeof value === 'boolean') return String(value)
  return String(value)
}

function buildWhereClause(filters: FilterItem[]): string {
  if (filters.length === 0) return ''
  const conditions = filters.map(f => {
    if (f.op === '_is_null') {
      return `${f.column}: {_is_null: ${f.value ? 'true' : 'false'}}`
    }
    return `${f.column}: {${f.op}: ${serializeValue(f.value)}}`
  })
  return `where: {${conditions.join(', ')}}`
}

function buildOrderByClause(orderBy: OrderByItem[]): string {
  if (orderBy.length === 0) return ''
  const items = orderBy.map(o => `${o.column}: ${o.ascending ? 'asc' : 'desc'}`)
  return `order_by: {${items.join(', ')}}`
}

export function buildQuery(state: QueryState): string {
  const args: string[] = []

  const where = buildWhereClause(state.filters)
  if (where) args.push(where)

  const orderBy = buildOrderByClause(state.orderBy)
  if (orderBy) args.push(orderBy)

  if (state.offset !== undefined) args.push(`offset: ${state.offset}`)

  const limit = state.isSingle ? 1 : state.limit
  if (limit !== undefined) args.push(`limit: ${limit}`)

  const argsStr = args.length > 0 ? `(${args.join(', ')})` : ''
  const fields = parseSelectFields(state.selectFields)

  return `query {
  ${state.table}${argsStr} {
    ${fields}
  }
}`
}

export interface MutationInsertOpts {
  objects: Record<string, unknown>[]
  returning: string
  onConflict?: string
}

export interface MutationUpdateOpts {
  set: Record<string, unknown>
  where: Record<string, unknown>
  returning: string
}

export interface MutationDeleteOpts {
  where: Record<string, unknown>
  returning: string
}

function serializeObject(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).map(([k, v]) => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return `${k}: {${Object.entries(v as Record<string, unknown>).map(([k2, v2]) => `${k2}: ${serializeValue(v2)}`).join(', ')}}`
    }
    return `${k}: ${serializeValue(v)}`
  })
  return `{${entries.join(', ')}}`
}

export function buildMutation(
  table: string,
  type: 'insert' | 'update' | 'delete',
  opts: MutationInsertOpts | MutationUpdateOpts | MutationDeleteOpts,
): string {
  const returning = 'returning' in opts ? parseSelectFields(opts.returning) : 'affected_rows'

  if (type === 'insert') {
    const { objects, onConflict } = opts as MutationInsertOpts
    const objectsStr = objects.map(serializeObject).join(', ')
    const conflictStr = onConflict ?? ''
    return `mutation {
  insert_${table}(objects: [${objectsStr}]${conflictStr}) {
    ${returning}
  }
}`
  }

  if (type === 'update') {
    const { set, where } = opts as MutationUpdateOpts
    const setStr = Object.entries(set).map(([k, v]) => `${k}: ${serializeValue(v)}`).join(', ')
    const whereStr = serializeObject(where)
    return `mutation {
  update_${table}(where: ${whereStr}, _set: {${setStr}}) {
    ${returning}
  }
}`
  }

  // delete
  const { where } = opts as MutationDeleteOpts
  const whereStr = serializeObject(where)
  return `mutation {
  delete_${table}(where: ${whereStr}) {
    ${returning}
  }
}`
}
