// /api/shopify-auth.js — Shopify OAuth handler
// Step 1 (GET ?shop=...): Redirects to Shopify's OAuth consent screen
// Step 2 (GET ?code=...): Exchanges code for access token, stores in Supabase

import { createClient } from '@supabase/supabase-js';

const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOP          = process.env.SHOPIFY_STORE || 'asweetmorselco.myshopify.com';
const APP_URL       = process.env.APP_URL || 'https://ops.asweetmorselco.com';
const REDIRECT_URI  = `${APP_URL}/api/shopify-auth`;
const SCOPES        = 'read_orders,write_orders';
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://ytzpfhjcaesgylodaasw.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY; // service role key — bypasses RLS

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', APP_URL);

  const { code, shop, state, install } = req.query || {};

  // ── STEP 1: Initiate OAuth — redirect to Shopify ──────────────────────────
  if (install || (!code && !shop?.includes('.'))) {
    const nonce = Math.random().toString(36).slice(2);
    const authUrl =
      `https://${SHOP}/admin/oauth/authorize` +
      `?client_id=${CLIENT_ID}` +
      `&scope=${SCOPES}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${nonce}`;
    return res.redirect(302, authUrl);
  }

  // ── STEP 2: Shopify redirects back with ?code=... ────────────────────────
  if (code) {
    try {
      // Exchange code for permanent access token
      const tokenRes = await fetch(
        `https://${SHOP}/admin/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id:     CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code
          })
        }
      );

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`Token exchange failed: ${err}`);
      }

      const { access_token } = await tokenRes.json();
      if (!access_token) throw new Error('No access_token in response');

      // Store token in Supabase app_settings table
      if (SUPABASE_SERVICE_KEY) {
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const { error } = await sb.from('app_settings').upsert({
          key: 'shopify_access_token',
          value: access_token,
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });
        if (error) console.error('Supabase store error:', error.message);
      }

      // Also set as env var hint in response (Vercel can't set env vars at runtime,
      // but we store in Supabase above — that's the source of truth)
      console.log('Shopify OAuth complete. Token stored in Supabase app_settings.');

      // Redirect back to dashboard with success flag
      return res.redirect(302, `${APP_URL}?shopify=connected`);

    } catch (err) {
      console.error('OAuth error:', err.message);
      return res.redirect(302, `${APP_URL}?shopify=error&msg=${encodeURIComponent(err.message)}`);
    }
  }

  // ── PING: Check if token exists ──────────────────────────────────────────
  if (req.query.action === 'status') {
    try {
      if (!SUPABASE_SERVICE_KEY) {
        // Fall back to env var token if no service key
        const hasEnvToken = !!process.env.SHOPIFY_ACCESS_TOKEN;
        return res.status(200).json({ connected: hasEnvToken, source: 'env' });
      }
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const { data } = await sb.from('app_settings')
        .select('value').eq('key', 'shopify_access_token').single();
      return res.status(200).json({ connected: !!data?.value, source: 'supabase' });
    } catch(e) {
      return res.status(200).json({ connected: false });
    }
  }

  return res.status(400).json({ error: 'Invalid request' });
}
