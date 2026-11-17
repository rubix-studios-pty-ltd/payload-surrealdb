import { type DeleteManyArgs, type FindArgs, type Where } from 'payload'
import { type PostgresAdapter } from '@payloadcms/db-postgres'

export function bindLocks(adapter: PostgresAdapter): void {
  const find = adapter.find.bind(adapter)
  const deleteMany = adapter.deleteMany.bind(adapter)

  adapter.find = <T>(args: FindArgs) => find<T>(lockQuery(args))
  adapter.deleteMany = (args) => deleteMany(lockQuery(args))

  function lockQuery<T extends FindArgs | DeleteManyArgs>(args: T): T {
    if (args.collection !== 'payload-locked-documents' || !args.where) {
      return args
    }

    return { ...args, where: matchDocument(args.where) }
  }

  function matchDocument(where: Where): Where {
    const and = where.and?.map(matchDocument)
    const or = where.or?.map(matchDocument)

    if (!and) {
      return or ? { ...where, or } : where
    }

    const targets = and.filter((clause) => equality(clause, 'document.relationTo') !== undefined)
    const ids = and.filter((clause) => equality(clause, 'document.value') !== undefined)

    const [target] = targets
    const [id] = ids

    if (targets.length === 1 && ids.length === 1 && target && id) {
      const relationTo = equality(target, 'document.relationTo')
      const value = equality(id, 'document.value')

      if (
        typeof relationTo === 'string' &&
        Object.hasOwn(adapter.payload.collections, relationTo) &&
        adapter.payload.collections[relationTo]?.config.lockDocuments !== false &&
        ((typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && value.length > 0 && value !== 'null'))
      ) {
        return {
          ...where,
          ...(or && { or }),
          and: [
            ...and.filter((clause) => clause !== target && clause !== id),
            { document: { equals: { relationTo, value } } },
          ],
        }
      }
    }

    return { ...where, and, ...(or && { or }) }
  }
}

function equality(where: Where, field: string): unknown {
  const operators = where[field]

  if (
    Object.keys(where).length === 1 &&
    operators &&
    !Array.isArray(operators) &&
    Object.keys(operators).length === 1
  ) {
    return operators.equals
  }
}
