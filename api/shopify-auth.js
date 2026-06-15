// /api/shopify-auth.js — Shopify OAuth + Supabase table setup (CommonJS)

const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOP          = process.env.SHOPIFY_STORE || 'a-sweet-morsel-co.myshopify.com';
const APP_URL       = process.env.APP_URL || 'https://ops.asweetmorselco.com';
const REDIRECT_URI  = `${APP_URL}/api/shopify-auth`;
const SCOPES        = 'read_orders,write_orders';
const SB_URL        = process.env.SUPABASE_URL || 'https://ytzpfhjcaesgylodaasw.supabase.co';
const SB_KEY        = process.env.SUPABASE_SERVICE_KEY;

async function ensureAppSettingsTable() {
  if (!SB_KEY) return;
  // Use Supabase's REST API to check/create via a raw SQL RPC if available
  // We'll just attempt an insert and ignore "table doesn't exist" by catching
  try {
    await fetch(`${SB_URL}/rest/v1/app_settings?limit=1`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' }
    });
  } catch(e) { /* table may not exist yet, we'll handle in storeToken */ }
}

async function storeToken(access_token) {
  if (!SB_KEY) return false;
  // Try upsert
  const r = await fetch(`${SB_URL}/rest/v1/app_settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ key: 'shopify_access_token', value: access_token, updated_at: new Date().toISOString() })
  });
  
  if (r.status === 404 || r.status === 400) {
    // Table might not exist — try to create it via SQL RPC
    const sqlBody = JSON.stringify({ query: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('shopify_access_token', '${access_token.replace(/'/g,"''")}', NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
    `});
    // Supabase doesn't expose raw SQL via REST without pg_net, but we can try
    // the pg extension endpoint
    const sqlR = await fetch(`${SB_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      body: sqlBody
    });
    console.log('SQL RPC result:', sqlR.status);
    return sqlR.ok;
  }
  return r.ok;
}

module.exports = async function handler(req, res) {
  const { code, install, action } = req.query || {};

  // ── STATUS CHECK ──────────────────────────────────────────────────────────
  if (action === 'status') {
    if (!SB_KEY) return res.status(200).json({ connected: false, reason: 'No service key' });
    try {
      const r = await fetch(
        `${SB_URL}/rest/v1/app_settings?key=eq.shopify_access_token&select=value&limit=1`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' } }
      );
      const rows = r.ok ? await r.json() : [];
      return res.status(200).json({ connected: Array.isArray(rows) && rows.length > 0 && !!rows[0]?.value });
    } catch(e) {
      return res.status(200).json({ connected: false, reason: e.message });
    }
  }

  // ── STEP 1: Start OAuth ───────────────────────────────────────────────────
  if (install) {
    if (!CLIENT_ID) return res.status(500).send('SHOPIFY_CLIENT_ID not set in Vercel env vars');
    const nonce = Math.random().toString(36).slice(2);
    const url = `https://${SHOP}/admin/oauth/authorize` +
      `?client_id=${CLIENT_ID}&scope=${SCOPES}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${nonce}`;
    console.log('Redirecting to Shopify OAuth:', url);
    return res.redirect(302, url);
  }

  // ── STEP 2: OAuth callback ────────────────────────────────────────────────
  if (code) {
    try {
      if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Shopify credentials missing from env vars');

      const tokenRes = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
      });

      const tokenBody = await tokenRes.text();
      if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status}): ${tokenBody}`);
      
      const { access_token, scope } = JSON.parse(tokenBody);
      if (!access_token) throw new Error(`No access_token in response: ${tokenBody}`);
      
      console.log(`Shopify OAuth success. Scopes: ${scope}`);
      await storeToken(access_token);

      return res.redirect(302, `${APP_URL}?shopify=connected`);
    } catch(err) {
      console.error('OAuth callback error:', err.message);
      return res.redirect(302, `${APP_URL}?shopify=error&msg=${encodeURIComponent(err.message)}`);
    }
  }

  return res.status(400).json({ error: 'Missing required params. Use ?install=1 to start OAuth.' });
};
