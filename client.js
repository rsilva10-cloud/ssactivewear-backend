/**
 * client.js
 * ---------
 * S&S Activewear REST API (v2). Auth is HTTP Basic: username = your S&S
 * ACCOUNT NUMBER, password = your API KEY (from "My Account" on
 * ssactivewear.com, or from your S&S rep).
 *
 * One endpoint does the job: GET /v2/products/. Each product row carries
 * your price (customerPrice), stock in every S&S warehouse, and an
 * expectedInventory string for incoming stock — so there's no separate
 * inventory or pricing call.
 *
 * Verified from S&S's published docs (the Products page, including a full
 * sample reply): field names, the filters used below (?style=, ?Warehouses=,
 * ?fields=, SKU lists in the path), the 404 reply shape, and the Basic-auth
 * rule. The docs read were S&S's Canadian mirror, which documents the same
 * v2 fields as the US API.
 *
 * NOT verified until a real reply is seen:
 *   - the exact format of expectedInventory beyond "EnRoute:None|OnOrder:None"
 *     (it's passed through untouched, never guessed at);
 *   - whether ?fields= can select the warehouses list (so it's opt-in only);
 *   - that your account has "API customer pricing" enabled. Without it,
 *     customerPrice comes back empty — a note is added when that happens.
 *
 * Never put the Authorization header in an error message or log: it's the
 * API key.
 */

const DEFAULT_BASE_URL = "https://api.ssactivewear.com/v2";
const baseUrl = () => (process.env.SSACTIVEWEAR_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

function requireEnv(name) {
  const v = (process.env[name] || "").trim(); // trimmed: stray pasted whitespace breaks auth
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function authHeader() {
  const account = requireEnv("SSACTIVEWEAR_ACCOUNT_NUMBER");
  const key = requireEnv("SSACTIVEWEAR_API_KEY");
  return "Basic " + Buffer.from(`${account}:${key}`).toString("base64");
}

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// Each list item is encoded separately and joined with literal commas, the
// way S&S's docs show it (e.g. ?style=00760,Gildan%205000).
const list = (items) => items.map((s) => encodeURIComponent(s)).join(",");

function buildPath({ style, skus, warehouses, fields }) {
  const hasSkus = Array.isArray(skus) && skus.length > 0;
  if (!hasSkus && !style) {
    // Deliberate: S&S's full catalog is enormous. Always ask about something specific.
    throw Object.assign(new Error("Give a style or one or more SKUs — the full S&S catalog is too large to pull in one call."), { status: 400 });
  }
  const query = [];
  if (style) query.push(`style=${list(String(style).split(",").map((s) => s.trim()).filter(Boolean))}`);
  if (warehouses && warehouses.length) query.push(`Warehouses=${list(warehouses)}`);
  if (fields && fields.length) query.push(`fields=${list(fields)}`);
  return `/products/${hasSkus ? list(skus) : ""}${query.length ? `?${query.join("&")}` : ""}`;
}

async function get(path, { timeoutMs = 60000 } = {}) {
  let res;
  try {
    res = await fetch(baseUrl() + path, {
      headers: { Authorization: authHeader(), Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") throw new Error(`S&S didn't respond within ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(`Couldn't reach S&S: ${err.cause?.code || err.message}`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, ok: res.ok, text, body };
}

// S&S reports problems as { errors: [{ field, message }] }.
const errorText = (body) => (body && Array.isArray(body.errors) ? body.errors.map((e) => (e.field ? `${e.field}: ` : "") + e.message).join("; ") : null);

function normalizeProduct(p) {
  const warehouses = toArray(p.warehouses).map((w) => ({
    abbr: w.warehouseAbbr ?? null,
    qty: num(w.qty) ?? 0,
    closeout: w.closeout === true,
    dropship: w.dropship === true,
    fullCaseOnly: w.fullCaseOnly === true,
    // Incoming stock, exactly as S&S sends it. Format confirmed only for
    // the "None" case, so it is not parsed yet.
    expectedInventory: w.expectedInventory ?? null,
  }));
  return {
    sku: p.sku ?? null,
    gtin: p.gtin ?? null,
    skuIdMaster: p.skuID_Master ?? null,
    styleId: p.styleID ?? null,
    brand: p.brandName ?? null,
    styleName: p.styleName ?? null,
    color: p.colorName ?? null,
    size: p.sizeName ?? null,
    caseQty: num(p.caseQty),
    prices: {
      piece: num(p.piecePrice),
      dozen: num(p.dozenPrice),
      case: num(p.casePrice),
      sale: num(p.salePrice),
      customer: num(p.customerPrice), // YOUR price; only filled if API customer pricing is enabled
      saleExpiration: p.saleExpiration || null,
    },
    qty: num(p.qty) ?? (warehouses.length ? warehouses.reduce((s, w) => s + w.qty, 0) : null),
    warehouses,
  };
}

function summarize(items) {
  const notes = [];
  // Only when prices came back at all (a ?fields= trim may have left them out)
  // but none of them is YOUR price.
  if (items.length && items.some((i) => i.prices.piece != null) && items.every((i) => !i.prices.customer)) {
    notes.push("No customer price came back on any item. S&S only returns your contracted price when \"API customer pricing\" is enabled on your account — ask your S&S rep to turn it on.");
  }
  return { count: items.length, warehouseCodes: [...new Set(items.flatMap((i) => i.warehouses.map((w) => w.abbr)).filter(Boolean))].sort(), notes };
}

/**
 * Look up products by style ("Gildan 5000", "00760", a styleID) and/or by SKU
 * list. { raw: true } returns S&S's reply text untouched, for debugging.
 */
async function getProducts(args, { raw = false, timeoutMs } = {}) {
  const reply = await get(buildPath(args), { timeoutMs });
  if (raw) return { status: reply.status, raw: reply.text };

  if (reply.status === 401 || reply.status === 403) {
    throw new Error(`S&S rejected the account number or API key (HTTP ${reply.status})${errorText(reply.body) ? `: ${errorText(reply.body)}` : ""}`);
  }
  if (reply.status === 404) {
    // Nothing matched (or the item is discontinued) — an answer, not a failure.
    return { count: 0, items: [], warehouseCodes: [], notes: [], notFound: errorText(reply.body) || "Requested item(s) were not found or have been discontinued." };
  }
  if (reply.status === 429) throw new Error("S&S is rate-limiting requests (HTTP 429) — wait a minute and try again");
  if (!reply.ok) throw new Error(`S&S returned HTTP ${reply.status}${errorText(reply.body) ? `: ${errorText(reply.body)}` : `: ${reply.text.slice(0, 200)}`}`);
  if (!Array.isArray(reply.body)) throw new Error(`S&S's reply wasn't the expected list of products: ${reply.text.slice(0, 200)}`);

  const items = reply.body.map(normalizeProduct);
  return { ...summarize(items), items };
}

module.exports = { getProducts, _internal: { buildPath, normalizeProduct, summarize, authHeader } };
