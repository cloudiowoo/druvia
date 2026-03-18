import { buildQuery, buildMutation, type QueryState, type FilterItem, type OrderByItem } from '../lib/graphql-builder.js'
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
  private filters: FilterItem[] = []
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

  // --- Execution ---
  private makeThenable(): PromiseLike<DruviaResponse<T[]>> & QueryBuilder<T> {
    const self = this as any
    self.then = (resolve: any, reject: any) => this.execute().then(resolve, reject)
    return self
  }

  private async execute(): Promise<DruviaResponse<any>> {
    try {
      const op = this.pendingOp

      if (op.type === 'select' && (this.selectStr === '*' || this.selectStr.includes('*'))) {
        await this.resolveWildcardFields()
      }

      let query: string
      if (op.type === 'select') {
        const state: QueryState = {
          table: this.table,
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
        query = buildMutation(this.table, 'insert', {
          objects,
          returning: this.selectStr === '*' ? 'id' : this.selectStr,
          onConflict,
        })
      } else if (op.type === 'update') {
        const where = this.buildWhereObject()
        query = buildMutation(this.table, 'update', {
          set: op.data,
          where,
          returning: this.selectStr === '*' ? 'id' : this.selectStr,
        })
      } else {
        const where = this.buildWhereObject()
        query = buildMutation(this.table, 'delete', {
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
      where[f.column] = { [f.op]: f.value }
    }
    return where
  }

  // --- Introspection for select('*') ---
  private static fieldCache = new Map<string, string[]>()

  private get cacheKey(): string {
    return this.schema ? `${this.schema}.${this.table}` : this.table
  }

  private async resolveWildcardFields(): Promise<void> {
    const cached = QueryBuilder.fieldCache.get(this.cacheKey)
    if (cached) {
      this.selectStr = this.selectStr.replace('*', cached.join(', '))
      return
    }

    const typeName = this.schema ? `${this.schema}_${this.table}` : this.table
    try {
      const response = await this.fetchFn(this.graphqlUrl, {
        method: 'POST',
        body: JSON.stringify({
          query: `query { __type(name: "${typeName}") { fields { name } } }`
        }),
      })
      const json = await response.json()
      const fields = json.data?.__type?.fields?.map((f: { name: string }) => f.name)
      if (fields && fields.length > 0) {
        const filtered = fields.filter((f: string) => !f.startsWith('__'))
        QueryBuilder.fieldCache.set(this.cacheKey, filtered)
        this.selectStr = this.selectStr.replace('*', filtered.join(', '))
      } else {
        throw new Error(`Cannot resolve fields for table "${this.table}".`)
      }
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      throw new Error(`@druvia/sdk: Introspection failed for table "${this.table}": ${cause}. Specify fields explicitly: .select('id, name, ...')`)
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