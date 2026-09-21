export const SERVICE_ENVIRONMENTS = [
  'local',
  'sandbox',
  'testflight',
  'production',
] as const

export type ServiceEnvironment = (typeof SERVICE_ENVIRONMENTS)[number]

export type ProjectRuntimeContext =
  | { enabled: false }
  | {
      enabled: true
      serviceEnvironment: ServiceEnvironment
      revision: number
      updatedAt: string
    }
