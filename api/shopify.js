// /api/shopify.js — Vercel Serverless Function
// Proxies requests between the dashboard and Shopify GraphQL API.
// Reads SHOPIFY_ACCESS_TOKEN and SHOPIFY_STORE from Vercel env vars.
// Never exposes the token to the browser.

export default async function handler(req, res) {
  // CORS headers — allow requests from our own domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  const SHOPIFY_STORE        = process.env.SHOPIFY_STORE;

  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE) {
    return res.status(500).json({ error: 'Shopify env vars not configured on server' });
  }

  const SHOPIFY_URL = `https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`;

  const { action, orderId } = req.body || req.query || {};

  try {
    // ── GET OPEN ORDERS ────────────────────────────────────────────────────────
    if (!action || action === 'getOrders') {
      const query = `{
        orders(first: 100, query: "fulfillment_status:unshipped OR fulfillment_status:partial", sortKey: CREATED_AT, reverse: true) {
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
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        },
        body: JSON.stringify({ query })
      });

      if (!shopifyRes.ok) {
        const txt = await shopifyRes.text();
        return res.status(shopifyRes.status).json({ error: `Shopify error: ${shopifyRes.status}`, detail: txt });
      }

      const data = await shopifyRes.json();
      const orders = (data?.data?.orders?.edges || []).map(e => e.node);
      return res.status(200).json({ orders });
    }

    // ── FULFILL AN ORDER ───────────────────────────────────────────────────────
    if (action === 'fulfillOrder') {
      if (!orderId) return res.status(400).json({ error: 'orderId required' });

      // Step 1: Get fulfillment order ID from the order
      const getFulfillmentQuery = `{
        order(id: "${orderId}") {
          id
          name
          fulfillmentOrders(first: 10) {
            edges {
              node {
                id
                status
                lineItems(first: 50) {
                  edges {
                    node { id remainingQuantity }
                  }
                }
              }
            }
          }
        }
      }`;

      const foRes = await fetch(SHOPIFY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        },
        body: JSON.stringify({ query: getFulfillmentQuery })
      });

      const foData = await foRes.json();
      const fulfillmentOrders = (foData?.data?.order?.fulfillmentOrders?.edges || [])
        .map(e => e.node)
        .filter(fo => fo.status === 'OPEN' || fo.status === 'IN_PROGRESS');

      if (!fulfillmentOrders.length) {
        return res.status(200).json({ success: true, message: 'No open fulfillment orders found — may already be fulfilled' });
      }

      // Step 2: Create fulfillment
      const lineItemsByFulfillmentOrder = fulfillmentOrders.map(fo => ({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItems: fo.lineItems.edges.map(e => ({
          id: e.node.id,
          quantity: e.node.remainingQuantity
        }))
      }));

      const fulfillMutation = `
        mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $fulfillment) {
            fulfillment {
              id
              status
              trackingInfo { number url }
            }
            userErrors { field message }
          }
        }
      `;

      const fulfillRes = await fetch(SHOPIFY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        },
        body: JSON.stringify({
          query: fulfillMutation,
          variables: {
            fulfillment: {
              notifyCustomer: true,
              lineItemsByFulfillmentOrder
            }
          }
        })
      });

      const fulfillData = await fulfillRes.json();
      const errors = fulfillData?.data?.fulfillmentCreateV2?.userErrors || [];

      if (errors.length) {
        return res.status(400).json({ error: 'Shopify fulfillment error', details: errors });
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
