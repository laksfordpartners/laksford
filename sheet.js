// Netlify serverless function — Laksford Command Center, Google-Sheet source.
// Reads your "Internal Revenue & Margin Tracker" straight from published-to-web
// CSV(s) instead of the Walmart Marketplace API. Drop-in replacement for
// walmart.js: same JSON shape, same passcode gate.
//
// Environment variables (set in Netlify → Site settings → Environment variables):
//   SHEET_CSV_URLS     — one or more "Publish to web → CSV" links, comma-separated.
//                        One link per tab you want counted (e.g. the March/Apr/May/June tabs,
//                        or a single consolidated feed tab).
//   DASHBOARD_PASSWORD — the passcode required to view the dashboard (unchanged).
//
// Returns: { newOrdersThisMonth, monthlyGMV, yearlyGMV, yearlyOrders,
//            netRevenue, currency, lastUpdated, source }

// --- CSV parsing -----------------------------------------------------------

// Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
// escaped double-quotes ("") and \r\n line endings.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c === "\r") {
      // ignore; handled by \n
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s) => (s == null ? "" : String(s)).trim().toLowerCase();

// Find the header row: the first row that names the Walmart Order ID column.
function findHeaderIndex(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((c) => norm(c).includes("walmart order id"))) return i;
  }
  return -1;
}

// Locate a column by trying header-text candidates (exact, then contains).
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

// Parse a leading YYYY-MM-DD out of a Date cell. Returns a Date (UTC) or null.
function parseRowDate(v) {
  const m = String(v || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

// Turn one CSV tab into an array of { date, gmv, net } order records.
function extractOrders(csvText) {
  const rows = parseCSV(csvText);
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
    const row = rows[r];
    // Stop-ish guards: skip Total/summary rows and blank lines.
    const firstFew = norm(row.slice(0, 4).join(" "));
    if (firstFew.includes("total")) continue;

    const d = parseRowDate(row[iDate]);
    if (!d) continue; // only real, dated order lines count

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

// Exposed for local unit testing (harmless in production).
exports._test = { parseCSV, extractOrders, findHeaderIndex, colIndex };

// --- handler ---------------------------------------------------------------

exports.handler = async (event) => {
  const okPw = process.env.DASHBOARD_PASSWORD;
  const given = (event.queryStringParameters && event.queryStringParameters.key) || "";
  if (!okPw || given !== okPw) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }

  const raw = process.env.SHEET_CSV_URLS;
  if (!raw) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "missing_config",
        hint: "Set SHEET_CSV_URLS in Netlify env vars to your Publish-to-web CSV link(s), comma-separated.",
      }),
    };
  }

  const urls = raw.split(",").map((s) => s.trim()).filter(Boolean);

  try {
    let orders = [];
    for (const url of urls) {
      const res = await fetch(url, { headers: { Accept: "text/csv" } });
      if (!res.ok) {
        throw new Error(`csv_fetch_${res.status} for ${url.slice(0, 80)}`);
      }
      const text = await res.text();
      orders = orders.concat(extractOrders(text));
    }

    // De-duplicate by order id when an id is present (in case tabs overlap).
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

    let yearlyGMV = 0, monthlyGMV = 0, netRevenue = 0;
    let yearlyOrders = 0, newOrdersThisMonth = 0;

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
        source: "google-sheet",
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
