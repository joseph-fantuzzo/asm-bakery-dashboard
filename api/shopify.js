// /api/shopify.js — Shopify GraphQL proxy (CommonJS, no external deps)
// Reads Shopify access token from Supabase REST API or env var fallback.

const SHOP         = process.env.SHOPIFY_STORE || 'a-sweet-morsel-co.myshopify.com';
const SHOPIFY_URL  = `https://${SHOP}/admin/api/2026-04/graphql.json`;
const SB_URL       = process.env.SUPABASE_URL || 'https://ytzpfhjcaesgylodaasw.supabase.co';
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY;

async function getAccessToken() {
  // Try Supabase app_settings table first (populated via OAuth)
  if (SB_KEY) {
    try {
      const r = await fetch(
        `${SB_URL}/rest/v1/app_settings?key=eq.shopify_access_token&select=value&limit=1`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      );
      const rows = await r.json();
      if (rows?.[0]?.value) return rows[0].value;
    } catch(e) { console.warn('SB token fetch failed:', e.message); }
  }
  // Fall back to env var static token
  return process.env.SHOPIFY_ACCESS_TOKEN || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = await getAccessToken();
  if (!token) {
    return res.status(401).json({ error: 'Shopify not connected — complete OAuth setup first' });
  }

  const body   = req.method === 'POST' ? (req.body || {}) : {};
  const query  = req.query || {};
  const action  = body.action || query.action;
  const orderId = body.orderId || query.orderId;

  try {
    // ── GET OPEN / UNFULFILLED ORDERS ───────────────────────────────────────
    if (!action || action === 'getOrders') {
      const gql = `{
        orders(first:100, query:"fulfillment_status:unshipped OR fulfillment_status:partial", sortKey:CREATED_AT, reverse:true) {
          edges { node {
            id name displayFulfillmentStatus createdAt
            totalPriceSet { shopMoney { amount currencyCode } }
            customer { firstName lastName email }
            lineItems(first:50) { edges { node { id name quantity sku originalUnitPriceSet { shopMoney { amount } } } } }
            note tags
          }}
        }
      }`;

      const sr = await fetch(SHOPIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: gql })
      });

      if (!sr.ok) return res.status(sr.status).json({ error: `Shopify ${sr.status}`, detail: await sr.text() });
      const data = await sr.json();
      if (data.errors) return res.status(400).json({ error: 'GraphQL error', details: data.errors });
      return res.status(200).json({ orders: (data?.data?.orders?.edges || []).map(e => e.node) });
    }

    // ── FULFILL AN ORDER ────────────────────────────────────────────────────
    if (action === 'fulfillOrder') {
      if (!orderId) return res.status(400).json({ error: 'orderId required' });

      // Step 1: Get fulfillment orders
      const foGql = `{ order(id:"${orderId}") { fulfillmentOrders(first:10) { edges { node { id status lineItems(first:50) { edges { node { id remainingQuantity } } } } } } } }`;
      const foR = await fetch(SHOPIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: foGql })
      });
      const foData = await foR.json();
      const fos = (foData?.data?.order?.fulfillmentOrders?.edges || [])
        .map(e => e.node).filter(fo => ['OPEN','IN_PROGRESS'].includes(fo.status));

      if (!fos.length) return res.status(200).json({ success: true, message: 'Already fulfilled' });

      // Step 2: Fulfill
      const lineItemsByFulfillmentOrder = fos.map(fo => ({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItems: fo.lineItems.edges
          .filter(e => e.node.remainingQuantity > 0)
          .map(e => ({ id: e.node.id, quantity: e.node.remainingQuantity }))
      }));

      const mutation = `mutation fulfillmentCreateV2($f: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $f) {
          fulfillment { id status }
          userErrors { field message }
        }
      }`;

      const fR = await fetch(SHOPIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: mutation, variables: { f: { notifyCustomer: true, lineItemsByFulfillmentOrder } } })
      });
      const fData = await fR.json();
      const errs = fData?.data?.fulfillmentCreateV2?.userErrors || [];
      if (errs.length) return res.status(400).json({ error: 'Fulfillment error', details: errs });
      return res.status(200).json({ success: true, fulfillment: fData?.data?.fulfillmentCreateV2?.fulfillment });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch(err) {
    console.error('Shopify proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
};
