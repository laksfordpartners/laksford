// Netlify serverless function — Laksford Command Center, private Google-Sheet source.
//
// Reads your "Internal Revenue & Margin Tracker" over the authenticated Google
// Sheets API using a SERVICE ACCOUNT. The Sheet is NEVER published — it stays
// fully private and is shared only with the service account's email. Nothing
// sensitive is exposed to the browser: the credentials live only in Netlify env
// vars, the function returns just the aggregate numbers.
//
// Environment variables (Netlify → Site config → Environment variables):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL — e.g. laksford-dash@your-project.iam.gserviceaccount.com
//   GOOGLE_PRIVATE_KEY           — the PEM private key from the service-account JSON.
//                                  Paste it whole; literal "\n" sequences are handled.
//   SHEET_ID                     — the spreadsheet ID (the long part of its URL).
//   SHEET_TABS                   — OPTIONAL. Comma-separated tab names to read
//                                  (e.g. "March-26,Apr-26,May - 26,June - 26").
//                                  If omitted, every tab is read; tabs without an
//                                  order table are ignored automatically.
//   DASHBOARD_PASSWORD           — the dashboard passcode (unchanged).
//
// Returns: { newOrdersThisMonth, monthlyGMV, yearlyGMV, yearlyOrders,
//            netRevenue, currency, lastUpdated, source }

const crypto = require("crypto");

// --- row parsing (works on the 2D arrays the Sheets API returns) ------------

const norm = (s) => (s == null ? "" : String(s)).trim().toLowerCase();

function findHeaderIndex(rows) {
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] || []).some((c) => norm(c).includes("walmart order id"))) return i;
  }
  return -1;
}

function colIndex(headerCells, candidates) {
  const H = headerCells.map(norm);
  for (const cand of candidates) {
    const exact = H.indexOf(cand);
    if (exact !== -1) return exact;
  }
  for (let i = 0; i < H.length; i++) {
    if (candidates.some((cand) => H[i].includes(cand))) return i;
  }
  return -1;
}

const toNumber = (v) => {
  if (v == null) return NaN;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ""));
  return isNaN(n) ? NaN : n;
};

// Accept YYYY-MM-DD or M/D/YYYY (with 2- or 4-digit year). Returns UTC Date or null.
function parseRowDate(v) {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return new Date(Date.UTC(y, +m[1] - 1, +m[2]));
  }
  return null;
}

// Turn one tab's rows into { date, gmv, net, id } order records.
function extractOrders(rows) {
  const h = findHeaderIndex(rows);
  if (h === -1) return [];
  const header = rows[h];
  const iDate = colIndex(header, ["date"]);
  const iGmv = colIndex(header, ["walmart sale price ($)", "walmart sale price", "sale price"]);
  const iNet = colIndex(header, ["net revenue ($)", "net revenue"]);
  const iId = colIndex(header, ["walmart order id", "order id"]);
  if (iDate === -1) return [];

  const out = [];
  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (norm(row.slice(0, 4).join(" ")).includes("total")) continue;
    const d = parseRowDate(row[iDate]);
    if (!d) continue;
    const gmv = iGmv !== -1 ? toNumber(row[iGmv]) : NaN;
    const net = iNet !== -1 ? toNumber(row[iNet]) : NaN;
    out.push({
      date: d,
      gmv: isNaN(gmv) ? 0 : gmv,
      net: isNaN(net) ? 0 : net,
      id: iId !== -1 ? String(row[iId] || "").trim() : "",
    });
  }
  return out;
}

// --- Google auth (service account → OAuth2 access token, no npm deps) -------

// Rebuild a clean PEM no matter how the key survived copy/paste into env vars:
// handles surrounding quotes, literal "\n"/"\r", missing line breaks, and CRLF.
function normalizePrivateKey(raw) {
  let k = String(raw || "").trim();
  // Strip a single layer of wrapping quotes if present.
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1);
  }
  // Turn escaped sequences into real characters, drop CRs.
  k = k.replace(/\\r/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  // Reconstruct the PEM from the base64 body so wrapping is always valid.
  const m = k.match(/-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]*?)-----END \1-----/);
  if (m) {
    const label = m[1].trim();
    const body = m[2].replace(/[^A-Za-z0-9+/=]/g, ""); // keep base64 chars only
    if (body) {
      const wrapped = body.match(/.{1,64}/g).join("\n");
      k = `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
    }
  }
  return k;
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function getAccessToken(email, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claim));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = b64url(signer.sign(privateKeyPem));
  const assertion = unsigned + "." + signature;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" +
      encodeURIComponent(assertion),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`auth_failed_${res.status}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()).access_token;
}

// A1 sheet-name reference: single-quote and escape embedded quotes.
const quoteTab = (title) => "'" + String(title).replace(/'/g, "''") + "'";

async function listTabTitles(token, sheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    sheetId
  )}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`meta_failed_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.sheets || []).map((s) => s.properties.title);
}

async function batchGetValues(token, sheetId, tabs) {
  const params = tabs
    .map((t) => "ranges=" + encodeURIComponent(quoteTab(t)))
    .join("&");
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values:batchGet?${params}&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`values_failed_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.valueRanges || []).map((vr) => vr.values || []);
}

// --- handler ---------------------------------------------------------------

exports._test = { extractOrders, findHeaderIndex, colIndex, parseRowDate, normalizePrivateKey };

exports.handler = async (event) => {
  const okPw = process.env.DASHBOARD_PASSWORD;
  const given = (event.queryStringParameters && event.queryStringParameters.key) || "";
  if (!okPw || given !== okPw) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.SHEET_ID;
  if (!email || !rawKey || !sheetId) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "missing_config",
        hint: "Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY and SHEET_ID in Netlify env vars.",
      }),
    };
  }
  const privateKey = normalizePrivateKey(rawKey);

  try {
    const token = await getAccessToken(email, privateKey);

    let tabs = (process.env.SHEET_TABS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (tabs.length === 0) tabs = await listTabTitles(token, sheetId);

    const tabRows = await batchGetValues(token, sheetId, tabs);

    let orders = [];
    for (const rows of tabRows) orders = orders.concat(extractOrders(rows));

    // De-duplicate by order id + date when an id is present.
    const seen = new Set();
    orders = orders.filter((o) => {
      if (!o.id) return true;
      const k = o.id + "@" + o.date.toISOString().slice(0, 10);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();

    let yearlyGMV = 0, monthlyGMV = 0, netRevenue = 0, yearlyOrders = 0, newOrdersThisMonth = 0;
    for (const o of orders) {
      if (o.date.getUTCFullYear() !== year) continue;
      yearlyOrders++;
      yearlyGMV += o.gmv;
      netRevenue += o.net;
      if (o.date.getUTCMonth() === month) {
        newOrdersThisMonth++;
        monthlyGMV += o.gmv;
      }
    }
    const round2 = (n) => Math.round(n * 100) / 100;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        newOrdersThisMonth,
        monthlyGMV: round2(monthlyGMV),
        yearlyGMV: round2(yearlyGMV),
        yearlyOrders,
        netRevenue: round2(netRevenue),
        currency: "USD",
        lastUpdated: now.toISOString(),
        source: "google-sheet (service account)",
      }),
    };
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: "sheet_source_error",
        detail: String(e && e.message ? e.message : e),
      }),
    };
  }
};
