import { hasuraMetadataRequest } from '../realtime/realtime.service.js'

export interface HasuraMetadataCommand {
  type: string
  args: Record<string, unknown>
}

export async function applyHasuraMetadataCommands(
  commands: HasuraMetadataCommand[]
): Promise<void> {
  if (commands.length === 0) return
  try {
    await hasuraMetadataRequest('bulk_atomic', commands as never)
  } catch (error) {
    if (!isUnsupportedAtomicCommand(error)) throw error
    await hasuraMetadataRequest('bulk', commands as never)
  }
}

function isUnsupportedAtomicCommand(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('Bulk atomic does not support this command')
}
