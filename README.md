# VELUNE

A premium, mobile-first, multi-category storefront with an operations dashboard. Built as a **zero-dependency Node.js application** — no framework, no build step, no npm install required.

Brand direction: warm ivory, ink, forest and brass; Fraunces display type with Inter for interface text; deliberately compact product cards rather than oversized marketplace tiles.

---

## Quick start

Requirements: **Node.js 20 or newer**.

```bash
node server.js
# or
npm start
```

Open:

- Storefront — <http://localhost:3000>
- Shop — <http://localhost:3000/shop>
- Checkout — <http://localhost:3000/checkout>
- Account — <http://localhost:3000/account>
- Contact & support — <http://localhost:3000/contact>
- Order tracking — <http://localhost:3000/order>
- Admin — <http://localhost:3000/admin>

Admin sign-in: username **`admin`** with the password stored as a scrypt hash in `data/db.json`. Sign in at <http://localhost:3000/admin>.

For a fixed password or deployment override, set environment variables before starting the server:

```bash
ADMIN_USERNAME="admin" ADMIN_PASSWORD="your-strong-password" ADMIN_SECRET="a-long-random-secret" SESSION_SECRET="another-long-random-secret" SITE_URL="https://your-domain.com" node server.js
```

On Windows PowerShell:

```powershell
$env:ADMIN_USERNAME="admin"; $env:ADMIN_PASSWORD="your-strong-password"; $env:ADMIN_SECRET="a-long-random-secret"; $env:SESSION_SECRET="another-long-random-secret"; $env:SITE_URL="https://your-domain.com"; node server.js
```

If no password is stored and `ADMIN_PASSWORD` is not set, the server generates a one-time password on first start and prints it to the console. `ADMIN_PASSWORD_HASH` (a `scrypt$salt$hash` string) is accepted for production so the plain password never appears in configuration.

If `node` is not on PATH in the Qoder desktop shell, this workspace can run with the bundled runtime:

```bash
ELECTRON_RUN_AS_NODE=1 "C:/Users/margalla/AppData/Local/Programs/Qoder/Qoder.exe" server.js
```

The server binds to port `3000` by default and prints the admin username and password source on startup.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `ADMIN_USERNAME` | `admin` | Username for the admin login |
| `ADMIN_PASSWORD` | — (stored hash is used) | Plain-text admin password, taken at startup when set. Prefer `ADMIN_PASSWORD_HASH` so the password never sits in configuration. |
| `ADMIN_PASSWORD_HASH` | hash in `data/db.json` | `scrypt$salt$hash` string for the admin login |
| `ADMIN_SECRET` | random per process | HMAC key for admin session tokens. Set this in production, otherwise restarting the server invalidates sessions. |
| `SESSION_SECRET` | random per install | HMAC key for customer session cookies. When unset, a random secret is generated once and stored in `data/db.json`, so customer sessions survive restarts. Set it in production and keep it private. |
| `SITE_URL` | request origin | Absolute base URL used in canonical tags, Open Graph tags, `sitemap.xml` and the origin check |
| `NODE_ENV` | development | `production` enables request logging and suppresses the default-secret warning |

> The server is HTTP. In production, terminate TLS at a reverse proxy (Caddy, nginx, Cloudflare, your host) and add HSTS there.

Support channels start with `support@velune.store`; WhatsApp and Telegram stay hidden until you add them under **Admin → Settings**. The same screen controls support hours, response wording and the announcement bar. Open registration is enabled by default.

---

## What is included

### Storefront

- Mobile-first responsive layout; compact four-column desktop and two-column mobile product grids.
- Home page with editorial hero, admin-managed category tiles, curated new arrivals and material story. A category appears on the home rail once it contains a product.
- Shop page with admin-managed category chips, price filter, sorting, live result counts and empty states.
- Desktop nav, mobile menu, footer and shop filters update from the categories managed in the admin dashboard.
- Search overlay across product names, categories and descriptions.
- Product detail pages with variants, quantity limits, stock states, sale prices, details/specs/care accordions, related products and a sticky add-to-bag bar.
- Cart drawer stored in `localStorage` (`velune.cart.v1`), with quantity controls, remove, free-shipping progress and a quick-add button on product cards.
- Guest checkout with US address validation, standard/express delivery, promo codes and a server-calculated summary. Checkout is reachable from the desktop header, the mobile menu, the footer and the bag drawer.
- Customer accounts: register, sign in, sign out, view linked orders, update profile details, change password and revoke other sessions. Passwords are hashed with scrypt; sessions are signed, HttpOnly cookies.
- Signed-in checkout prefills contact details and links new orders to the account. Order history only shows orders explicitly linked while signed in — never guest orders matched by an unverified email address.
- Contact page with email and optional WhatsApp and Telegram channels, support hours and response expectations, plus a support form that creates a ticket in the admin dashboard.
- **Cash on delivery** — checkout sends an order request and collects payment when the order arrives. No card fields, no card data, no charge. When a WhatsApp number is set in Settings, the confirmation page offers a one-tap WhatsApp confirmation with the order details prefilled. See limitations below.
- Order confirmation with a private access token, plus order lookup by order number + email.
- Policies page covering shipping, returns, privacy, terms, accessibility and contact. Privacy text covers account data, hashed passwords and session cookies.
- Scripted support chat that can open a local support ticket; newsletter signup.
- 404 page, favicon, self-hosted fonts and responsive 400/800px product imagery.

### Admin dashboard (`/admin`)

- Username + password login (scrypt-verified, timing-safe); HMAC-signed bearer token, stored in `sessionStorage`, valid for 12 hours.
- Overview: 30-day revenue/orders/AOV, all-time counts, registered customers, low stock, open tickets, subscribers, recent orders and most-requested products.
- Orders: search, status filter, order detail modal, status timeline, tracking number, cancellation that restocks items.
- Products: search/filter, create, edit, delete, image preview, stock and pricing controls, details/specs/variants editing, and image upload (JPEG, PNG or WebP up to 5 MB).
- Customers: registered account list with order counts and lifetime value; delete an account while keeping its orders for records.
- Support: open/resolved filters, ticket subject and customer name, and ticket status updates.
- Settings: support email, WhatsApp number, Telegram username, support hours, response time and announcement bar. Storefront links update on the next page load. Categories can be added, renamed and deleted (with in-use and last-category guards).
- Subscribers: searchable list and copy-all action.
- Responsive off-canvas navigation and mobile-friendly modals.

### SEO and metadata

- Server-rendered titles, descriptions, canonicals, Open Graph tags and robots directives.
- Product JSON-LD and organization JSON-LD (`Product`, `Offer`, `AggregateRating`, `BreadcrumbList`).
- Dynamic `sitemap.xml` and `robots.txt`.
- ETag and cache headers for static assets; long-lived caching for images and fonts.

### Security

- CSP, `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, Permissions Policy and COOP headers.
- Admin tokens signed with HMAC-SHA256 and compared in constant time; login key compared with `timingSafeEqual`.
- Customer passwords hashed with scrypt and a per-user salt. Customer sessions use signed, expiring tokens in HttpOnly, SameSite=Lax cookies; `Secure` is added when the request is HTTPS or `SITE_URL` starts with `https://`.
- Password changes increment a session version, which invalidates existing cookies on other devices.
- Origin checks on state-changing API requests; per-IP rate limits on login, registration, password changes, order creation, order lookup, promo checks, tickets and newsletter.
- JSON content-type enforcement, request-size caps, input clamping and HTML escaping.
- Server-side price, stock and promo recalculation; idempotency keys prevent duplicate orders.
- Uploaded images are validated by MIME type and magic bytes, capped at 5 MB and written with random filenames.
- Account order history is scoped to orders explicitly linked to the account, so an unverified email address cannot expose someone else's orders.
- Path traversal protection on static file serving.
- No card data is collected, transmitted or stored in this build.

---

## Promo codes

| Code | Effect |
| --- | --- |
| `WELCOME10` | 10% off merchandise |
| `FREESHIP` | Free standard shipping (express stays $18) |

Shipping: standard **$8** (free on merchandise of **$150+** after discounts), express **$18**. Tax is currently a $0 line — no tax engine is connected.

---

## Project structure

```
server.js                 HTTP server, APIs, SSR, security, persistence
package.json              zero-dependency scripts (`start`, `dev`)
data/seed.json            products, categories and brand copy
data/db.json              created on first run; orders, customers, settings, tickets, subscribers, live stock
views/                    HTML templates with token replacement and partials
  partials/header.html    nav, search overlay, cart drawer, chat, toasts
  partials/footer.html    footer, contact channels, script loading
  account.html            customer sign-in, registration and account dashboard
  contact.html            support channels and contact form
public/css/               storefront + admin design systems
public/js/                app shell, home, shop, product, checkout, order, account, contact, admin
public/images/            responsive product and editorial imagery
public/images/uploads/    admin-uploaded product images (created on first upload)
public/fonts/             self-hosted Fraunces + Inter woff2 files
vibe_images/              original generated source images (not served)
```

The server renders pages from `views/` using `<!--@header-->` / `<!--@footer-->` partial includes and `{{TOKEN}}` replacements. Product pages are server-rendered so pricing and stock are present before JavaScript runs.

---

## Data, uploads and backup

The first start copies `data/seed.json` into `data/db.json`. Orders, stock changes, customers, settings, tickets and subscribers are written to `data/db.json` using a serialized queue and an atomic temp-file rename. Admin-uploaded images are written to `public/images/uploads/` with random filenames.

To reset the store:

1. Stop the server.
2. Delete `data/db.json` and, if desired, the files in `public/images/uploads/`.
3. Start the server again — it reseeds automatically. On first start with no stored admin password it generates a one-time password and prints it to the console.

To back up or move the store, stop the server and copy both `data/db.json` and `public/images/uploads/`. To restore, put them back and restart. This file store is intended for a single-instance deployment; use a managed database and object storage before multi-instance or high-traffic production use.

The customer session secret and the admin password hash are stored in `data/db.json`. Treat `db.json` as a secret and never publish it or commit it to a public repository.

---

## API summary

Public:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health check |
| GET | `/api/products` | Catalog |
| GET | `/api/products/:slug` | Product + related items |
| GET | `/api/shipping` | Methods, threshold, US states |
| POST | `/api/promo` | Validate a promo code |
| POST | `/api/orders` | Create a cash-on-delivery order with server-calculated totals |
| POST | `/api/orders/lookup` | Find an order with number + email |
| GET | `/api/orders/:number?token=…` | Read an order with its private token |
| POST | `/api/newsletter` | Newsletter signup |
| POST | `/api/support/ticket` | Create a support ticket from the contact form or chat widget |
| POST | `/api/auth/register` | Create a customer account and start a session |
| POST | `/api/auth/login` | Sign in and receive an HttpOnly session cookie |
| POST | `/api/auth/logout` | Clear the customer session |
| GET | `/api/auth/session` | Current signed-in customer, or `null` |
| GET | `/api/account/orders` | Orders linked to the signed-in account |
| PATCH | `/api/account` | Update profile name, phone or marketing preference |
| POST | `/api/account/password` | Change password and invalidate other sessions |

Admin (except login, require `Authorization: Bearer <token>`):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/admin/login` | Sign in with username + password for a 12-hour token |
| GET | `/api/admin/overview` | KPIs and dashboard panels |
| GET | `/api/admin/orders` | All orders |
| PATCH | `/api/admin/orders/:number` | Update status and tracking (cancel restocks) |
| GET/POST | `/api/admin/products` | List / create products |
| PATCH/DELETE | `/api/admin/products/:slug` | Update / delete a product |
| POST | `/api/admin/uploads` | Upload a validated JPEG/PNG/WebP image (base64 JSON, max 5 MB) |
| GET | `/api/admin/customers` | List registered customers with order counts and spend |
| DELETE | `/api/admin/customers/:id` | Delete an account, keeping its orders |
| GET/PATCH | `/api/admin/settings` | Read or update support channels and storefront messaging |
| POST | `/api/admin/categories` | Create a category |
| PATCH/DELETE | `/api/admin/categories/:slug` | Rename or delete a category |
| GET | `/api/admin/tickets` | Support tickets |
| PATCH | `/api/admin/tickets/:id` | Resolve or reopen a ticket |
| GET | `/api/admin/subscribers` | Newsletter subscribers |

---

## Verification performed

On **22 October 2026** the build was exercised through API requests and Chrome DevTools device emulation at **390×844** and **1440×1200**:

- Home, shop, product, account, contact, checkout, policies, 404 and admin pages render without horizontal overflow at 390px; `document.scrollWidth` equaled the viewport on every page.
- Shop uses a genuine two-column mobile grid; desktop uses four compact columns.
- Product variants and quantity selection update correctly; related products render.
- Cart persists across pages, drawer totals are correct, and the drawer no longer collides with transient toasts.
- Checkout applies `WELCOME10` and recalculates to the expected total; `$345 → $310.50`.
- Registration, session restore, profile update, password change, forced sign-out of the old cookie and logout all worked through the API and account UI.
- A signed-in checkout prefilled contact details, created a linked order and showed that order in account history.
- A real cash-on-delivery order placed through the UI produced an order number and private token, rendered the confirmation page, decremented stock and could be found again with order number + email.
- A guest order placed with an email address was **not** disclosed to a new account registered with the same unverified address.
- Contact form created a support ticket; saved WhatsApp and Telegram settings rendered as links on the storefront, and the approval/validation paths returned the expected status codes.
- Admin image upload accepted a JPEG and rejected a MIME/magic-byte mismatch; a product created through the admin UI appeared on the storefront and could be deleted.
- Admin customers, settings, category add/rename/delete and in-use category protection were exercised.
- A category created in the admin dashboard appeared in desktop navigation, the mobile menu, footer and shop filter; after assigning a product it also appeared on the home category rail. Deep-linked category filters selected the right product and revealed the active chip on mobile.
- Admin login, overview, orders, products, order detail, status update to “Packed” and tracking save all worked through the UI.
- Invalid admin access and public access to admin endpoints returned 401; a state-changing request with a foreign `Origin` returned 403.
- No runtime exceptions or malformed asset requests were observed in the browser console during the tested pages.
- Syntax checks passed for `server.js` and all storefront/admin JavaScript.

These were delivery-time checks, not a persistent CI suite. No production Core Web Vitals measurement has been performed; the app ships SSR, preloaded fonts, responsive images and cache headers to support the targets in the brief, but LCP/INP/CLS must be measured on the deployed origin.

---

## Included in this build vs. not included

**Included (code and assets in this folder):**

- Complete storefront, cart, cash-on-delivery checkout, order tracking and policies.
- Customer accounts with registration, sign-in, order history, profile updates and password changes.
- Contact page with configurable email, WhatsApp and Telegram channels plus an admin ticket queue.
- Admin dashboard with username/password sign-in, order, product (including image upload), customer, category, settings, ticket and subscriber management.
- Local JSON persistence, seeded catalog, responsive imagery and documentation.
- Security headers, rate limits, signed admin and customer sessions and server-side validation.
- Full source ownership; no runtime npm dependencies.

**Not included / requires third-party services or production accounts:**

- **Online card payments.** Checkout is cash on delivery on purpose: no card fields, no card data, no charge. Accepting online payments later requires a verified payment provider (for example Stripe or Shopify Payments), business eligibility, PCI/compliance review, webhooks and refund handling. Merchant and transaction fees are separate.
- **Fulfillment and supplier integration.** Orders are stored locally; they are not transmitted to a warehouse, dropshipper, carrier or label printer. Fulfilment is coordinated manually from the admin dashboard.
- **Tax calculation.** Tax currently shows $0. A tax engine or provider is required for US sales tax.
- **Transactional email/SMS.** No order confirmations, shipping notices, email verification or password-reset emails are sent. The contact form and account help route to client care instead. An email provider and domain authentication are required for those flows.
- **Carrier tracking.** Tracking numbers can be stored and displayed, but no carrier API status is fetched.
- **Real analytics/tag manager.** No GA4, Meta Pixel or consent banner is installed. Admin KPIs come from local orders only. Add an analytics/consent stack before launch.
- **24/7 human support.** The chat is scripted and opens a local ticket. WhatsApp and Telegram links only work once configured in Settings and require a real business account. A live human desk requires staffing and a helpdesk provider.
- **Wishlists, reviews and loyalty features.** Not included.
- **International shipping and multi-currency.** US addresses and USD only.
- **Durable production authentication.** Admin is a single username/password, not individual admin accounts, roles, MFA or SSO. Customer accounts are included, but production deployment should add email verification and a managed identity/audit layer before high-risk use.
- **Managed database, backups, monitoring and CDN/hosting.** Production infrastructure, domain, TLS and ongoing operations are separate costs.
- **Legal review.** Policies are written for this store's cash-on-delivery operation and should be reviewed by a qualified attorney for your jurisdiction.
- **Asset licensing review.** Fraunces and Inter are distributed under the SIL Open Font License; keep their license notices. Product and editorial imagery was generated for this project — confirm commercial usage rights for your launch.

---

## Performance measures in the build

- Server-rendered content with no client framework hydration.
- Self-hosted fonts with preload; no third-party font requests.
- 400px/800px responsive product images with `srcset`, explicit dimensions and lazy loading below the fold.
- CSS and JavaScript served as small static files with ETags; images cached for 7 days.
- No render-blocking third-party scripts, analytics or chat SDKs.
- Reduced-motion support and focus-visible styles.

For production, put the app behind a CDN/TLS proxy, compress responses, set HSTS, monitor availability and error rates, and measure Core Web Vitals from real users.
