export class ProjectDeviceWipeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ProjectDeviceWipeError';
  }
}

export function deviceWipeErrorChainHasCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if ((current as { code?: string }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface DeviceWipeHookNames {
  registerFunction: string;
  queryFunction: string;
  acknowledgeFunction: string;
}

export interface DeviceWipeHookContracts extends DeviceWipeHookNames {
  schemaName: string;
  registerContractHash: string;
  queryContractHash: string;
  acknowledgeContractHash: string;
}

export interface DeviceWipeMandateSource {
  deletionId: string;
  scope: 'account' | 'session';
  sessionId: string | null;
}
