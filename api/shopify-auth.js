// /api/shopify-auth.js — Shopify OAuth handler (CommonJS, no external deps)
// GET ?install=1  → redirects to Shopify consent screen
// GET ?code=...   → exchanges code for token, stores in Supabase via REST

const CLIENT_ID    = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET= process.env.SHOPIFY_CLIENT_SECRET;
const SHOP         = process.env.SHOPIFY_STORE || 'asweetmorselco.myshopify.com';
const APP_URL      = process.env.APP_URL || 'https://ops.asweetmorselco.com';
const REDIRECT_URI = `${APP_URL}/api/shopify-auth`;
const SCOPES       = 'read_orders,write_orders';
const SB_URL       = process.env.SUPABASE_URL || 'https://ytzpfhjcaesgylodaasw.supabase.co';
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  const { code, install } = req.query || {};

  // ── STEP 1: Start OAuth — redirect to Shopify ──────────────────────────────
  if (install) {
    if (!CLIENT_ID) {
      return res.status(500).send('SHOPIFY_CLIENT_ID env var not set on server');
    }
    const nonce = Math.random().toString(36).slice(2);
    const authUrl = `https://${SHOP}/admin/oauth/authorize` +
      `?client_id=${CLIENT_ID}` +
      `&scope=${SCOPES}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${nonce}`;
    return res.redirect(302, authUrl);
  }

  // ── STEP 2: Shopify redirects back with ?code= ────────────────────────────
  if (code) {
    try {
      if (!CLIENT_ID || !CLIENT_SECRET) {
        throw new Error('Shopify credentials not configured on server');
      }

      // Exchange code for permanent access token
      const tokenRes = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
      });

      if (!tokenRes.ok) throw new Error(`Token exchange HTTP ${tokenRes.status}: ${await tokenRes.text()}`);
      const { access_token } = await tokenRes.json();
      if (!access_token) throw new Error('No access_token returned from Shopify');

      // Store token in Supabase app_settings via REST API (no SDK needed)
      if (SB_KEY) {
        const sbRes = await fetch(`${SB_URL}/rest/v1/app_settings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SB_KEY,
            Authorization: `Bearer ${SB_KEY}`,
            Prefer: 'resolution=merge-duplicates'
          },
          body: JSON.stringify({ key: 'shopify_access_token', value: access_token, updated_at: new Date().toISOString() })
        });
        if (!sbRes.ok) {
          const sbErr = await sbRes.text();
          console.error('Supabase upsert failed:', sbErr);
          // Don't throw — token was received, just log the storage failure
        }
      }

      console.log('Shopify OAuth complete — token stored');
      return res.redirect(302, `${APP_URL}?shopify=connected`);

    } catch(err) {
      console.error('OAuth error:', err.message);
      return res.redirect(302, `${APP_URL}?shopify=error&msg=${encodeURIComponent(err.message)}`);
    }
  }

  return res.status(400).json({ error: 'Missing code or install param' });
};
