import type { TableMetadata } from '../table/table.service.js'
import type { DataAccessInventoryTable } from './data-access-inventory.js'
import type { DataAccessColumnCapabilities } from './data-access.types.js'

type TableColumn = TableMetadata['columns'][number]

export function buildTableColumnCapabilities(
  columns: TableColumn[]
): DataAccessColumnCapabilities {
  const readableColumns = columns.map((column) => column.name)
  const writableColumns = columns
    .filter((column) => (
      !column.isGenerated && column.identityGeneration !== 'ALWAYS'
    ))
    .map((column) => column.name)

  return {
    readableColumns,
    insertableColumns: writableColumns,
    updateableColumns: [...writableColumns],
  }
}

export function getInventoryColumnCapabilities(
  inventory: DataAccessInventoryTable
): DataAccessColumnCapabilities {
  return {
    readableColumns: inventory.columns,
    insertableColumns: inventory.insertableColumns,
    updateableColumns: inventory.updateableColumns,
  }
}

export function getStoredColumnCapabilities(input: {
  columns: string[]
  insertableColumns?: string[]
  updateableColumns?: string[]
}): DataAccessColumnCapabilities {
  return {
    readableColumns: input.columns,
    insertableColumns: input.insertableColumns ?? input.columns,
    updateableColumns: input.updateableColumns ?? input.columns,
  }
}
