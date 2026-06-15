// /api/shopify-auth.js — Shopify OAuth (CommonJS, no external deps)
// After OAuth, passes token to browser via URL fragment -> localStorage

const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOP          = process.env.SHOPIFY_STORE || 'a-sweet-morsel-co.myshopify.com';
const APP_URL       = process.env.APP_URL || 'https://ops.asweetmorselco.com';
const REDIRECT_URI  = `${APP_URL}/api/shopify-auth`;
const SCOPES        = 'read_orders,write_orders';

module.exports = async function handler(req, res) {
  const { code, install } = req.query || {};

  // ── STEP 1: Start OAuth ───────────────────────────────────────────────────
  if (install) {
    if (!CLIENT_ID) {
      return res.status(500).send('SHOPIFY_CLIENT_ID not configured in Vercel env vars.');
    }
    const nonce = Math.random().toString(36).slice(2);
    const url   = `https://${SHOP}/admin/oauth/authorize` +
      `?client_id=${CLIENT_ID}` +
      `&scope=${SCOPES}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${nonce}`;
    return res.redirect(302, url);
  }

  // ── STEP 2: OAuth callback with ?code= ────────────────────────────────────
  if (code) {
    try {
      if (!CLIENT_ID || !CLIENT_SECRET) {
        throw new Error('SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET missing from Vercel env vars');
      }

      const tokenRes = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
      });

      const body = await tokenRes.text();
      if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status}): ${body}`);

      const { access_token } = JSON.parse(body);
      if (!access_token) throw new Error('No access_token in Shopify response');

      // Pass token to browser via URL fragment (never sent to any server)
      // Dashboard reads it, saves to localStorage, clears the fragment
      return res.redirect(302, `${APP_URL}#shopify_token=${encodeURIComponent(access_token)}`);

    } catch(err) {
      console.error('OAuth error:', err.message);
      return res.redirect(302, `${APP_URL}?shopify=error&msg=${encodeURIComponent(err.message)}`);
    }
  }

  return res.status(400).json({
    error: 'Missing params',
    hint: 'Use ?install=1 to start OAuth flow'
  });
};
