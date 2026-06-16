// /api/qbo.js — QuickBooks Online proxy (CommonJS, no external deps)
// Reads QBO access token + realmId from request headers (set by dashboard from localStorage)
// Handles: token refresh, find-or-create customer, find-or-create item, create invoice

const CLIENT_ID     = process.env.QB_CLIENT_ID;
const CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const ENVIRONMENT   = process.env.QB_ENVIRONMENT || 'sandbox';
const TOKEN_URL     = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function qboBase(realmId) {
  const base = ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
  return `${base}/v3/company/${realmId}`;
}

async function qboGet(token, realmId, path) {
  const r = await fetch(`${qboBase(realmId)}${path}?minorversion=70`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (!r.ok) throw new Error(`QBO GET ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function qboPost(token, realmId, path, body) {
  const r = await fetch(`${qboBase(realmId)}${path}?minorversion=70`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept:         'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`QBO POST ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function refreshToken(refreshTok) {
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`,
      'Accept':        'application/json'
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshTok }).toString()
  });
  if (!r.ok) throw new Error(`Token refresh failed: ${r.status}`);
  return r.json();
}

async function findOrCreateCustomer(token, realmId, name) {
  // Search by name
  const escaped = name.replace(/'/g, "\\'");
  const query = `SELECT * FROM Customer WHERE DisplayName = '${escaped}' MAXRESULTS 1`;
  const result = await qboPost(token, realmId, '/query', null).catch(() => null);

  // Use query endpoint with GET
  const qr = await fetch(
    `${qboBase(realmId)}/query?query=${encodeURIComponent(query)}&minorversion=70`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  const qData = await qr.json();
  const existing = qData?.QueryResponse?.Customer?.[0];
  if (existing) return existing;

  // Create new customer
  const created = await qboPost(token, realmId, '/customer', { DisplayName: name });
  return created.Customer;
}

async function findOrCreateItem(token, realmId, name, unitPrice) {
  // Search by name
  const escaped = name.replace(/'/g, "\\'");
  const qr = await fetch(
    `${qboBase(realmId)}/query?query=${encodeURIComponent(`SELECT * FROM Item WHERE Name = '${escaped}' MAXRESULTS 1`)}&minorversion=70`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  const qData = await qr.json();
  const existing = qData?.QueryResponse?.Item?.[0];
  if (existing) return existing;

  // Need income account ref — get first income account
  const acctR = await fetch(
    `${qboBase(realmId)}/query?query=${encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1")}&minorversion=70`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  const acctData = await acctR.json();
  const incomeAcct = acctData?.QueryResponse?.Account?.[0];

  const itemBody = {
    Name:        name,
    Type:        'Service',
    UnitPrice:   unitPrice || 0,
    IncomeAccountRef: incomeAcct
      ? { value: incomeAcct.Id, name: incomeAcct.Name }
      : { value: '1', name: 'Services' }
  };
  const created = await qboPost(token, realmId, '/item', itemBody);
  return created.Item;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-QBO-Token, X-QBO-Realm, X-QBO-Refresh');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token      = req.headers['x-qbo-token'];
  const realmId    = req.headers['x-qbo-realm'];
  const refreshTok = req.headers['x-qbo-refresh'];

  const body   = req.method === 'POST' ? (req.body || {}) : {};
  const action = body.action || (req.query || {}).action;

  // ── REFRESH TOKEN ─────────────────────────────────────────────────────────
  if (action === 'refresh') {
    if (!refreshTok) return res.status(400).json({ error: 'No refresh token' });
    try {
      const newTokens = await refreshToken(refreshTok);
      return res.status(200).json({
        access_token:  newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expires_in:    newTokens.expires_in,
        issued_at:     Date.now()
      });
    } catch(e) {
      return res.status(401).json({ error: e.message });
    }
  }

  if (!token || !realmId) {
    return res.status(401).json({ error: 'QBO not connected — complete OAuth first' });
  }

  try {
    // ── CREATE INVOICE ──────────────────────────────────────────────────────
    if (action === 'createInvoice') {
      const { custName, recipeName, qty, unitPrice, dueDate, orderRef } = body;
      if (!custName || !recipeName) {
        return res.status(400).json({ error: 'custName and recipeName required' });
      }

      // Find or create customer
      const customer = await findOrCreateCustomer(token, realmId, custName);
      if (!customer) throw new Error(`Could not find or create customer: ${custName}`);

      // Find or create item/service
      const item = await findOrCreateItem(token, realmId, recipeName, unitPrice);
      if (!item) throw new Error(`Could not find or create item: ${recipeName}`);

      // Build invoice
      const invoiceBody = {
        CustomerRef:  { value: customer.Id, name: customer.DisplayName },
        DueDate:      dueDate || new Date(Date.now() + 30*86400000).toISOString().split('T')[0],
        PrivateNote:  orderRef ? `ASMOPS Order #${orderRef}` : '',
        Line: [{
          DetailType:          'SalesItemLineDetail',
          Amount:              (qty || 1) * (unitPrice || 0),
          SalesItemLineDetail: {
            ItemRef:   { value: item.Id, name: item.Name },
            Qty:       qty || 1,
            UnitPrice: unitPrice || 0
          }
        }]
      };

      const invoice = await qboPost(token, realmId, '/invoice', invoiceBody);
      return res.status(200).json({
        success:   true,
        invoiceId: invoice.Invoice?.Id,
        invoiceNo: invoice.Invoice?.DocNumber,
        total:     invoice.Invoice?.TotalAmt
      });
    }

    // ── GET COMPANY INFO (connection test) ──────────────────────────────────
    if (action === 'ping') {
      const info = await qboGet(token, realmId, '/companyinfo/' + realmId);
      return res.status(200).json({
        connected:   true,
        companyName: info.CompanyInfo?.CompanyName,
        environment: ENVIRONMENT
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch(err) {
    console.error('QBO error:', err.message);
    // If token expired, tell browser to refresh
    if (err.message.includes('401') || err.message.includes('token')) {
      return res.status(401).json({ error: 'Token expired', refresh: true });
    }
    return res.status(500).json({ error: err.message });
  }
};
