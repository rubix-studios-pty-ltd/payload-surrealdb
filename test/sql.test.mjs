import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inlineAddedKeys, inlineKeys } from '../dist/initial.js'
import { planRemoval } from '../dist/removal.js'
import { split } from '../dist/statements.js'

test('split preserves semicolons inside literals, identifiers, and comments', () => {
  const query = [
    "SELECT 'a;''b'",
    'SELECT "a;b"',
    'SELECT $body$a;b$body$',
    '/* a;b */ SELECT 1',
    '-- a;b\nSELECT 2',
  ]

  assert.deepEqual(split(`${query.join(';\n')};`), query)
  assert.deepEqual(split('; \n ;'), [])
})

test('initial DDL creates parents before children and retains indexes and quoted defaults', () => {
  const source = `
    CREATE TABLE "child" ("parent_id" integer, "text" varchar DEFAULT 'a;b');
    CREATE TABLE "parent" ("id" serial PRIMARY KEY);
    ALTER TABLE "child" ADD CONSTRAINT "child_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id") ON DELETE CASCADE;
    CREATE INDEX "child_parent_idx" ON "child" ("parent_id");
  `

  const [parent, child, index, ...remaining] = split(inlineKeys(source))

  assert.match(parent, /^CREATE TABLE "parent"/)
  assert.match(child, /DEFAULT 'a;b'/)
  assert.match(child, /CONSTRAINT "child_parent_fk" FOREIGN KEY.*ON DELETE CASCADE/)
  assert.match(index, /^CREATE INDEX "child_parent_idx"/)
  assert.deepEqual(remaining, [])
})

test('initial DDL leaves existing-table changes and mixed SQL alone', () => {
  const existing = `
ALTER TABLE "existing" ADD CONSTRAINT "existing_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "parent"("id");
CREATE INDEX "existing_parent_idx" ON "existing" ("parent_id");
`
  assert.equal(inlineKeys(existing), existing)

  const mixed = 'CREATE TABLE "parent" ("id" serial PRIMARY KEY); SELECT 1;'
  assert.equal(inlineKeys(mixed), mixed)
})

test('initial DDL rewrites indexed tables and preserves unrelated statements in order', () => {
  const addColumn = 'ALTER TABLE "existing" ADD COLUMN "title" varchar'
  const otherKey =
    'ALTER TABLE "unindexed" ADD CONSTRAINT "unindexed_fk" FOREIGN KEY ("parent_id") REFERENCES "parent"("id")'
  const index = 'CREATE INDEX "child_idx" ON "public"."child" ("parent_id")'
  const source = `
    CREATE TABLE "child" ("parent_id" integer);
    CREATE TABLE "unindexed" ("parent_id" integer);
    CREATE TABLE "parent" ("id" integer PRIMARY KEY);
    ${addColumn};
    ALTER TABLE "child" ADD CONSTRAINT "child_fk" FOREIGN KEY ("parent_id") REFERENCES "parent"("id");
    ${otherKey};
    ${index};
  `

  const [parent, child, unindexed, ...rest] = split(inlineKeys(source))

  assert.match(parent, /^CREATE TABLE "parent"/)
  assert.match(child, /CONSTRAINT "child_fk"/)
  assert.equal(unindexed, 'CREATE TABLE "unindexed" ("parent_id" integer)')
  assert.deepEqual(rest, [addColumn, otherKey, index])
  assert.equal(
    inlineKeys(source.replace(index, 'CREATE INDEX "parent_idx" ON "parent" ("id")')),
    source.replace(index, 'CREATE INDEX "parent_idx" ON "parent" ("id")')
  )
})

test('initial DDL follows existing inline references and ignores references in literals', () => {
  const source = `
    CREATE TABLE "child" ("middle_id" integer);
    CREATE TABLE "parent" ("id" integer PRIMARY KEY, "note" varchar DEFAULT 'REFERENCES "child"("id")');
    CREATE TABLE "middle" ("id" integer PRIMARY KEY, "parent_id" integer REFERENCES "public"."parent"("id"));
    ALTER TABLE "child" ADD CONSTRAINT "child_fk" FOREIGN KEY ("middle_id") REFERENCES "middle"("id");
    CREATE INDEX "child_idx" ON "child" ("middle_id");
  `

  const [parent, middle, child] = split(inlineKeys(source))

  assert.match(parent, /^CREATE TABLE "parent"/)
  assert.match(middle, /^CREATE TABLE "middle"/)
  assert.match(child, /CONSTRAINT "child_fk"/)
})

test('initial DDL can reorder tables across a column addition to an existing table', () => {
  const change = 'ALTER TABLE "existing" ADD COLUMN "label" varchar -- retain this change'
  const source = `
    CREATE TABLE "child" ("parent_id" integer);
    ${change}
    ;
    CREATE TABLE "parent" ("id" integer PRIMARY KEY);
    ALTER TABLE "child" ADD CONSTRAINT "child_fk" FOREIGN KEY ("parent_id") REFERENCES "parent"("id");
    CREATE INDEX "child_idx" ON "child" ("parent_id");
  `

  const [parent, alter, child, index] = split(inlineKeys(source))

  assert.match(parent, /^CREATE TABLE "parent"/)
  assert.equal(alter, change)
  assert.match(child, /CONSTRAINT "child_fk"/)
  assert.match(index, /^CREATE INDEX "child_idx"/)
})

test('initial DDL reports a cycle when both foreign keys need inlining', () => {
  const source = `
    CREATE TABLE "first" ("id" integer PRIMARY KEY, "second_id" integer);
    CREATE TABLE "second" ("id" integer PRIMARY KEY, "first_id" integer);
    ALTER TABLE "first" ADD CONSTRAINT "first_fk" FOREIGN KEY ("second_id") REFERENCES "second"("id");
    ALTER TABLE "second" ADD CONSTRAINT "second_fk" FOREIGN KEY ("first_id") REFERENCES "first"("id");
    CREATE INDEX "first_idx" ON "first" ("second_id");
    CREATE INDEX "second_idx" ON "second" ("first_id");
  `

  assert.throws(() => inlineKeys(source), /cyclic foreign keys \(first -> second -> first\)/)
  assert.doesNotThrow(() =>
    inlineKeys(source.replace('CREATE INDEX "second_idx" ON "second" ("first_id");', ''))
  )
})

test('new columns declare their foreign keys when they are added', () => {
  const columns = [
    'ALTER TABLE "posts_rels" ADD COLUMN "tags_id" integer',
    'ALTER TABLE "public"."posts_rels" ADD COLUMN "groups_id" uuid',
  ]
  const tags = 'REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action'
  const groups = 'REFERENCES "groups"("id") ON DELETE SET NULL'
  const tagsIndex = 'CREATE INDEX "tags_label_idx" ON "tags" USING btree ("label")'
  const relationIndex = 'CREATE INDEX "posts_rels_tags_id_idx" ON "posts_rels" ("tags_id")'

  assert.deepEqual(
    inlineAddedKeys([
      ...columns,
      tagsIndex,
      `ALTER TABLE "public"."posts_rels" ADD CONSTRAINT "posts_rels_tags_fk" FOREIGN KEY ("tags_id") ${tags}`,
      `ALTER TABLE "posts_rels" ADD CONSTRAINT "posts_rels_groups_fk" FOREIGN KEY ("groups_id") ${groups}`,
      relationIndex,
    ]),
    [`${columns[0]} ${tags}`, `${columns[1]} ${groups}`, tagsIndex, relationIndex]
  )
})

test('foreign keys stay separate across statements that may depend on the new column', () => {
  const column = 'ALTER TABLE "posts_rels" ADD COLUMN "tags_id" integer'
  const foreignKey =
    'ALTER TABLE "posts_rels" ADD CONSTRAINT "posts_rels_tags_fk" FOREIGN KEY ("tags_id") REFERENCES "tags"("id")'

  for (const statement of [
    'INSERT INTO "posts_rels" ("tags_id") VALUES (1)',
    'CREATE INDEX "posts_rels_tags_id_idx" ON "posts_rels" ("tags_id")',
    'CREATE TABLE "tags" ("id" integer PRIMARY KEY)',
  ]) {
    const batch = [column, statement, foreignKey]
    assert.deepEqual(inlineAddedKeys(batch), batch)
  }

  assert.deepEqual(inlineAddedKeys([foreignKey]), [foreignKey])
  const onUpdate = [column, `${foreignKey} ON UPDATE CASCADE`]
  assert.deepEqual(inlineAddedKeys(onUpdate), onUpdate)
})

const drop = `
  ALTER TABLE "tags" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_tags_v" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "tags" CASCADE;
  DROP TABLE "_tags_v" CASCADE;
  ALTER TABLE "posts_rels" DROP CONSTRAINT "posts_rels_tags_fk";
  DROP INDEX "posts_rels_tags_id_idx";
  ALTER TABLE "posts_rels" DROP COLUMN "tags_id";
  DROP TYPE "public"."enum_tags_color";
`

test('removal recognises a generated drop batch and preserves owning table names', () => {
  assert.deepEqual(planRemoval(drop), {
    columns: [{ table: 'posts_rels', name: 'tags_id' }],
    indexes: ['posts_rels_tags_id_idx'],
    tables: ['_tags_v', 'tags'],
    types: ['enum_tags_color'],
  })
})

test('removal declines unrelated RLS changes, custom constraints, and data statements', () => {
  assert.equal(planRemoval(`${drop}ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;`), undefined)
  assert.equal(planRemoval(drop.replace('posts_rels_tags_fk', 'unrelated_constraint')), undefined)
  assert.equal(planRemoval(`${drop}DELETE FROM "posts";`), undefined)
})
