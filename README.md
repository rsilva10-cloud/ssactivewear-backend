# S&S Activewear Backend

Proxies PO Control's requests to S&S Activewear's REST API (v2), so the API key stays out of the browser. Same role as `lat-backend` and `stanley-stella-backend`.

| Route | S&S call | What it returns |
|---|---|---|
| `GET /api/ssactivewear/products?style=` | `GET /v2/products/?style=` | Per SKU: your price, stock in every S&S warehouse, incoming stock. `style` can be a name ("Gildan 5000"), part number ("00760"), or style ID; comma-separate several. |
| `GET /api/ssactivewear/products?sku=` | `GET /v2/products/{skus}` | Same, for specific SKUs (S&S SKU, GTIN, or SKU ID), comma-separated. |

Optional on either: `warehouses=IL,NV` (limit warehouses), `fields=Sku,Qty,CustomerPrice` (trim the reply), `raw=1` (S&S's untouched reply, for debugging).

It deliberately refuses to run without a style or SKU: the full S&S catalog is enormous.

### Orders (these move real money)

| Route | S&S call | Purpose |
|---|---|---|
| `POST /api/ssactivewear/orders` | `POST /v2/orders/` | Place an order. Body: `poNumber`, `shippingAddress`, `shippingMethod`, `lines: [{ sku, qty }]`, optional `warehouses`, `preference` (`fewest`/`fastest`), `emailConfirmation`, `shipByDate`, `testOrder`, `dryRun`. |
| `GET /api/ssactivewear/orders?po=` | `GET /v2/orders/{po}` | Orders carrying exactly this PO number (used for the duplicate check). |
| `DELETE /api/ssactivewear/orders/:orderNumber` | `DELETE /v2/orders/{n}` | Cancel. S&S allows this for **10 minutes** after placing. |
| `GET /api/ssactivewear/shipping-methods` | none | The 17 shipping methods S&S documents. |

Safeguards, all tested:
- **`dryRun: true`** returns the exact request S&S would receive and sends nothing.
- **`testOrder: true`** is S&S's own test mode ("created and cancelled"), a safe way to check stock, prices, and the real shipping cost.
- A **real order is refused if S&S already has an active order with the same PO number**. Cancelled orders (e.g. from a test) don't count. If that check can't be completed, the order is **not** sent.
- Orders are **all-or-nothing** (`rejectLineErrors` stays true): a line S&S can't fill rejects the whole order.
- If S&S doesn't answer after a real order is sent, the reply says the order **may have gone through** and to check by PO before resending (a second send is blocked while an active order exists).
- Everything is validated first with plain-language messages. Failures map to distinct statuses: 400 your input, 409 duplicate PO, 422 S&S rejected it, 502 S&S unreachable or an odd reply.

Not built: paying with a saved card (`paymentProfile`); orders go on the account's normal terms. The duplicate check sees orders that haven't been invoiced yet (S&S's default), which covers accidental double-sends; a PO reused after an order was invoiced isn't caught.

All routes except `/api/health` need a PO Control login token.

## Environment variables (set on Render)

- `SSACTIVEWEAR_ACCOUNT_NUMBER` — your S&S account number (S&S's "username")
- `SSACTIVEWEAR_API_KEY` — your S&S API key (S&S's "password"); get it from My Account on ssactivewear.com or from your rep
- `SESSION_SECRET` — must match `po-history-backend` exactly
- `ALLOWED_ORIGINS` — optional
- `SSACTIVEWEAR_BASE_URL` — optional, defaults to `https://api.ssactivewear.com/v2`

## Before it will show your price

S&S only returns your contracted price (`customerPrice`) if **"API customer pricing"** is enabled on your account. Without it that field comes back empty, and the service says so in a `notes` entry. Ask your S&S rep to enable it when you request the key.

## What was verified, and what wasn't

Verified from S&S's published docs, including a full sample reply: field names, the filters above, the 404 reply shape, and Basic auth. The service was tested end to end against a mock S&S server built from that sample (auth header, URL encoding exactly as S&S documents it, error handling, timeouts, and that the API key never appears in any response or log). The docs read were S&S's Canadian mirror, which documents the same v2 fields as the US API.

Not verified until a real reply is seen:
- The format of `expectedInventory` (incoming stock) beyond `EnRoute:None|OnOrder:None`. It is passed through untouched, not parsed.
- Whether `fields=` can select the warehouse list. Leave `fields` off unless testing.
- Your account's warehouse list and whether customer pricing is enabled.

Order placement follows S&S's published POST/GET/DELETE Orders pages and was tested against a mock S&S server, not the live one. Use test orders first: S&S creates and cancels them.
