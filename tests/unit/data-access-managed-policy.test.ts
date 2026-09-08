import { describe, expect, it } from 'vitest'
import {
  buildColumnCapabilityDrift,
  classifyManagedPolicyState,
  createPermissionSnapshot,
  isRecoverablePermissionSnapshot,
  isPolicyOperationRecoveryRequired,
  materializeReconcileGrants,
  normalizeColumnGrantsForPolicy,
  validateReconcilePolicyTransition,
} from '../../apps/api/src/modules/data-access/data-access-managed-policy.js'
import type {
  DataAccessColumnCapabilities,
  DataAccessColumnGrants,
  MaterializedDataPermission,
} from '../../apps/api/src/modules/data-access/data-access.types.js'

const capabilities: DataAccessColumnCapabilities = {
  readableColumns: ['id', 'owner_id', 'title'],
  insertableColumns: ['id', 'owner_id', 'title'],
  updateableColumns: ['id', 'owner_id', 'title'],
}

const grants: DataAccessColumnGrants = {
  authenticated: {
    select: ['id', 'owner_id', 'title'],
    insert: ['id', 'title'],
    update: [],
  },
  anonymous: { select: [] },
}

const permissions: MaterializedDataPermission[] = [{
  role: 'druvia_v1_s_project_user',
  operation: 'select',
  permission: {
    columns: ['title', 'id', 'owner_id'],
    filter: { owner_id: { _eq: 'X-Hasura-User-Id' } },
    allow_aggregations: false,
  },
}]

describe('managed data access policy state', () => {
  it('requires explicit adoption for supported permissions without provenance', () => {
    expect(classifyManagedPolicyState({
      inspectedState: 'managed',
      hasScopedPermissions: true,
      containsWildcard: false,
      currentPermissions: createPermissionSnapshot(permissions),
      currentCapabilities: capabilities,
      baseline: null,
      recoveryRequired: false,
    })).toBe('adoption_required')
  })

  it('keeps empty unconfigured tables manageable without adoption', () => {
    expect(classifyManagedPolicyState({
      inspectedState: 'managed',
      hasScopedPermissions: false,
      containsWildcard: false,
      currentPermissions: [],
      currentCapabilities: capabilities,
      baseline: null,
      recoveryRequired: false,
    })).toBe('managed')
  })

  it('rejects wildcard and structural custom permissions', () => {
    for (const input of [
      { inspectedState: 'managed' as const, containsWildcard: true },
      { inspectedState: 'custom' as const, containsWildcard: false },
    ]) {
      expect(classifyManagedPolicyState({
        ...input,
        hasScopedPermissions: true,
        currentPermissions: [],
        currentCapabilities: capabilities,
        baseline: null,
        recoveryRequired: false,
      })).toBe('custom')
    }
  })

  it('distinguishes capability drift from metadata drift', () => {
    const snapshot = createPermissionSnapshot(permissions)
    const baseline = {
      permissionsSnapshot: snapshot,
      capabilitiesSnapshot: capabilities,
    }
    expect(classifyManagedPolicyState({
      inspectedState: 'managed',
      hasScopedPermissions: true,
      containsWildcard: false,
      currentPermissions: snapshot,
      currentCapabilities: capabilities,
      baseline,
      recoveryRequired: false,
    })).toBe('managed')
    expect(classifyManagedPolicyState({
      inspectedState: 'managed',
      hasScopedPermissions: true,
      containsWildcard: false,
      currentPermissions: snapshot,
      currentCapabilities: {
        ...capabilities,
        readableColumns: [...capabilities.readableColumns, 'analysis_version'],
      },
      baseline,
      recoveryRequired: false,
    })).toBe('refresh_required')
    expect(classifyManagedPolicyState({
      inspectedState: 'managed',
      hasScopedPermissions: true,
      containsWildcard: false,
      currentPermissions: [],
      currentCapabilities: capabilities,
      baseline,
      recoveryRequired: false,
    })).toBe('custom')
  })

  it('gives recovery state precedence over metadata inspection', () => {
    expect(classifyManagedPolicyState({
      inspectedState: 'custom',
      hasScopedPermissions: true,
      containsWildcard: true,
      currentPermissions: [],
      currentCapabilities: capabilities,
      baseline: null,
      recoveryRequired: true,
    })).toBe('recovery_required')
  })

  it('makes stalled applying and recovering operations recoverable after the drain window', () => {
    const now = new Date('2026-09-07T00:00:10.000Z')
    expect(isPolicyOperationRecoveryRequired({
      status: 'applying',
      writeDeadlineAt: new Date('2026-09-07T00:00:04.999Z'),
    }, now)).toBe(true)
    expect(isPolicyOperationRecoveryRequired({
      status: 'recovering',
      writeDeadlineAt: new Date('2026-09-07T00:00:05.001Z'),
    }, now)).toBe(false)
    expect(isPolicyOperationRecoveryRequired({
      status: 'recovery_required',
      writeDeadlineAt: null,
    }, now)).toBe(true)
    expect(isPolicyOperationRecoveryRequired({
      status: 'preview_ready',
      writeDeadlineAt: new Date('2026-09-06T00:00:00.000Z'),
    }, now)).toBe(false)
    expect(isPolicyOperationRecoveryRequired({
      status: 'applying',
      writeDeadlineAt: null,
      startedAt: new Date('2026-09-06T23:59:00.000Z'),
      updatedAt: new Date('2026-09-06T23:59:00.000Z'),
    }, now)).toBe(true)
  })

  it('removes owner preset columns from persisted write grants', () => {
    const ownerPolicy = {
      authenticated: {
        select: 'owner', insert: 'owner', update: 'owner', delete: 'none',
        ownerColumn: 'owner_id',
      },
      anonymous: { select: false },
    } as const
    const normalized = normalizeColumnGrantsForPolicy(ownerPolicy, {
      authenticated: {
        select: ['id', 'owner_id'],
        insert: ['id', 'owner_id'],
        update: ['id', 'owner_id'],
      },
      anonymous: { select: [] },
    })
    expect(normalized).toEqual({
      authenticated: {
        select: ['id', 'owner_id'],
        insert: ['id'],
        update: ['id'],
      },
      anonymous: { select: [] },
    })
    expect(normalizeColumnGrantsForPolicy({
      ...ownerPolicy,
      authenticated: { ...ownerPolicy.authenticated, insert: 'all', update: 'all' },
    }, normalized).authenticated).toMatchObject({
      insert: ['id'],
      update: ['id'],
    })
  })

  it('does not allow reconciliation to broaden row access modes', () => {
    const baseline = {
      authenticated: {
        select: 'owner' as const, insert: 'owner' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: 'owner_id',
      },
      anonymous: { select: false },
    }
    expect(() => validateReconcilePolicyTransition(baseline, {
      authenticated: { ...baseline.authenticated, select: 'all' },
      anonymous: { select: false },
    })).toThrow(/broaden/i)
    expect(() => validateReconcilePolicyTransition(baseline, {
      authenticated: {
        select: 'none', insert: 'none', update: 'none', delete: 'none', ownerColumn: null,
      },
      anonymous: { select: false },
    })).not.toThrow()
    expect(() => validateReconcilePolicyTransition(baseline, {
      authenticated: { ...baseline.authenticated, ownerColumn: 'alternate_owner_id' },
      anonymous: { select: false },
    })).toThrow(/owner column/i)
  })

  it('keeps new columns ungranted and removes unavailable write columns', () => {
    const current = {
      readableColumns: ['id', 'owner_id', 'title', 'analysis_version'],
      insertableColumns: ['id', 'owner_id', 'analysis_version'],
      updateableColumns: ['id', 'owner_id', 'analysis_version'],
    }
    expect(buildColumnCapabilityDrift(capabilities, current)).toEqual({
      addedReadable: ['analysis_version'],
      addedInsertable: ['analysis_version'],
      addedUpdateable: ['analysis_version'],
      removedOrRestricted: ['title'],
    })
    expect(materializeReconcileGrants(grants, current)).toEqual({
      authenticated: {
        select: ['id', 'owner_id', 'title'],
        insert: ['id'],
        update: [],
      },
      anonymous: { select: [] },
    })
  })

  it('canonicalizes explicit columns without equating wildcard to an array', () => {
    const snapshot = createPermissionSnapshot(permissions)
    expect(snapshot[0].permission.columns).toEqual(['id', 'owner_id', 'title'])
    expect(() => createPermissionSnapshot([{
      ...permissions[0],
      permission: { ...permissions[0].permission, columns: '*' },
    }])).toThrow(/wildcard/i)
  })

  it('recovers only source, target, or exact drop-then-create prefix states', () => {
    const source = createPermissionSnapshot(permissions)
    const target = createPermissionSnapshot([
      {
        role: 'druvia_v1_s_project_user',
        operation: 'insert',
        permission: {
          columns: ['id', 'title'],
          check: { owner_id: { _eq: 'X-Hasura-User-Id' } },
          set: { owner_id: 'X-Hasura-User-Id' },
        },
      },
      {
        ...permissions[0],
        permission: { ...permissions[0].permission, columns: ['id', 'title'] },
      },
    ])
    const partial = [target.find((item) => item.operation === 'insert')!]

    expect(isRecoverablePermissionSnapshot(source, source, target)).toBe(true)
    expect(isRecoverablePermissionSnapshot(target, source, target)).toBe(true)
    expect(isRecoverablePermissionSnapshot([], source, target)).toBe(true)
    expect(isRecoverablePermissionSnapshot(partial, source, target)).toBe(true)
    expect(isRecoverablePermissionSnapshot([{
      ...source[0],
      permission: { ...source[0].permission, columns: ['id'] },
    }], source, target)).toBe(false)
    expect(isRecoverablePermissionSnapshot([{
      ...target[0],
      permission: { ...target[0].permission, set: { owner_id: 'external-value' } },
    }], source, target)).toBe(false)
  })
})
