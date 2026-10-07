require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { requireAuth } = require("./sessionAuth");
const { getProducts } = require("./client");
const { placeOrder, getOrdersByPo, cancelOrder, SHIPPING_METHODS } = require("./orders");

const app = express();

// Same safety net as the other backends.
process.on("unhandledRejection", (err) => console.error("Unhandled rejection (server kept running):", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception (server kept running):", err));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: allowedOrigins.includes("*") ? true : allowedOrigins }));

app.use(express.json({ limit: "100kb" }));
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "That request wasn't valid JSON." });
  next(err);
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

const csv = (v, max = 100) =>
  typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim().slice(0, 64)).filter(Boolean).slice(0, max) : undefined;

// Stock, your price, and incoming stock for specific products. Ask by
// ?style= (e.g. "Gildan 5000", "00760") and/or ?sku= (comma-separated S&S
// SKUs, GTINs, or SKU IDs). Optional: ?warehouses=IL,NV to limit warehouses,
// ?fields=... to trim the reply, ?raw=1 for S&S's untouched reply.
// Only the error message is ever logged or returned — never the request
// headers, which hold the API key.
app.get("/api/ssactivewear/products", requireAuth, async (req, res) => {
  try {
    const style = typeof req.query.style === "string" && req.query.style.trim() ? req.query.style.trim().slice(0, 200) : undefined;
    const result = await getProducts(
      { style, skus: csv(req.query.sku), warehouses: csv(req.query.warehouses, 30), fields: csv(req.query.fields, 60) },
      { raw: req.query.raw === "1" }
    );
    res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("S&S request failed:", err.message);
    res.status(502).json({ error: err.message || "S&S request failed" });
  }
});

// ---------- Orders (these move real money; see orders.js) ----------

// Maps each kind of failure to a status the screen can explain:
// 400 = your input, 409 = a duplicate PO, 422 = S&S rejected it,
// 502 = S&S couldn't be reached or answered oddly. Only messages are logged
// or returned — never the request body or headers.
const orderRoute = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error("S&S order request failed:", err.message);
    res.status(status).json({
      error: err.message || "S&S order request failed",
      ...(err.details ? { details: err.details } : {}),
      ...(err.existing ? { existing: err.existing } : {}),
      ...(err.unknownOutcome ? { unknownOutcome: true } : {}),
    });
  }
};

// The shipping methods S&S documents, for the order screen's dropdown.
app.get("/api/ssactivewear/shipping-methods", requireAuth, (req, res) => res.json({ methods: SHIPPING_METHODS }));

// Place an order. Body: { poNumber, shippingAddress, shippingMethod, lines: [{ sku, qty }],
// warehouses?, preference?, emailConfirmation?, shipByDate?, testOrder?, dryRun? }.
// dryRun:true returns the exact request S&S would get and sends nothing.
// testOrder:true uses S&S's own test mode (created and cancelled).
app.post("/api/ssactivewear/orders", requireAuth, orderRoute((req) => placeOrder(req.body, { dryRun: req.body && req.body.dryRun === true })));

// Look up S&S orders by exact PO number (also used for the duplicate check).
app.get("/api/ssactivewear/orders", requireAuth, orderRoute((req) => getOrdersByPo(req.query.po)));

// Cancel an order — S&S only allows this for 10 minutes after placing.
app.delete("/api/ssactivewear/orders/:orderNumber", requireAuth, orderRoute((req) => cancelOrder(req.params.orderNumber)));

const port = process.env.PORT || 3007;
app.listen(port, () => console.log(`S&S Activewear backend listening on :${port}`));
