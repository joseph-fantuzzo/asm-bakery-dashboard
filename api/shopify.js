// /api/shopify.js — Shopify GraphQL proxy
// Fetches the access token from Supabase (set during OAuth) or env var fallback.
// Token never exposed to the browser.

import { createClient } from '@supabase/supabase-js';

const SHOP           = process.env.SHOPIFY_STORE || 'asweetmorselco.myshopify.com';
const SHOPIFY_URL    = `https://${SHOP}/admin/api/2026-04/graphql.json`;
const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://ytzpfhjcaesgylodaasw.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function getAccessToken() {
  // Try Supabase first (set via OAuth flow)
  if (SUPABASE_SERVICE_KEY) {
    try {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const { data } = await sb.from('app_settings')
        .select('value').eq('key', 'shopify_access_token').single();
      if (data?.value) return data.value;
    } catch(e) {
      console.warn('Supabase token fetch failed, trying env var:', e.message);
    }
  }
  // Fall back to env var (manually set static token)
  return process.env.SHOPIFY_ACCESS_TOKEN || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = await getAccessToken();
  if (!token) {
    return res.status(401).json({ error: 'Shopify not connected — complete OAuth setup first' });
  }

  const { action, orderId } = req.method === 'POST'
    ? (req.body || {})
    : (req.query || {});

  try {
    // ── GET OPEN / UNFULFILLED ORDERS ────────────────────────────────────────
    if (!action || action === 'getOrders') {
      const query = `{
        orders(
          first: 100,
          query: "fulfillment_status:unshipped OR fulfillment_status:partial",
          sortKey: CREATED_AT,
          reverse: true
        ) {
          edges {
            node {
              id
              name
              displayFulfillmentStatus
              createdAt
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { firstName lastName email }
              shippingAddress { address1 city province zip }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    name
                    quantity
                    sku
                    originalUnitPriceSet { shopMoney { amount } }
                  }
                }
              }
              note
              tags
            }
          }
        }
      }`;

      const shopifyRes = await fetch(SHOPIFY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token
        },
        body: JSON.stringify({ query })
      });

      if (!shopifyRes.ok) {
        const txt = await shopifyRes.text();
        return res.status(shopifyRes.status).json({ error: `Shopify error ${shopifyRes.status}`, detail: txt });
      }

      const data = await shopifyRes.json();
      if (data.errors) {
        return res.status(400).json({ error: 'GraphQL error', details: data.errors });
      }
      const orders = (data?.data?.orders?.edges || []).map(e => e.node);
      return res.status(200).json({ orders });
    }

    // ── FULFILL AN ORDER ─────────────────────────────────────────────────────
    if (action === 'fulfillOrder') {
      if (!orderId) return res.status(400).json({ error: 'orderId required' });

      // Step 1: Get open fulfillment order IDs
      const getFOQuery = `{
        order(id: "${orderId}") {
          id
          name
          fulfillmentOrders(first: 10) {
            edges {
              node {
                id
                status
                lineItems(first: 50) {
                  edges { node { id remainingQuantity } }
                }
              }
            }
          }
        }
      }`;

      const foRes = await fetch(SHOPIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: getFOQuery })
      });
      const foData = await foRes.json();

      const fulfillmentOrders = (foData?.data?.order?.fulfillmentOrders?.edges || [])
        .map(e => e.node)
        .filter(fo => ['OPEN', 'IN_PROGRESS'].includes(fo.status));

      if (!fulfillmentOrders.length) {
        return res.status(200).json({ success: true, message: 'Already fulfilled or no open fulfillment orders' });
      }

      // Step 2: Create fulfillment
      const lineItemsByFulfillmentOrder = fulfillmentOrders.map(fo => ({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItems: fo.lineItems.edges
          .filter(e => e.node.remainingQuantity > 0)
          .map(e => ({ id: e.node.id, quantity: e.node.remainingQuantity }))
      }));

      const fulfillMutation = `
        mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $fulfillment) {
            fulfillment { id status }
            userErrors { field message }
          }
        }
      `;

      const fulfillRes = await fetch(SHOPIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({
          query: fulfillMutation,
          variables: {
            fulfillment: { notifyCustomer: true, lineItemsByFulfillmentOrder }
          }
        })
      });

      const fulfillData = await fulfillRes.json();
      const userErrors = fulfillData?.data?.fulfillmentCreateV2?.userErrors || [];
      if (userErrors.length) {
        return res.status(400).json({ error: 'Shopify fulfillment error', details: userErrors });
      }

      return res.status(200).json({
        success: true,
        fulfillment: fulfillData?.data?.fulfillmentCreateV2?.fulfillment
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Shopify proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
}
