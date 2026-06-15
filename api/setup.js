// /api/setup.js — One-time setup: creates app_settings table in Supabase
// Hit GET /api/setup once after deploy to initialize the database table.

const SB_URL = process.env.SUPABASE_URL || 'https://ytzpfhjcaesgylodaasw.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  if (!SB_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set' });

  const results = {};

  // Try to read app_settings — if it works, table exists
  const check = await fetch(
    `${SB_URL}/rest/v1/app_settings?limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' } }
  );

  if (check.ok) {
    const rows = await check.json();
    results.app_settings = `exists (${rows.length} rows)`;
    return res.status(200).json({ ok: true, results, message: 'Setup already complete' });
  }

  // Table doesn't exist — need to create via Supabase Management API
  // The REST API can't run DDL, but we can use the pg RPC if available
  results.check_status = check.status;
  results.check_body = await check.text().catch(() => 'unreadable');
  
  // Try Supabase's SQL endpoint (available in some plans)
  const sql = `
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "service_full_access" ON app_settings;
    CREATE POLICY "service_full_access" ON app_settings FOR ALL USING (true) WITH CHECK (true);
  `;

  const sqlRes = await fetch(`${SB_URL}/rest/v1/rpc/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ query: sql })
  });

  results.sql_status = sqlRes.status;
  results.sql_body = await sqlRes.text().catch(() => 'unreadable');

  return res.status(200).json({
    ok: sqlRes.ok,
    results,
    message: sqlRes.ok
      ? 'app_settings table created'
      : 'Could not auto-create table — please run the SQL manually in Supabase SQL Editor:\n\n' + sql
  });
};
