import { buildQuery, buildMutation, type QueryState, type FilterItem, type WhereItem, type OrFilter, type OrderByItem } from '../lib/graphql-builder.js'
import type { FetchFn, DruviaResponse } from '../types.js'

type PendingOp =
  | { type: 'select' }
  | { type: 'insert'; data: Record<string, unknown> | Record<string, unknown>[] }
  | { type: 'update'; data: Record<string, unknown> }
  | { type: 'upsert'; data: Record<string, unknown> | Record<string, unknown>[]; constraint?: string }
  | { type: 'delete' }

export class QueryBuilder<T = unknown> {
  private table: string
  private schema: string | undefined
  private graphqlUrl: string
  private fetchFn: FetchFn
  private selectStr = '*'
  private filters: WhereItem[] = []
  private orderByItems: OrderByItem[] = []
  private offsetVal: number | undefined
  private limitVal: number | undefined
  private singleFlag = false
  private pendingOp: PendingOp = { type: 'select' }

  constructor(table: string, graphqlUrl: string, fetchFn: FetchFn, schema?: string) {
    this.table = table
    this.graphqlUrl = graphqlUrl
    this.fetchFn = fetchFn
    this.schema = schema
  }

  select(fields: string = '*'): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.selectStr = fields
    this.pendingOp = { type: 'select' }
    return this.makeThenable()
  }

  insert(data: Record<string, unknown> | Record<string, unknown>[]): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.pendingOp = { type: 'insert', data }
    return this.makeThenable()
  }

  update(data: Record<string, unknown>): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.pendingOp = { type: 'update', data }
    return this.makeThenable()
  }

  upsert(data: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.pendingOp = { type: 'upsert', data, constraint: opts?.onConflict }
    return this.makeThenable()
  }

  delete(): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.pendingOp = { type: 'delete' }
    return this.makeThenable()
  }

  // --- Filters ---
  eq(column: string, value: unknown): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.filters.push({ column, op: '_eq', value })
    return this.makeThenable()
  }

  neq(column: string, value: unknown): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.filters.push({ column, op: '_neq', value })
    return this.makeThenable()
  }

  in(column: string, values: unknown[]): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.filters.push({ column, op: '_in', value: values })
    return this.makeThenable()
  }

  gt(column: string, value: unknown): this { this.filters.push({ column, op: '_gt', value }); return this }
  gte(column: string, value: unknown): this { this.filters.push({ column, op: '_gte', value }); return this }
  lt(column: string, value: unknown): this { this.filters.push({ column, op: '_lt', value }); return this }
  lte(column: string, value: unknown): this { this.filters.push({ column, op: '_lte', value }); return this }
  like(column: string, value: string): this { this.filters.push({ column, op: '_like', value }); return this }
  ilike(column: string, value: string): this { this.filters.push({ column, op: '_ilike', value }); return this }
  is(column: string, value: null | boolean): this {
    this.filters.push({ column, op: '_is_null', value: value === null })
    return this
  }

  // --- Ordering & Pagination ---
  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderByItems.push({ column, ascending: opts?.ascending ?? true })
    return this
  }

  range(from: number, to: number): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    this.offsetVal = from
    this.limitVal = to - from + 1
    return this.makeThenable()
  }

  limit(count: number): this { this.limitVal = count; return this }

  single(): PromiseLike<DruviaResponse<T>> {
    this.singleFlag = true
    return { then: (resolve: any, reject: any) => this.execute().then(resolve, reject) } as PromiseLike<DruviaResponse<T>>
  }

  maybeSingle(): PromiseLike<DruviaResponse<T | null>> {
    this.singleFlag = true
    return {
      then: (resolve: any, reject: any) =>
        this.execute().then((result) => {
          if (result.error?.code === 'PGRST116') {
            return { data: null, error: null }
          }
          return result
        }).then(resolve, reject)
    } as PromiseLike<DruviaResponse<T | null>>
  }

  or(filterString: string): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    const conditions: FilterItem[] = filterString.split(',').map(part => {
      const [column, op, ...rest] = part.trim().split('.')
      const value = rest.join('.')
      if (op === 'is' && value === 'null') {
        return { column, op: '_is_null', value: true }
      }
      const hasuraOp = `_${op}`
      let parsed: unknown = value
      if (value === 'true') parsed = true
      else if (value === 'false') parsed = false
      else if (/^\d+(\.\d+)?$/.test(value)) parsed = Number(value)
      return { column, op: hasuraOp, value: parsed }
    })
    this.filters.push({ type: 'or', conditions } as OrFilter)
    return this.makeThenable()
  }

  not(column: string, operator: string, value: unknown): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    const negationMap: Record<string, string> = {
      eq: '_neq',
      neq: '_eq',
      gt: '_lte',
      gte: '_lt',
      lt: '_gte',
      lte: '_gt',
      like: '_nlike',
      ilike: '_nilike',
      is: '_is_null',
    }
    const hasuraOp = negationMap[operator]
    if (!hasuraOp) {
      throw new Error(`@druvia/sdk: Unsupported not() operator: "${operator}"`)
    }
    if (operator === 'is' && value === null) {
      this.filters.push({ column, op: '_is_null', value: false })
    } else {
      this.filters.push({ column, op: hasuraOp, value })
    }
    return this.makeThenable()
  }

  // --- Execution ---
  private makeThenable(): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    const self = this as any
    self.then = (resolve: any, reject: any) => this.execute().then(resolve, reject)
    return self
  }

  private get hasuraTable(): string {
    return this.schema ? `${this.schema}_${this.table}` : this.table
  }

  private async execute(): Promise<DruviaResponse<any>> {
    try {
      const op = this.pendingOp
      const table = this.hasuraTable

      if (op.type === 'select' && (this.selectStr === '*' || this.selectStr.includes('*'))) {
        await this.resolveWildcardFields()
      }

      let query: string
      if (op.type === 'select') {
        const state: QueryState = {
          table,
          selectFields: this.selectStr,
          filters: this.filters,
          orderBy: this.orderByItems,
          offset: this.offsetVal,
          limit: this.limitVal,
          isSingle: this.singleFlag,
        }
        query = buildQuery(state)
      } else if (op.type === 'insert' || op.type === 'upsert') {
        const objects = Array.isArray(op.data) ? op.data : [op.data]
        const onConflict = op.type === 'upsert'
          ? `, on_conflict: {constraint: ${op.constraint ?? this.table + '_pkey'}, update_columns: [${Object.keys(objects[0]).filter(k => k !== 'id').join(', ')}]}`
          : ''
        query = buildMutation(table, 'insert', {
          objects,
          returning: this.selectStr === '*' ? 'id' : this.selectStr,
          onConflict,
        })
      } else if (op.type === 'update') {
        const where = this.buildWhereObject()
        query = buildMutation(table, 'update', {
          set: op.data,
          where,
          returning: this.selectStr === '*' ? 'id' : this.selectStr,
        })
      } else {
        const where = this.buildWhereObject()
        query = buildMutation(table, 'delete', {
          where,
          returning: 'id',
        })
      }

      const response = await this.fetchFn(this.graphqlUrl, {
        method: 'POST',
        body: JSON.stringify({ query }),
      })

      const json = await response.json()

      if (json.errors) {
        return {
          data: null,
          error: { code: 'GRAPHQL_ERROR', message: json.errors[0].message },
        }
      }

      const dataKey = Object.keys(json.data)[0]
      let data = json.data[dataKey]

      if (data?.returning) {
        data = data.returning
      }

      if (this.singleFlag) {
        if (Array.isArray(data) && data.length === 0) {
          return { data: null, error: { code: 'PGRST116', message: 'No rows found' } }
        }
        return { data: Array.isArray(data) ? data[0] : data, error: null }
      }

      return { data, error: null }
    } catch (err) {
      return {
        data: null,
        error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  private buildWhereObject(): Record<string, unknown> {
    const where: Record<string, unknown> = {}
    for (const f of this.filters) {
      if ('type' in f && f.type === 'or') {
        where._or = (f as OrFilter).conditions.map(c => ({ [c.column]: { [c.op]: c.value } }))
      } else {
        const fi = f as FilterItem
        where[fi.column] = { [fi.op]: fi.value }
      }
    }
    return where
  }

  // --- Introspection for select('*') ---
  private static fieldCache = new Map<string, string[]>()

  private get cacheKey(): string {
    return this.schema ? `${this.schema}.${this.table}` : this.table
  }

  /** Resolve * in select string, including nested relations */
  private async resolveWildcardFields(): Promise<void> {
    this.selectStr = await this.resolveSelectStr(this.selectStr, this.hasuraTable)
  }

  /** Recursively resolve * wildcards in a select string for a given Hasura type */
  private async resolveSelectStr(selectStr: string, typeName: string): Promise<string> {
    // Parse into top-level segments (respecting parentheses)
    const segments = this.splitSelectSegments(selectStr)
    const resolved: string[] = []

    for (const seg of segments) {
      const trimmed = seg.trim()

      // Nested relation: "rel(*)" or "alias:rel(*)" or "rel(field1, field2)"
      const nestedMatch = trimmed.match(/^(?:(\w+):)?(\w+)\((.+)\)$/)
      if (nestedMatch) {
        const [, alias, rel, subFields] = nestedMatch
        const relName = alias ? `${alias}: ${rel}` : rel
        // Resolve nested * if present
        if (subFields.includes('*')) {
          // Try introspection for the nested type
          const nestedType = this.schema ? `${this.schema}_${rel}` : rel
          const resolvedSub = await this.resolveSelectStr(subFields, nestedType)
          resolved.push(`${relName} { ${resolvedSub} }`)
        } else {
          resolved.push(`${relName} { ${subFields} }`)
        }
        continue
      }

      // Top-level wildcard
      if (trimmed === '*') {
        const fields = await this.introspectFields(typeName)
        // Only include scalar fields (exclude relationship fields that would need sub-selection)
        resolved.push(fields.join(', '))
        continue
      }

      // Plain field
      resolved.push(trimmed)
    }

    return resolved.join('\n    ')
  }

  /** Split select string into segments, respecting parentheses */
  private splitSelectSegments(str: string): string[] {
    const segments: string[] = []
    let depth = 0
    let current = ''
    for (const ch of str) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) {
        segments.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    if (current.trim()) segments.push(current.trim())
    return segments
  }

  /** Fetch field names for a Hasura type via introspection, with caching */
  private async introspectFields(typeName: string): Promise<string[]> {
    const cached = QueryBuilder.fieldCache.get(typeName)
    if (cached) return cached

    try {
      const response = await this.fetchFn(this.graphqlUrl, {
        method: 'POST',
        body: JSON.stringify({
          query: `query { __type(name: "${typeName}") { fields { name type { kind } } } }`
        }),
      })
      const json = await response.json()
      const rawFields = json.data?.__type?.fields as Array<{ name: string; type: { kind: string } }> | undefined
      if (rawFields && rawFields.length > 0) {
        // Only scalar/enum fields — exclude OBJECT/LIST (relationships need sub-selection)
        const scalars = rawFields
          .filter(f => !f.name.startsWith('__') && f.type.kind !== 'OBJECT' && f.type.kind !== 'LIST')
          .map(f => f.name)
        QueryBuilder.fieldCache.set(typeName, scalars)
        return scalars
      }
      throw new Error(`No fields found`)
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      throw new Error(`@druvia/sdk: Introspection failed for type "${typeName}": ${cause}. Specify fields explicitly.`)
    }
  }

  static clearFieldCache(tableName?: string): void {
    if (tableName) {
      QueryBuilder.fieldCache.delete(tableName)
    } else {
      QueryBuilder.fieldCache.clear()
    }
  }
}