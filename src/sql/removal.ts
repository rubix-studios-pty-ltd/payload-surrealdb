const name = '"((?:[^"]|"")*)"'
const table = `(?:"public"\\.)?${name}`

export const disableSecurity = new RegExp(`^ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY$`, 'i')
export const disabledSecurity = /\bDISABLE ROW LEVEL SECURITY\b/i
export const dropTable = new RegExp(`^DROP TABLE ${table} CASCADE$`, 'i')
export const dropIndex = new RegExp(`^DROP INDEX ${table}$`, 'i')
export const dropColumn = new RegExp(`^ALTER TABLE ${table} DROP COLUMN ${name}$`, 'i')
export const dropConstraint = new RegExp(`^ALTER TABLE ${table} DROP CONSTRAINT ${name}$`, 'i')
export const dropType = new RegExp(`^DROP TYPE ${table}$`, 'i')

export const removalPatterns = [
  disableSecurity,
  disabledSecurity,
  dropTable,
  dropIndex,
  dropColumn,
  dropConstraint,
  dropType,
]
