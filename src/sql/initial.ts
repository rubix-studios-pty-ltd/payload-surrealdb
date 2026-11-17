const identifier = '(?:"(?:[^"]|"")*"|[a-z_][\\w$]*)'
const tableName = `(?:(?:"public"|public)\\s*\\.\\s*)?(${identifier})`

export const createTable = new RegExp(`^CREATE\\s+TABLE\\s+${tableName}\\s*\\([\\s\\S]*\\)$`, 'i')

export const addForeignKey = new RegExp(
  `^ALTER\\s+TABLE\\s+${tableName}\\s+ADD\\s+(CONSTRAINT\\s+${identifier}\\s+FOREIGN\\s+KEY\\b[\\s\\S]*)$`,
  'i'
)

export const createIndex = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}\\s+ON\\s+${tableName}\\s*(?:\\(|USING\\b)`,
  'i'
)

export const addColumn = new RegExp(`^ALTER\\s+TABLE\\s+${tableName}\\s+ADD\\s+COLUMN\\b`, 'i')

export const addedColumnName = new RegExp(
  `${addColumn.source}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})`,
  'i'
)

export const foreignKeyColumns = new RegExp(
  `^CONSTRAINT\\s+${identifier}\\s+FOREIGN\\s+KEY\\s*\\(\\s*(${identifier}(?:\\s*,\\s*${identifier})*)\\s*\\)`,
  'i'
)

export const columnIdentifiers = new RegExp(identifier, 'gi')

export const addKeyColumn = new RegExp(
  `${addColumn.source}\\s+(${identifier})\\s+(?:smallint|integer|bigint|uuid|text|varchar)$`,
  'i'
)

export const keyColumn = new RegExp(
  `^CONSTRAINT\\s+${identifier}\\s+FOREIGN\\s+KEY\\s*\\(\\s*(${identifier})\\s*\\)\\s+` +
    `(REFERENCES\\s+${tableName}\\s*\\(\\s*(?:"id"|id)\\s*\\)` +
    `(?:\\s+ON\\s+(?:DELETE\\s+(?:CASCADE|NO\\s+ACTION|RESTRICT|SET\\s+NULL)|UPDATE\\s+NO\\s+ACTION))*)$`,
  'i'
)

export const reference = new RegExp(`^\\s+${tableName}\\s*\\(`, 'i')
