import { type DeleteManyArgs, type FindArgs, type Where, type WhereField } from 'payload'
import { type PostgresAdapter } from '@payloadcms/db-postgres'

const collection = 'payload-locked-documents'
const relationPath = 'document.relationTo'
const valuePath = 'document.value'

export function bindLocks(adapter: PostgresAdapter): void {
  const find = adapter.find.bind(adapter)
  const deleteMany = adapter.deleteMany.bind(adapter)

  adapter.find = <T>(args: FindArgs) => find<T>(lockQuery(args))
  adapter.deleteMany = (args) => deleteMany(lockQuery(args))

  function lockQuery<T extends FindArgs | DeleteManyArgs>(args: T): T {
    if (args.collection !== collection || !args.where) {
      return args
    }

    return { ...args, where: matchDocument(args.where) }
  }

  function matchDocument(where: Where): Where {
    if (!where.and && !where.or) {
      return where
    }

    const query = { ...where }

    if (where.or) {
      query.or = where.or.map(matchDocument)
    }

    if (where.and) {
      query.and = targetDocument(where.and.map(matchDocument))
    }

    return query
  }

  function targetDocument(clauses: Where[]): Where[] {
    const relations = clauses.filter((clause) => Object.hasOwn(clause, relationPath))
    const documents = clauses.filter((clause) => Object.hasOwn(clause, valuePath))

    const [relation] = relations
    const [document] = documents

    if (relations.length !== 1 || documents.length !== 1 || !relation || !document) {
      return clauses
    }

    const relationTo = singleCondition(relation, relationPath)?.equals
    const ids = documentIDs(singleCondition(document, valuePath))

    if (
      !ids.length ||
      typeof relationTo !== 'string' ||
      !Object.hasOwn(adapter.payload.collections, relationTo) ||
      adapter.payload.collections[relationTo]?.config.lockDocuments === false
    ) {
      return clauses
    }

    const matches = [...new Set(ids)].map(
      (value): Where => ({ document: { equals: { relationTo, value } } })
    )
    const [first] = matches

    return [
      ...clauses.filter((clause) => clause !== relation && clause !== document),
      matches.length === 1 && first ? first : { or: matches },
    ]
  }
}

function singleCondition(where: Where, field: string): WhereField | undefined {
  const operators = where[field]

  if (
    Object.keys(where).length === 1 &&
    operators &&
    !Array.isArray(operators) &&
    Object.keys(operators).length === 1
  ) {
    return operators
  }
}

function documentIDs(condition?: WhereField): (number | string)[] {
  if (Array.isArray(condition?.in)) {
    return condition.in.every(isID) ? condition.in : []
  }

  return isID(condition?.equals) ? [condition.equals] : []
}

function isID(value: unknown): value is number | string {
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }

  return typeof value === 'string' && value.length > 0 && value !== 'null'
}
