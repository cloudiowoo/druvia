interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

const TYPE_MAPPING: Record<string, { type: string; format?: string }> = {
  uuid: { type: 'string', format: 'uuid' },
  text: { type: 'string' },
  varchar: { type: 'string' },
  'character varying': { type: 'string' },
  char: { type: 'string' },
  integer: { type: 'integer' },
  int4: { type: 'integer' },
  bigint: { type: 'integer', format: 'int64' },
  int8: { type: 'integer', format: 'int64' },
  numeric: { type: 'number' },
  decimal: { type: 'number' },
  real: { type: 'number' },
  'double precision': { type: 'number' },
  boolean: { type: 'boolean' },
  bool: { type: 'boolean' },
  'timestamp without time zone': { type: 'string', format: 'date-time' },
  'timestamp with time zone': { type: 'string', format: 'date-time' },
  timestamp: { type: 'string', format: 'date-time' },
  timestamptz: { type: 'string', format: 'date-time' },
  date: { type: 'string', format: 'date' },
  time: { type: 'string', format: 'time' },
  jsonb: { type: 'object' },
  json: { type: 'object' },
};

export function pgTypeToOpenApi(pgType: string): { type: string; format?: string } {
  const normalized = pgType.toLowerCase();
  return TYPE_MAPPING[normalized] || { type: 'string' };
}

export function generateOpenApiSchema(columns: ColumnInfo[]) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const col of columns) {
    const schema = pgTypeToOpenApi(col.data_type);
    properties[col.column_name] = schema;
    if (col.is_nullable === 'NO') {
      required.push(col.column_name);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}
