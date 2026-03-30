import { describe, it, expect } from 'vitest'
import { buildQuery, buildMutation, type QueryState } from '../../packages/sdk/src/lib/graphql-builder.js'

describe('buildQuery', () => {
  it('builds simple select with explicit fields', () => {
    const gql = buildQuery({
      table: 'users', selectFields: 'id, name, email',
      filters: [], orderBy: [], offset: undefined, limit: undefined, isSingle: false,
    })
    expect(gql).toContain('query')
    expect(gql).toContain('users')
    expect(gql).toContain('id')
    expect(gql).toContain('name')
    expect(gql).toContain('email')
  })

  it('builds select with eq filter', () => {
    const gql = buildQuery({
      table: 'users', selectFields: 'id, name',
      filters: [{ column: 'id', op: '_eq', value: 1 }],
      orderBy: [], offset: undefined, limit: undefined, isSingle: false,
    })
    expect(gql).toContain('where')
    expect(gql).toContain('_eq')
  })

  it('builds select with multiple filters, order, offset, limit', () => {
    const gql = buildQuery({
      table: 'activities', selectFields: 'id, status',
      filters: [
        { column: 'status', op: '_eq', value: 'active' },
        { column: 'team_id', op: '_in', value: [1, 2, 3] },
      ],
      orderBy: [{ column: 'created_at', ascending: false }],
      offset: 0, limit: 20, isSingle: false,
    })
    expect(gql).toContain('_eq')
    expect(gql).toContain('_in')
    expect(gql).toContain('order_by')
    expect(gql).toContain('desc')
    expect(gql).toContain('offset: 0')
    expect(gql).toContain('limit: 20')
  })

  it('builds select with nested relation', () => {
    const gql = buildQuery({
      table: 'activities', selectFields: '*, user_activities(*)',
      filters: [], orderBy: [], offset: undefined, limit: undefined, isSingle: false,
    })
    expect(gql).toContain('user_activities')
  })

  it('applies limit 1 for single()', () => {
    const gql = buildQuery({
      table: 'users', selectFields: 'id, name',
      filters: [{ column: 'id', op: '_eq', value: 1 }],
      orderBy: [], offset: undefined, limit: undefined, isSingle: true,
    })
    expect(gql).toContain('limit: 1')
  })
})

describe('buildMutation', () => {
  it('builds insert mutation', () => {
    const gql = buildMutation('users', 'insert', {
      objects: [{ username: 'test', user_id: 'u1' }],
      returning: 'id, username',
    })
    expect(gql).toContain('mutation')
    expect(gql).toContain('insert_users')
    expect(gql).toContain('returning')
    expect(gql).toContain('username')
  })

  it('builds update mutation with where', () => {
    const gql = buildMutation('users', 'update', {
      set: { username: 'new_name' },
      where: { id: { _eq: 1 } },
      returning: 'id, username',
    })
    expect(gql).toContain('update_users')
    expect(gql).toContain('_set')
    expect(gql).toContain('where')
    expect(gql).toContain('returning')
  })

  it('builds delete mutation with where', () => {
    const gql = buildMutation('users', 'delete', {
      where: { id: { _eq: 1 } },
      returning: 'id',
    })
    expect(gql).toContain('delete_users')
    expect(gql).toContain('where')
    expect(gql).toContain('returning')
  })

  it('falls back to affected_rows when no returning selection is provided', () => {
    const gql = buildMutation('users', 'delete', {
      where: { id: { _eq: 1 } },
    })

    expect(gql).toContain('delete_users')
    expect(gql).toContain('affected_rows')
    expect(gql).not.toContain('returning {')
  })

  it('serializes nested JSON objects in insert payloads', () => {
    const gql = buildMutation('stats_match_result', 'insert', {
      objects: [{
        match_id: 'm1',
        meta: {
          activity_title: '第 12 轮',
          snapshot: {
            teams: [
              { team_id: 't1', team_name: 'A 队' },
              { team_id: 't2', team_name: 'B 队' },
            ],
          },
          snapshot_hash: 'abc',
        },
      }],
    })

    expect(gql).toContain('insert_stats_match_result')
    expect(gql).toContain('meta: {')
    expect(gql).toContain('snapshot: {')
    expect(gql).toContain('teams: [{team_id: "t1", team_name: "A 队"}, {team_id: "t2", team_name: "B 队"}]')
    expect(gql).not.toContain('[object Object]')
  })

  it('serializes nested JSON objects in update payloads', () => {
    const gql = buildMutation('stats_match_result', 'update', {
      set: {
        meta: {
          snapshot: {
            teams: [{ team_id: 't1', team_name: 'A 队' }],
          },
          snapshot_hash: 'abc',
        },
      },
      where: { match_id: { _eq: 'm1' } },
      returning: 'match_id',
    })

    expect(gql).toContain('update_stats_match_result')
    expect(gql).toContain('_set: {meta: {snapshot: {teams: [{team_id: "t1", team_name: "A 队"}]}, snapshot_hash: "abc"}}')
    expect(gql).not.toContain('[object Object]')
  })
})
