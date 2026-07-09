// Netlify serverless function — Laksford Partners Walmart Marketplace metrics.
// Holds credentials as environment variables (set in Netlify UI, never in code):
//   WALMART_CLIENT_ID       — your Walmart Marketplace API Client ID
//   WALMART_CLIENT_SECRET   — your Walmart Marketplace API Client Secret
//   DASHBOARD_PASSWORD      — the passcode required to view the dashboard
//
// Returns: { newOrdersThisMonth, monthlyGMV, yearlyGMV, yearlyOrders, currency, lastUpdated }

const crypto = require("crypto");

const WM_BASE = "https://marketplace.walmartapis.com/v3";

function toArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

async function getToken(id, secret) {
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(`${WM_BASE}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "WM_SVC.NAME": "Walmart Marketplace",
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`token_failed_${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.access_token;
}

// Sum the PRODUCT charge amounts across an order's lines = merchandise value.
function orderGMV(order) {
  let sum = 0;
  const lines = toArray(order?.orderLines?.orderLine);
  for (const line of lines) {
    const charges = toArray(line?.charges?.charge);
    for (const c of charges) {
      const type = (c?.chargeType || "").toUpperCase();
      const amt = parseFloat(c?.chargeAmount?.amount);
      if (type === "PRODUCT" && !isNaN(amt)) sum += amt;
    }
  }
  return sum;
}

async function fetchOrdersSince(token, sinceISO) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "WM_SEC.ACCESS_TOKEN": token,
    "WM_SVC.NAME": "Walmart Marketplace",
    "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
    Accept: "application/json",
  };
  const orders = [];
  let url = `${WM_BASE}/orders?createdStartDate=${encodeURIComponent(sinceISO)}&limit=100`;
  let currency = "USD";
  let guard = 0;

  while (url && guard < 60) {
    guard++;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`orders_failed_${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = await res.json();
    const list = json?.list || {};
    const els = toArray(list?.elements?.order);
    for (const o of els) {
      orders.push(o);
      const cur =
        o?.orderLines?.orderLine &&
        toArray(o.orderLines.orderLine)[0]?.charges?.charge &&
        toArray(toArray(o.orderLines.orderLine)[0].charges.charge)[0]?.chargeAmount?.currency;
      if (cur) currency = cur;
    }
    const nextCursor = list?.meta?.nextCursor;
    url = nextCursor ? `${WM_BASE}/orders${nextCursor}` : null;
  }
  return { orders, currency };
}

exports.handler = async (event) => {
  const okPw = process.env.DASHBOARD_PASSWORD;
  const given = (event.queryStringParameters && event.queryStringParameters.key) || "";
  if (!okPw || given !== okPw) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }

  const id = process.env.WALMART_CLIENT_ID;
  const secret = process.env.WALMART_CLIENT_SECRET;
  if (!id || !secret) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "missing_credentials", hint: "Set WALMART_CLIENT_ID and WALMART_CLIENT_SECRET in Netlify env vars." }),
    };
  }

  try {
    const now = new Date();
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const token = await getToken(id, secret);
    const { orders, currency } = await fetchOrdersSince(token, yearStart);

    let yearlyGMV = 0,
      monthlyGMV = 0,
      newOrdersThisMonth = 0;

    for (const o of orders) {
      const gmv = orderGMV(o);
      yearlyGMV += gmv;
      const d = new Date(o?.orderDate || o?.orderLines?.orderLine?.[0]?.orderLineStatuses || now);
      if (d >= monthStart) {
        monthlyGMV += gmv;
        newOrdersThisMonth++;
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        newOrdersThisMonth,
        monthlyGMV: Math.round(monthlyGMV * 100) / 100,
        yearlyGMV: Math.round(yearlyGMV * 100) / 100,
        yearlyOrders: orders.length,
        currency,
        lastUpdated: now.toISOString(),
      }),
    };
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "walmart_api_error", detail: String(e && e.message ? e.message : e) }),
    };
  }
};
