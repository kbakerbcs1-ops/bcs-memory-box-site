// Postgres connection + helpers + migration runner.
// Uses pg connection pool. Reads DATABASE_URL from env.

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('[db] DATABASE_URL not set — portal endpoints will fail until it is. Trial endpoint will still work.');
}

// Detect whether the URL points to an external Postgres host (has a TLD
// after the @) vs. Render's internal hostname like dpg-xxx-a (no TLD).
// External connections require SSL; internal Render connections do NOT use SSL.
function needsSsl(url) {
  const hostPart = (url.split('@')[1] || '').split('/')[0];
  return hostPart.includes('.');
}

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : false,
      max: 10,
    })
  : null;

// Query helper — returns { rows, rowCount }. Throws on error.
async function query(text, params) {
  if (!pool) throw new Error('Database not configured (DATABASE_URL missing).');
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const ms = Date.now() - start;
    if (ms > 1000) console.warn('[db] slow query (' + ms + 'ms): ' + text.slice(0, 100));
    return result;
  } catch (err) {
    console.error('[db] query error:', err.message, 'sql:', text.slice(0, 200));
    throw err;
  }
}

// Single-row convenience
async function queryOne(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

// Run all .sql files in migrations/ in alphabetical order. Idempotent — each
// migration uses IF NOT EXISTS, and we track which have run in a meta table.
async function runMigrations() {
  if (!pool) {
    console.warn('[db] skipping migrations (no DATABASE_URL)');
    return;
  }

  // Create the tracking table if it doesn't exist
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file]
    );
    if (rows.length > 0) {
      console.log('[db] migration already applied: ' + file);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log('[db] applying migration: ' + file);
    await pool.query(sql);
    await query(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [file]
    );
    console.log('[db] migration applied: ' + file);
  }
}

// Generate a cryptographically random URL-safe token (for access_token,
// admin session tokens, etc). Uses Node's crypto module.
function randomToken(bytes = 24) {
  return require('crypto').randomBytes(bytes).toString('base64url');
}

module.exports = {
  pool,
  query,
  queryOne,
  runMigrations,
  randomToken,
  enabled: pool !== null,
};
