import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const databasePath = process.env.DATABASE_PATH ?? './data/paypilot.db'
fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true })

const require = createRequire(import.meta.url)
const sqlJsEntry = require.resolve('sql.js')
const SQL = await initSqlJs({ locateFile: file => path.join(path.dirname(sqlJsEntry), file) })
const database = fs.existsSync(databasePath)
  ? new SQL.Database(new Uint8Array(fs.readFileSync(databasePath)))
  : new SQL.Database()
database.run('PRAGMA foreign_keys = ON')
let inTransaction = false

function persist() {
  const image = database.export()
  const temporaryPath = `${databasePath}.tmp`
  fs.writeFileSync(temporaryPath, Buffer.from(image))
  fs.renameSync(temporaryPath, databasePath)
}

export const db = {
  exec(sql: string) {
    database.run(sql)
    if (!inTransaction) persist()
  },
  pragma(sql: string) {
    database.run(`PRAGMA ${sql}`)
  },
  prepare(sql: string) {
    return {
      all(...params: unknown[]) {
        const statement = database.prepare(sql)
        try {
          statement.bind(params as Parameters<typeof statement.bind>[0])
          const rows: Array<Record<string, unknown>> = []
          while (statement.step()) rows.push(statement.getAsObject())
          return rows
        } finally {
          statement.free()
        }
      },
      get(...params: unknown[]) {
        const statement = database.prepare(sql)
        try {
          statement.bind(params as Parameters<typeof statement.bind>[0])
          return statement.step() ? statement.getAsObject() : undefined
        } finally {
          statement.free()
        }
      },
      run(...params: unknown[]) {
        database.run(sql, params as Parameters<SqlJsDatabase['run']>[1])
        const result = database.exec('SELECT last_insert_rowid() AS lastInsertRowid, changes() AS changes')[0]?.values[0]
        if (!inTransaction) persist()
        return { lastInsertRowid: Number(result?.[0] ?? 0), changes: Number(result?.[1] ?? 0) }
      },
    }
  },
  transaction<T>(callback: () => T) {
    return () => {
      database.run('BEGIN')
      inTransaction = true
      try {
        const result = callback()
        database.run('COMMIT')
        inTransaction = false
        persist()
        return result
      } catch (error) {
        database.run('ROLLBACK')
        inTransaction = false
        throw error
      }
    }
  },
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    amount REAL NOT NULL CHECK(amount > 0),
    occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL DEFAULT 'manual'
  );
  CREATE INDEX IF NOT EXISTS transactions_user_date ON transactions(user_id, occurred_at);
  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    month TEXT NOT NULL,
    UNIQUE(user_id, category, month)
  );
  CREATE TABLE IF NOT EXISTS savings_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target REAL NOT NULL CHECK(target > 0),
    saved REAL NOT NULL DEFAULT 0 CHECK(saved >= 0),
    target_date TEXT
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL CHECK(status IN ('prepared', 'created', 'completed', 'failed')),
    paypal_order_id TEXT UNIQUE,
    paypal_capture_id TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)
persist()
