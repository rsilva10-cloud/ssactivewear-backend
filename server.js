require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { requireAuth } = require("./sessionAuth");
const { getProducts } = require("./client");

const app = express();

// Same safety net as the other backends.
process.on("unhandledRejection", (err) => console.error("Unhandled rejection (server kept running):", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception (server kept running):", err));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: allowedOrigins.includes("*") ? true : allowedOrigins }));

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

const port = process.env.PORT || 3007;
app.listen(port, () => console.log(`S&S Activewear backend listening on :${port}`));
