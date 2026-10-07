# S&S Activewear Backend

Proxies PO Control's requests to S&S Activewear's REST API (v2), so the API key stays out of the browser. Same role as `lat-backend` and `stanley-stella-backend`.

| Route | S&S call | What it returns |
|---|---|---|
| `GET /api/ssactivewear/products?style=` | `GET /v2/products/?style=` | Per SKU: your price, stock in every S&S warehouse, incoming stock. `style` can be a name ("Gildan 5000"), part number ("00760"), or style ID; comma-separate several. |
| `GET /api/ssactivewear/products?sku=` | `GET /v2/products/{skus}` | Same, for specific SKUs (S&S SKU, GTIN, or SKU ID), comma-separated. |

Optional on either: `warehouses=IL,NV` (limit warehouses), `fields=Sku,Qty,CustomerPrice` (trim the reply), `raw=1` (S&S's untouched reply, for debugging).

It deliberately refuses to run without a style or SKU: the full S&S catalog is enormous.

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

Ordering (`POST /v2/orders`) exists in S&S's API but is not built here.
