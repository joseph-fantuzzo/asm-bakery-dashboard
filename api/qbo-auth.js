// /api/qbo-auth.js — QuickBooks Online OAuth 2.0 handler (CommonJS, no external deps)
// GET ?install=1  → redirects to Intuit consent screen
// GET ?code=...   → exchanges code for tokens, passes to browser via URL fragment

const CLIENT_ID     = process.env.QB_CLIENT_ID;
const CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const REDIRECT_URI  = process.env.QB_REDIRECT_URI || 'https://ops.asweetmorselco.com/api/qbo-auth';
const ENVIRONMENT   = process.env.QB_ENVIRONMENT || 'sandbox';
const APP_URL       = process.env.APP_URL || 'https://ops.asweetmorselco.com';

const SCOPES = 'com.intuit.quickbooks.accounting';

const AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

module.exports = async function handler(req, res) {
  const { code, state, realmId, install, action } = req.query || {};

  // ── STATUS CHECK ──────────────────────────────────────────────────────────
  if (action === 'status') {
    const tok = req.headers['x-qbo-token'];
    return res.status(200).json({ connected: !!tok });
  }

  // ── STEP 1: Start OAuth ───────────────────────────────────────────────────
  if (install) {
    if (!CLIENT_ID) return res.status(500).send('QB_CLIENT_ID not set in Vercel env vars');
    const nonce = Math.random().toString(36).slice(2);
    const url = `${AUTH_URL}?` + new URLSearchParams({
      client_id:     CLIENT_ID,
      scope:         SCOPES,
      redirect_uri:  REDIRECT_URI,
      response_type: 'code',
      state:         nonce
    }).toString();
    return res.redirect(302, url);
  }

  // ── STEP 2: OAuth callback ────────────────────────────────────────────────
  if (code && realmId) {
    try {
      if (!CLIENT_ID || !CLIENT_SECRET) {
        throw new Error('QB_CLIENT_ID or QB_CLIENT_SECRET missing from Vercel env vars');
      }

      // Exchange code for tokens
      const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': `Basic ${creds}`,
          'Accept':        'application/json'
        },
        body: new URLSearchParams({
          grant_type:   'authorization_code',
          code,
          redirect_uri: REDIRECT_URI
        }).toString()
      });

      const body = await tokenRes.text();
      if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status}): ${body}`);

      const tokens = JSON.parse(body);
      if (!tokens.access_token) throw new Error('No access_token in QBO response');

      // Pass tokens + realmId to browser via URL fragment
      const payload = encodeURIComponent(JSON.stringify({
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        realm_id:      realmId,
        expires_in:    tokens.expires_in,
        issued_at:     Date.now()
      }));

      return res.redirect(302, `${APP_URL}#qbo_tokens=${payload}`);

    } catch(err) {
      console.error('QBO OAuth error:', err.message);
      return res.redirect(302, `${APP_URL}?qbo=error&msg=${encodeURIComponent(err.message)}`);
    }
  }

  return res.status(400).json({ error: 'Missing params. Use ?install=1 to start OAuth.' });
};
