// /api/shopify.js — Shopify GraphQL proxy (CommonJS, no external deps)
// Reads token from X-Shopify-Token request header (set by dashboard from localStorage)

const SHOP    = process.env.SHOPIFY_STORE || 'a-sweet-morsel-co.myshopify.com';
const GQL_URL = `https://${SHOP}/admin/api/2026-04/graphql.json`;

async function shopifyGQL(token, query, variables) {
  const r = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify(variables ? { query, variables } : { query })
  });
  if (!r.ok) throw new Error(`Shopify HTTP ${r.status}: ${await r.text()}`);
  const json = await r.json();
  if (json.errors && json.errors.length) {
    throw new Error('GraphQL: ' + json.errors.map(e => e.message).join('; '));
  }
  return json.data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Shopify-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Token comes from browser localStorage via request header
  const token = req.headers['x-shopify-token'] || null;
  if (!token) {
    return res.status(401).json({ error: 'Not connected — complete Shopify OAuth first' });
  }

  const body    = req.method === 'POST' ? (req.body || {}) : {};
  const action  = body.action  || (req.query || {}).action;
  const orderId = body.orderId || (req.query || {}).orderId;

  try {
    // ── GET OPEN / UNFULFILLED ORDERS ───────────────────────────────────────
    if (!action || action === 'getOrders') {
      const data = await shopifyGQL(token, `{
        orders(
          first: 100,
          query: "fulfillment_status:unfulfilled",
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
              lineItems(first: 50) {
                edges {
                  node { id name quantity sku }
                }
              }
              note
            }
          }
        }
      }`);
      const orders = (data?.orders?.edges || []).map(e => e.node);
      return res.status(200).json({ orders });
    }

    // ── FULFILL AN ORDER ────────────────────────────────────────────────────
    if (action === 'fulfillOrder') {
      if (!orderId) return res.status(400).json({ error: 'orderId required' });

      const foData = await shopifyGQL(token, `{
        order(id: "${orderId}") {
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
      }`);

      const fos = (foData?.order?.fulfillmentOrders?.edges || [])
        .map(e => e.node)
        .filter(fo => ['OPEN', 'IN_PROGRESS'].includes(fo.status));

      if (!fos.length) {
        return res.status(200).json({ success: true, message: 'Already fulfilled' });
      }

      const lineItemsByFulfillmentOrder = fos.map(fo => ({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItems: fo.lineItems.edges
          .filter(e => e.node.remainingQuantity > 0)
          .map(e => ({ id: e.node.id, quantity: e.node.remainingQuantity }))
      }));

      const fData = await shopifyGQL(token,
        `mutation fulfillmentCreateV2($f: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $f) {
            fulfillment { id status }
            userErrors { field message }
          }
        }`,
        { f: { notifyCustomer: true, lineItemsByFulfillmentOrder } }
      );

      const errs = fData?.fulfillmentCreateV2?.userErrors || [];
      if (errs.length) return res.status(400).json({ error: 'Fulfillment error', details: errs });

      return res.status(200).json({
        success: true,
        fulfillment: fData?.fulfillmentCreateV2?.fulfillment
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch(err) {
    console.error('Shopify error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
