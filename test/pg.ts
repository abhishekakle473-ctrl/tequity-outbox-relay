import { readFile } from 'node:fs/promises'
import pg from 'pg'

const connection = { host: '127.0.0.1', port: 54329, user: 'postgres', password: 'relay' }
const schema = readFile(new URL('../db/init.sql', import.meta.url), 'utf8')

// Drops and recreates database `name`, so each test file gets rows no other file touches.
export async function freshDb(name: string): Promise<pg.Pool> {
  // The name goes into DROP and CREATE DATABASE, which take no parameters, so only a plain identifier is allowed.
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`freshDb: database name ${JSON.stringify(name)} must match [a-z_][a-z0-9_]*`)
  const admin = new pg.Client({ ...connection, database: 'postgres' })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end()
  }
  const pool = new pg.Pool({ ...connection, database: name })
  await pool.query(await schema)
  return pool
}
