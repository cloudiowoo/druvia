export type ProjectAccountDeletionStatus =
  | 'pending_confirmation'
  | 'expired'
  | 'accepted'
  | 'processing'
  | 'attention_required'
  | 'completed';

export type ProjectAccountDeletionPhase =
  | 'awaiting_confirmation'
  | 'confirmation_in_progress'
  | 'business_cleanup'
  | 'storage_cleanup'
  | 'project_user_cleanup'
  | 'provider_revoke'
  | 'attention_required'
  | 'completed';

export interface ProjectAccountDeletionOperation {
  deletionId: string;
  projectId: string;
  projectSchema: string;
  projectUserId: string;
  provider: 'apple';
  issuer: string;
  identityId: number | null;
  generation: number;
  idempotencyKey: string;
  reauthNonceHash: string | null;
  intentExpiresAt: Date | null;
  confirmationLeaseToken: string | null;
  confirmationLeaseUntil: Date | null;
  cleanupFunction: string;
  cleanupContractHash: string;
  status: ProjectAccountDeletionStatus;
  phase: ProjectAccountDeletionPhase;
  acceptedAt: Date | null;
  dataDeletionDeadlineAt: Date | null;
  providerRevocationStatus: 'not_required' | 'pending' | 'in_flight' | 'succeeded' | 'superseded';
  completedAt: Date | null;
}

export interface ProjectAccountDeletionStatusDto {
  deletionId: string;
  status: ProjectAccountDeletionStatus;
  phase: ProjectAccountDeletionPhase;
  acceptedAt: string | null;
  dataDeletionDeadlineAt: string | null;
  localWipeRequired: boolean;
  providerRevocationPending: boolean;
  completedAt: string | null;
}

export function toProjectAccountDeletionStatusDto(
  operation: ProjectAccountDeletionOperation,
): ProjectAccountDeletionStatusDto {
  return {
    deletionId: operation.deletionId,
    status: operation.status,
    phase: operation.phase,
    acceptedAt: operation.acceptedAt?.toISOString() ?? null,
    dataDeletionDeadlineAt: operation.dataDeletionDeadlineAt?.toISOString() ?? null,
    localWipeRequired: !['pending_confirmation', 'expired'].includes(operation.status),
    providerRevocationPending: ['pending', 'in_flight'].includes(operation.providerRevocationStatus),
    completedAt: operation.completedAt?.toISOString() ?? null,
  };
}
