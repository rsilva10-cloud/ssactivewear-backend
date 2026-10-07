/**
 * orders.js
 * ---------
 * Placing, looking up, and cancelling S&S Activewear orders. Field names and
 * rules follow S&S's published docs (POST/GET/DELETE Orders pages).
 *
 * This moves real money, so the design is defensive:
 *   - Everything is validated first, with plain-language messages.
 *   - dryRun builds the exact request S&S would receive and sends nothing.
 *   - testOrder is S&S's own flag: "Test Orders will be created and
 *     cancelled" — a safe way to check stock, prices, and shipping cost.
 *   - A real order is refused if S&S already has an ACTIVE order with the
 *     same PO number (cancelled ones, e.g. from a test, don't count). If that
 *     check can't be completed, the order is NOT sent.
 *   - rejectLineErrors stays at its default (true), so an order is placed in
 *     full or not at all — never a partial order nobody asked for.
 *   - S&S allows cancelling for 10 minutes after placing; see cancelOrder.
 *
 * Not built: paying with a saved card (paymentProfile) — orders go on the
 * account's normal terms.
 */

const { request, errorText, num, toArray } = require("./client");

// Documented shipping methods (US).
const SHIPPING_METHODS = {
  1: "Ground (S&S chooses the carrier)",
  54: "Cheapest ground (S&S chooses)",
  40: "UPS Ground",
  14: "FedEx Ground",
  3: "UPS 2nd Day Air",
  22: "UPS 2nd Day Air AM",
  16: "UPS 3 Day Select",
  2: "UPS Next Day Air",
  21: "UPS Next Day Air Saver",
  17: "UPS Next Day Air Early AM",
  26: "FedEx Next Day Priority",
  27: "FedEx Next Day Standard",
  48: "FedEx 2nd Day Air",
  19: "UPS Saturday",
  20: "UPS Saturday Early",
  6: "Will Call / pickup",
  8: "Messenger pickup",
};

const PREFERENCES = ["fewest", "fastest"];
const MAX_LINES = 200;
const MAX_QTY = 100000;

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** Checks an order from the app. Returns every problem at once, plus a cleaned copy. */
function validateOrder(input) {
  const i = input && typeof input === "object" ? input : {};
  const errors = [];

  const poNumber = str(i.poNumber);
  if (!poNumber) errors.push("A PO number is required.");
  else if (poNumber.length > 40) errors.push("The PO number is too long (40 characters at most).");
  else if (poNumber.includes(",")) errors.push("The PO number can't contain a comma.");

  const a = i.shippingAddress && typeof i.shippingAddress === "object" ? i.shippingAddress : {};
  const shippingAddress = {
    customer: str(a.customer),
    attn: str(a.attn),
    address: str(a.address),
    city: str(a.city),
    state: str(a.state).toUpperCase(),
    zip: str(a.zip),
    residential: a.residential === true,
  };
  if (!shippingAddress.address) errors.push("The ship-to street address is required.");
  if (!shippingAddress.city) errors.push("The ship-to city is required.");
  if (!/^[A-Z]{2}$/.test(shippingAddress.state)) errors.push("The ship-to state must be a 2-letter code, like IL.");
  if (!/^\d{5}$/.test(shippingAddress.zip)) errors.push("The ship-to ZIP must be 5 digits.");

  const shippingMethod = str(i.shippingMethod === undefined ? "1" : i.shippingMethod);
  if (!Object.prototype.hasOwnProperty.call(SHIPPING_METHODS, shippingMethod)) errors.push("That shipping method isn't one S&S offers.");

  const preference = str(i.preference === undefined ? "fewest" : i.preference).toLowerCase();
  if (!PREFERENCES.includes(preference)) errors.push('Warehouse preference must be "fewest" or "fastest".');

  const warehouses = [...new Set(toArray(i.warehouses).map((w) => str(w).toUpperCase()).filter(Boolean))];
  if (warehouses.some((w) => !/^[A-Z]{2}$/.test(w)) || warehouses.length > 15) errors.push("Warehouse codes must be 2 letters each (like IL).");

  const emailConfirmation = str(i.emailConfirmation);
  if (emailConfirmation && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(emailConfirmation)) errors.push("The confirmation email address doesn't look right.");

  const shipByDate = str(i.shipByDate);
  if (shipByDate && !/^\d{2}\/\d{2}\/\d{4}$/.test(shipByDate)) errors.push("Ship-by date must look like 11/01/2026.");

  const rawLines = toArray(i.lines);
  const lines = [];
  const seen = new Set();
  if (rawLines.length === 0) errors.push("Add at least one item to order.");
  if (rawLines.length > MAX_LINES) errors.push(`An order can have at most ${MAX_LINES} lines.`);
  rawLines.slice(0, MAX_LINES).forEach((l, n) => {
    const sku = str(l && l.sku);
    const qty = Number(l && l.qty);
    if (!sku) errors.push(`Line ${n + 1} has no SKU.`);
    else if (seen.has(sku)) errors.push(`SKU ${sku} is on the order more than once — combine the quantities.`);
    else seen.add(sku);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) errors.push(`${sku || `Line ${n + 1}`}: quantity must be a whole number from 1 to ${MAX_QTY.toLocaleString()}.`);
    lines.push({ sku, qty });
  });

  return {
    errors,
    clean: {
      poNumber,
      shippingAddress,
      shippingMethod,
      preference,
      warehouses,
      emailConfirmation,
      shipByDate,
      shipBlind: i.shipBlind === true,
      testOrder: i.testOrder === true,
      lines,
    },
  };
}

/** The exact body S&S receives. Property spellings are as S&S documents them. */
function buildPayload(c) {
  const payload = {
    shippingAddress: c.shippingAddress,
    shippingMethod: c.shippingMethod,
    shipBlind: c.shipBlind,
    poNumber: c.poNumber,
    emailConfirmation: c.emailConfirmation,
    testOrder: c.testOrder,
    // The app always lets S&S pick warehouses (optionally limited to some),
    // by "fewest shipments" or "fastest" — a per-line warehouse is ignored then.
    autoselectWarehouse: true,
    AutoSelectWarehouse_Preference: c.preference,
    rejectLineErrors: true, // all of the order or none of it
    lines: c.lines.map((l) => ({ identifier: l.sku, qty: l.qty })),
  };
  if (c.warehouses.length) payload.autoselectWarehouse_Warehouses = c.warehouses.join(",");
  if (c.shipByDate) payload.shipByDate = c.shipByDate;
  return payload;
}

function normalizeOrder(o) {
  const status = str(o.orderStatus);
  return {
    orderNumber: str(o.orderNumber) || null,
    poNumber: str(o.poNumber),
    warehouse: o.warehouseAbbr ?? null,
    status,
    cancelled: /^cancel/i.test(status),
    orderDate: o.orderDate ?? null,
    expectedDeliveryDate: o.expectedDeliveryDate ?? null,
    terms: o.terms ?? null,
    carrier: o.shippingCarrier ?? null,
    method: o.shippingMethod ?? null,
    dropship: o.dropship === true,
    subtotal: num(o.subtotal),
    shipping: num(o.shipping),
    tax: num(o.tax),
    total: num(o.total),
    pieces: num(o.totalPieces),
    weight: num(o.totalWeight),
    boxes: num(o.totalBoxes),
    items: toArray(o.lines).map((l) => ({
      sku: l.sku ?? null,
      qty: num(l.qtyOrdered),
      price: num(l.price),
      description: [l.brandName, l.styleName, l.colorName, l.sizeName].filter(Boolean).join(" "),
    })),
  };
}

const sumOf = (orders, key) => Math.round(orders.reduce((s, o) => s + (o[key] || 0), 0) * 100) / 100;
const totalsOf = (orders) => ({ subtotal: sumOf(orders, "subtotal"), shipping: sumOf(orders, "shipping"), tax: sumOf(orders, "tax"), total: sumOf(orders, "total"), pieces: orders.reduce((s, o) => s + (o.pieces || 0), 0) });

/** Existing S&S orders carrying exactly this PO number (cancelled ones included, flagged). */
async function findOrdersByPo(poNumber) {
  const reply = await request("GET", `/orders/${encodeURIComponent(poNumber)}`);
  if (reply.status === 404) return [];
  if (!reply.ok || !Array.isArray(reply.body)) {
    throw fail(502, `Couldn't check S&S for an existing order with PO ${poNumber} (HTTP ${reply.status}${errorText(reply.body) ? `: ${errorText(reply.body)}` : ""}). The order was not sent.`);
  }
  // The lookup matches PO *or* order/invoice number, so keep exact PO matches only.
  return reply.body.map(normalizeOrder).filter((o) => o.poNumber.toLowerCase() === poNumber.toLowerCase());
}

async function placeOrder(input, { dryRun = false } = {}) {
  const { errors, clean } = validateOrder(input);
  if (errors.length) throw fail(400, errors.join(" "), { details: errors });
  const payload = buildPayload(clean);
  if (dryRun) return { dryRun: true, testOrder: payload.testOrder, payload };

  if (!payload.testOrder) {
    const active = (await findOrdersByPo(clean.poNumber)).filter((o) => !o.cancelled);
    if (active.length) {
      throw fail(409, `S&S already has an active order with PO ${clean.poNumber} (order ${active.map((o) => o.orderNumber).join(", ")}). Nothing was sent. Use a different PO number if this is a new order.`, { existing: active });
    }
  }

  let reply;
  try {
    reply = await request("POST", "/orders/", { json: payload, timeoutMs: 90000 });
  } catch (err) {
    if (err.timeout && !payload.testOrder) {
      throw fail(502, `S&S didn't answer in time, so the order may have gone through. Check for PO ${clean.poNumber} before sending it again — a second send is blocked while an active order with that PO exists.`, { unknownOutcome: true });
    }
    throw fail(502, err.message);
  }

  if (reply.status === 400 || reply.status === 422) {
    throw fail(422, `S&S rejected the order: ${errorText(reply.body) || reply.text.slice(0, 200)}`, { details: toArray(reply.body && reply.body.errors) });
  }
  if (reply.status === 401 || reply.status === 403) throw fail(502, `S&S rejected the account number or API key (HTTP ${reply.status}).`);
  if (!reply.ok) throw fail(502, `S&S returned HTTP ${reply.status}${errorText(reply.body) ? `: ${errorText(reply.body)}` : ""}.`);
  if (!Array.isArray(reply.body) || reply.body.length === 0) throw fail(502, `S&S's reply wasn't a list of orders, so it isn't clear whether the order was placed. Check for PO ${clean.poNumber} before sending again.`, { unknownOutcome: true });

  const orders = reply.body.map(normalizeOrder);
  return { testOrder: payload.testOrder, placedAt: new Date().toISOString(), orders, totals: totalsOf(orders) };
}

async function getOrdersByPo(poNumber) {
  const po = str(poNumber);
  if (!po || po.includes(",")) throw fail(400, "Give one PO number (no commas).");
  const orders = await findOrdersByPo(po);
  return { orders };
}

/** S&S allows cancelling up to 10 minutes after an order is placed. */
async function cancelOrder(orderNumber) {
  const n = str(orderNumber);
  if (!/^\d{1,20}$/.test(n)) throw fail(400, "That doesn't look like an S&S order number.");
  const reply = await request("DELETE", `/orders/${n}`);
  if (reply.status === 401 || reply.status === 403) throw fail(502, `S&S rejected the account number or API key (HTTP ${reply.status}).`);
  if (!reply.ok) throw fail(422, `S&S couldn't cancel order ${n}: ${errorText(reply.body) || `HTTP ${reply.status}`}. Orders can only be cancelled within 10 minutes of placing — after that, contact S&S.`);
  const cancelled = Array.isArray(reply.body) ? reply.body.map(normalizeOrder) : [];
  if (cancelled.length === 0) throw fail(422, `S&S didn't cancel order ${n}. Orders can only be cancelled within 10 minutes of placing — after that, contact S&S.`);
  return { cancelled };
}

module.exports = { SHIPPING_METHODS, validateOrder, buildPayload, normalizeOrder, placeOrder, getOrdersByPo, cancelOrder };
