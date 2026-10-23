import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const VIEWS_DIR = path.join(__dirname, 'views');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SEED_PATH = path.join(DATA_DIR, 'seed.json');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'images', 'uploads');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'velune_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const scryptAsync = promisify(crypto.scrypt);

const FREE_SHIPPING_THRESHOLD = 150;
const SHIPPING_METHODS = {
  standard: { label: 'Standard', price: 8, eta: '3–5 business days' },
  express: { label: 'Express', price: 18, eta: '1–2 business days' }
};
const PROMOS = {
  WELCOME10: { type: 'percent', value: 10, label: '10% off' },
  FREESHIP: { type: 'shipping', value: 100, label: 'Free standard shipping' }
};
const ORDER_STATUSES = ['Confirmed', 'Packed', 'Shipped', 'Delivered', 'Cancelled'];

const US_STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' '));

// ---------------------------------------------------------------- data layer

function defaultSettings() {
  return {
    supportEmail: 'support@velune.store',
    whatsapp: '',
    telegram: '',
    hours: 'Monday–Friday, 9am–5pm Pacific',
    responseTime: 'within one business day',
    announcement: 'Complimentary U.S. shipping over $150 · 30-day returns',
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    updatedAt: new Date().toISOString()
  };
}

function seedDatabase() {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  return {
    products: seed.products,
    categories: seed.categories,
    orders: [],
    tickets: [],
    subscribers: [],
    customers: [],
    settings: defaultSettings(),
    createdAt: new Date().toISOString()
  };
}

let db;
try {
  db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
} catch {
  db = seedDatabase();
}

// Existing databases predate customer accounts and editable settings.
// Fill only missing keys so products, orders and owner edits survive upgrades.
function ensureDbDefaults() {
  for (const key of ['products', 'categories', 'orders', 'tickets', 'subscribers', 'customers']) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  if (!db.settings || typeof db.settings !== 'object' || Array.isArray(db.settings)) db.settings = {};
  const defaults = defaultSettings();
  for (const [key, value] of Object.entries(defaults)) {
    if (db.settings[key] === undefined || db.settings[key] === null) db.settings[key] = value;
  }
  if (!db.settings.sessionSecret) db.settings.sessionSecret = defaults.sessionSecret;
  if (!db.settings.supportEmail) db.settings.supportEmail = defaults.supportEmail;
  if (!db.settings.announcement) db.settings.announcement = defaults.announcement;
  if (!db.settings.hours) db.settings.hours = defaults.hours;
  if (!db.settings.responseTime) db.settings.responseTime = defaults.responseTime;
  if (!db.settings.adminUsername) db.settings.adminUsername = ADMIN_USERNAME;
}

// Resolve the admin password hash: env overrides win, then the stored hash.
// On a brand-new database with no env override, generate a one-time password,
// store only its hash, and print it once so the owner can sign in and change it.
async function ensureAdminCredentials() {
  if (process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD) return;
  if (db.settings.adminPasswordHash) return;
  const generated = crypto.randomBytes(9).toString('base64url');
  db.settings.adminPasswordHash = await hashPassword(generated);
  db.settings.updatedAt = new Date().toISOString();
  await persist();
  console.log(`\n  One-time admin password generated: ${generated}`);
  console.log('  Sign in at /admin and save this password somewhere safe. It will not be shown again.\n');
}
ensureDbDefaults();

let writeQueue = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeQueue = writeQueue
    .then(async () => {
      await fsp.writeFile(`${DB_PATH}.tmp`, snapshot, 'utf8');
      await fsp.rename(`${DB_PATH}.tmp`, DB_PATH);
    })
    .catch((error) => console.error('[db] write failed:', error.message));
  return writeQueue;
}
await persist();

// ---------------------------------------------------------------- helpers

const now = () => new Date().toISOString();
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clampStr = (value, max) => String(value ?? '').trim().slice(0, max);
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
const slugify = (value) =>
  String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => htmlEscapes[char]);

class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function httpError(status, message, code) {
  return new HttpError(status, message, code);
}

function baseUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host || `localhost:${PORT}`}`;
}

// ---------------------------------------------------------------- HTTP utils

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Request-Id', crypto.randomUUID());
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendHtml(res, status, body, cache = 'no-cache') {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': cache
  });
  res.end(body);
}

async function readJson(req, limit = 1_000_000) {
  const type = req.headers['content-type'] || '';
  if (!type.includes('application/json')) throw httpError(415, 'Content-Type must be application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON body');
  }
}

const rateBuckets = new Map();
function rateLimit(req, bucket, limit, windowMs) {
  const ip = req.socket.remoteAddress || 'unknown';
  const key = `${bucket}:${ip}`;
  const time = Date.now();
  let entry = rateBuckets.get(key);
  if (!entry || entry.resetAt <= time) {
    entry = { count: 0, resetAt: time + windowMs };
    rateBuckets.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > limit) {
    const retry = Math.ceil((entry.resetAt - time) / 1000);
    throw httpError(429, `Too many requests. Try again in ${retry}s.`);
  }
}
setInterval(() => {
  const time = Date.now();
  for (const [key, entry] of rateBuckets) if (entry.resetAt <= time) rateBuckets.delete(key);
}, 60_000).unref();

// ---------------------------------------------------------------- auth

function signAdminToken() {
  const expires = Date.now() + 12 * 60 * 60 * 1000;
  const signature = crypto.createHmac('sha256', ADMIN_SECRET).update(String(expires)).digest('hex');
  return `${expires}.${signature}`;
}

function verifyAdminToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [expires, signature] = token.split('.');
  if (!/^\d+$/.test(expires) || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  if (Number(expires) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(expires).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function requireAdmin(req) {
  const direct = req.headers['x-velune-admin'] || '';
  const header = req.headers.authorization || '';
  const token = direct || (header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!verifyAdminToken(token)) throw httpError(401, 'Admin session expired. Sign in again.');
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw httpError(403, 'Request origin is not allowed.');
  }
  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwarded || req.headers.host || '';
  let siteHost = '';
  try {
    siteHost = process.env.SITE_URL ? new URL(process.env.SITE_URL).host : '';
  } catch {
    siteHost = '';
  }
  if (originHost !== requestHost && (!siteHost || originHost !== siteHost)) {
    throw httpError(403, 'Request origin is not allowed.');
  }
}

// ---------------------------------------------------------------- customer auth

const sessionSecret = () => process.env.SESSION_SECRET || db.settings.sessionSecret;

function parseCookies(req) {
  const output = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (!key) continue;
    try {
      output[key] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      output[key] = '';
    }
  }
  return output;
}

function customerCookie(req, token, maxAgeMs) {
  const secure =
    req.headers['x-forwarded-proto'] === 'https' || String(process.env.SITE_URL || '').startsWith('https://');
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    maxAgeMs / 1000
  )}${secure ? '; Secure' : ''}`;
}

function signCustomerToken(customer) {
  const expires = Date.now() + SESSION_TTL;
  const version = Number(customer.sessionVersion) || 1;
  const payload = `${customer.id}.${version}.${expires}`;
  const signature = crypto.createHmac('sha256', sessionSecret()).update(`customer:${payload}`).digest('hex');
  return `${payload}.${signature}`;
}

function verifyCustomerToken(token) {
  if (typeof token !== 'string') return null;
  const match = token.match(/^(cust_[a-f0-9]{16})\.(\d+)\.(\d{13})\.([a-f0-9]{64})$/);
  if (!match) return null;
  const [, id, version, expires, signature] = match;
  if (Number(expires) < Date.now()) return null;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(`customer:${id}.${version}.${expires}`).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch {
    return null;
  }
  const customer = db.customers.find((entry) => entry.id === id);
  if (!customer || (Number(customer.sessionVersion) || 1) !== Number(version)) return null;
  return customer;
}

function currentCustomer(req) {
  const headerToken = req.headers['x-velune-customer'];
  return verifyCustomerToken(headerToken || parseCookies(req)[SESSION_COOKIE]);
}

function requireCustomer(req) {
  const customer = currentCustomer(req);
  if (!customer) throw httpError(401, 'Please sign in to continue.');
  return customer;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (!salt.length || !expected.length) return false;
  try {
    const derived = await scryptAsync(password, salt, expected.length, SCRYPT_OPTIONS);
    return crypto.timingSafeEqual(Buffer.from(derived), expected);
  } catch {
    return false;
  }
}

function publicCustomer(customer) {
  const { passwordHash, sessionVersion, ...safe } = customer;
  return safe;
}

function adminCustomer(customer) {
  const orders = db.orders.filter(
    (order) => order.customerId === customer.id || order.customer.email === customer.email
  );
  return {
    ...publicCustomer(customer),
    orderCount: orders.length,
    spent: round2(orders.filter((order) => order.status !== 'Cancelled').reduce((sum, order) => sum + order.total, 0))
  };
}

function publicOrder(order) {
  const { token, idempotencyKey, restocked, ...safe } = order;
  return safe;
}

// ---------------------------------------------------------------- settings / channels

const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '').slice(0, 15);
const telegramHandle = (value) => String(value ?? '').trim().replace(/^@+/, '').slice(0, 32);

function whatsappUrl() {
  const digits = digitsOnly(db.settings.whatsapp);
  return digits.length >= 7 ? `https://wa.me/${digits}` : '';
}

function whatsappDisplay() {
  const digits = digitsOnly(db.settings.whatsapp);
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}

function whatsappOrderUrl(order) {
  const digits = digitsOnly(db.settings.whatsapp);
  if (digits.length < 7 || !order) return '';
  const lines = [
    `Hello VELUNE, I'm confirming my order ${order.number}.`,
    `Name: ${order.customer.firstName} ${order.customer.lastName}`.trim(),
    `Total: $${Number(order.total).toFixed(2)} (${order.shippingMethod} delivery)`,
    'Please confirm availability and delivery time.'
  ];
  return `https://wa.me/${digits}?text=${encodeURIComponent(lines.join('\n'))}`;
}

function telegramUrl() {
  const handle = telegramHandle(db.settings.telegram);
  return /^[A-Za-z0-9_]{3,32}$/.test(handle) ? `https://t.me/${handle}` : '';
}

function adminSettings() {
  const { sessionSecret, ...safe } = db.settings;
  return safe;
}

function contactChannelCards() {
  const email = db.settings.supportEmail;
  const emailCard = `<a class="channel-card" href="mailto:${escapeHtml(email)}">
    <span class="channel-card__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="5" width="18" height="14" rx="1"/><path d="m3.5 6.5 8.5 7 8.5-7"/></svg></span>
    <span class="channel-card__label">Email</span>
    <strong>${escapeHtml(email)}</strong>
    <span class="channel-card__note">Best for order changes, returns and detailed questions.</span>
    <span class="channel-card__arrow" aria-hidden="true">→</span>
  </a>`;
  const cards = [emailCard];
  const wa = whatsappUrl();
  if (wa) {
    const display = whatsappDisplay();
    cards.push(`<a class="channel-card" href="${escapeHtml(wa)}" target="_blank" rel="noopener noreferrer">
      <span class="channel-card__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M20 11.7a7.8 7.8 0 0 1-11.4 6.9L4 20l1.5-4.4A7.8 7.8 0 1 1 20 11.7Z"/><path d="M9 8.5c.3 2.6 2.9 5.1 5.5 5.4l1-1.3 1.8.8c-.2 1.5-1.4 2.1-2.7 1.9-3.4-.5-6.3-3.4-6.8-6.8-.2-1.3.4-2.5 1.9-2.7l.8 1.8L9 8.5Z"/></svg></span>
      <span class="channel-card__label">WhatsApp</span>
      <strong>${escapeHtml(display)}</strong>
      <span class="channel-card__note">Message us during ${escapeHtml(db.settings.hours)}.</span>
      <span class="channel-card__arrow" aria-hidden="true">↗</span>
    </a>`);
  }
  const tg = telegramUrl();
  if (tg) {
    const handle = telegramHandle(db.settings.telegram);
    cards.push(`<a class="channel-card" href="${escapeHtml(tg)}" target="_blank" rel="noopener noreferrer">
      <span class="channel-card__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="m21 4-3 16-6-4.5L9 19l-.4-5.5L21 4Z"/><path d="m8.6 13.5 8.7-6.4"/></svg></span>
      <span class="channel-card__label">Telegram</span>
      <strong>@${escapeHtml(handle)}</strong>
      <span class="channel-card__note">Send a message or order number for a quick reply.</span>
      <span class="channel-card__arrow" aria-hidden="true">↗</span>
    </a>`);
  }
  return cards.join('');
}

function chatContactLinks() {
  const links = [`<a class="chat-channel" href="mailto:${escapeHtml(db.settings.supportEmail)}">Email us</a>`];
  if (whatsappUrl()) {
    links.push(
      `<a class="chat-channel" href="${escapeHtml(whatsappUrl())}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`
    );
  }
  if (telegramUrl()) {
    links.push(
      `<a class="chat-channel" href="${escapeHtml(telegramUrl())}" target="_blank" rel="noopener noreferrer">Telegram</a>`
    );
  }
  return links.join('');
}

function footerContactLinks() {
  const links = [`<li><a href="mailto:${escapeHtml(db.settings.supportEmail)}">${escapeHtml(db.settings.supportEmail)}</a></li>`];
  if (whatsappUrl()) {
    links.push(
      `<li><a href="${escapeHtml(whatsappUrl())}" target="_blank" rel="noopener noreferrer">WhatsApp</a></li>`
    );
  }
  if (telegramUrl()) {
    links.push(
      `<li><a href="${escapeHtml(telegramUrl())}" target="_blank" rel="noopener noreferrer">Telegram</a></li>`
    );
  }
  links.push('<li><a href="/contact">All contact options</a></li>');
  return links.join('');
}

const CATEGORY_SHORT_NAMES = {
  home: 'Home',
  audio: 'Audio',
  carry: 'Carry',
  wellness: 'Wellness',
  timepieces: 'Timepieces'
};

function categoryShortName(category) {
  return CATEGORY_SHORT_NAMES[category.slug] || category.name;
}

function categoryTile(category) {
  const count = db.products.filter((product) => product.category === category.slug).length;
  const product = db.products.find((entry) => entry.category === category.slug && entry.image);
  const image = product ? cardImageFor(product) : '/images/hero.jpg';
  const line = category.line || (count ? `${count} considered ${count === 1 ? 'object' : 'objects'}.` : 'New department.');
  return `<a class="category-tile" href="/shop?category=${encodeURIComponent(category.slug)}">
          <div class="category-tile__media"><img src="${escapeHtml(image)}" alt="${escapeHtml(category.name)}" width="400" height="500" loading="lazy"></div>
          <div class="category-tile__body">
            <div>
              <div class="category-tile__name">${escapeHtml(category.name)}</div>
              <div class="category-tile__line">${escapeHtml(line)}</div>
            </div>
            <span class="category-tile__arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg></span>
          </div>
        </a>`;
}

function categoryTokens() {
  const categories = db.categories;
  const stocked = categories.filter((category) => db.products.some((product) => product.category === category.slug));
  return {
    '{{NAV_CATEGORY_LINKS}}': categories
      .slice(0, 6)
      .map(
        (category) =>
          `<a href="/shop?category=${encodeURIComponent(category.slug)}" data-nav="${escapeHtml(category.slug)}">${escapeHtml(categoryShortName(category))}</a>`
      )
      .join('\n        '),
    '{{MOBILE_CATEGORY_LINKS}}': categories
      .map(
        (category, index) =>
          `<a href="/shop?category=${encodeURIComponent(category.slug)}">${escapeHtml(category.name)} <span>${String(index + 1).padStart(2, '0')}</span></a>`
      )
      .join('\n    '),
    '{{FOOTER_CATEGORY_LINKS}}': categories
      .map(
        (category) =>
          `<li><a href="/shop?category=${encodeURIComponent(category.slug)}">${escapeHtml(category.name)}</a></li>`
      )
      .join('\n          '),
    '{{SEARCH_CATEGORY_LINKS}}': categories
      .slice(0, 4)
      .map(
        (category) =>
          `<li><a href="/shop?category=${encodeURIComponent(category.slug)}">${escapeHtml(category.name)}</a></li>`
      )
      .join('\n          '),
    '{{SHOP_CATEGORY_CHIPS}}': categories
      .map(
        (category) =>
          `<button type="button" class="chip" data-category="${escapeHtml(category.slug)}">${escapeHtml(categoryShortName(category))} <span class="count" data-count="${escapeHtml(category.slug)}"></span></button>`
      )
      .join('\n        '),
    '{{HOME_CATEGORY_TILES}}': (stocked.length ? stocked : categories).map(categoryTile).join('\n        ')
  };
}

function contactTokens() {
  const email = db.settings.supportEmail;
  return {
    '{{ANNOUNCEMENT}}': escapeHtml(db.settings.announcement),
    '{{SUPPORT_EMAIL}}': escapeHtml(email),
    '{{SUPPORT_EMAIL_HREF}}': escapeHtml(`mailto:${email}`),
    '{{SUPPORT_HOURS}}': escapeHtml(db.settings.hours),
    '{{SUPPORT_RESPONSE}}': escapeHtml(db.settings.responseTime),
    '{{WHATSAPP_URL}}': escapeHtml(whatsappUrl()),
    '{{TELEGRAM_URL}}': escapeHtml(telegramUrl()),
    '{{CONTACT_CHANNEL_CARDS}}': contactChannelCards(),
    '{{CHAT_CONTACT_LINKS}}': chatContactLinks(),
    '{{FOOTER_CONTACT_LINKS}}': footerContactLinks()
  };
}

// ---------------------------------------------------------------- domain

function categoryName(slug) {
  return db.categories.find((category) => category.slug === slug)?.name || slug;
}

function cardImageFor(product) {
  return product.image.includes('-800') ? product.image.replace('-800', '-400') : product.image;
}

function enrichProduct(product) {
  return {
    ...product,
    categoryName: categoryName(product.category),
    inStock: product.stock > 0,
    cardImage: cardImageFor(product)
  };
}

function productPayload(input, existing = null) {
  const name = clampStr(input.name, 90);
  const category = clampStr(input.category, 30);
  const price = Number(input.price);
  const stock = Number(input.stock);
  const compareAtRaw = input.compareAt === '' || input.compareAt == null ? null : Number(input.compareAt);
  const image = clampStr(input.image, 500);
  const description = clampStr(input.description, 2000);
  const short = clampStr(input.short, 220);

  if (name.length < 2) throw httpError(422, 'Product name must be at least 2 characters.');
  if (!db.categories.some((entry) => entry.slug === category)) throw httpError(422, 'Choose a valid category.');
  if (!Number.isFinite(price) || price < 1 || price > 100_000) throw httpError(422, 'Price must be between $1 and $100,000.');
  if (!Number.isInteger(stock) || stock < 0 || stock > 100_000) throw httpError(422, 'Stock must be a whole number between 0 and 100,000.');
  if (compareAtRaw !== null && (!Number.isFinite(compareAtRaw) || compareAtRaw <= price)) {
    throw httpError(422, 'Compare-at price must be higher than the selling price.');
  }
  if (!image.startsWith('/images/') && !/^https:\/\//.test(image)) {
    throw httpError(422, 'Image must be a local /images/ path or an https:// URL.');
  }
  if (description.length < 10) throw httpError(422, 'Description must be at least 10 characters.');

  let variants = existing?.variants || [];
  if (Array.isArray(input.variants)) {
    variants = input.variants
      .filter((variant) => variant && clampStr(variant.name, 40) && Array.isArray(variant.options))
      .map((variant) => ({
        name: clampStr(variant.name, 40),
        options: variant.options.map((option) => clampStr(option, 40)).filter(Boolean).slice(0, 8)
      }))
      .filter((variant) => variant.name && variant.options.length)
      .slice(0, 4);
  }

  const slug = existing ? existing.slug : slugify(name) || `product-${Date.now()}`;
  return {
    id: existing ? existing.id : slug,
    slug,
    name,
    category,
    price: round2(price),
    compareAt: compareAtRaw === null ? null : round2(compareAtRaw),
    badge: clampStr(input.badge, 24) || null,
    rating: existing?.rating ?? 5,
    reviewCount: existing?.reviewCount ?? 0,
    stock,
    featured: Boolean(input.featured),
    isNew: input.isNew === undefined ? existing?.isNew ?? false : Boolean(input.isNew),
    short: short || description.slice(0, 160),
    description,
    details: Array.isArray(input.details) ? input.details.map((line) => clampStr(line, 220)).filter(Boolean).slice(0, 10) : existing?.details || [],
    specs: Array.isArray(input.specs)
      ? input.specs
          .filter((spec) => spec && clampStr(spec.k, 60) && clampStr(spec.v, 120))
          .map((spec) => ({ k: clampStr(spec.k, 60), v: clampStr(spec.v, 120) }))
          .slice(0, 10)
      : existing?.specs || [],
    variants,
    image
  };
}

function validateAddress(body) {
  const customer = body.customer || {};
  const shipping = body.shipping || {};
  const clean = {
    customer: {
      firstName: clampStr(customer.firstName, 60),
      lastName: clampStr(customer.lastName, 60),
      email: clampStr(customer.email, 254).toLowerCase(),
      phone: clampStr(customer.phone, 30)
    },
    shipping: {
      address1: clampStr(shipping.address1, 120),
      address2: clampStr(shipping.address2, 120),
      city: clampStr(shipping.city, 80),
      state: clampStr(shipping.state, 2).toUpperCase(),
      zip: clampStr(shipping.zip, 10),
      country: 'US'
    }
  };
  if (clean.customer.firstName.length < 2) throw httpError(422, 'Please enter your first name.');
  if (clean.customer.lastName.length < 2) throw httpError(422, 'Please enter your last name.');
  if (!isEmail(clean.customer.email)) throw httpError(422, 'Please enter a valid email address.');
  if (clean.shipping.address1.length < 3) throw httpError(422, 'Please enter a street address.');
  if (clean.shipping.city.length < 2) throw httpError(422, 'Please enter a city.');
  if (!US_STATES.has(clean.shipping.state)) throw httpError(422, 'Please choose a valid U.S. state.');
  if (!/^\d{5}(-\d{4})?$/.test(clean.shipping.zip)) throw httpError(422, 'Please enter a valid ZIP code.');
  return clean;
}

function calculatePromo(code, subtotal, methodKey) {
  const normalized = clampStr(code, 30).toUpperCase();
  if (!normalized) return { code: null, promo: null, discount: 0, shipping: null };
  const promo = PROMOS[normalized];
  if (!promo) throw httpError(422, 'That promo code is not recognised.');
  if (promo.type === 'percent') {
    return { code: normalized, promo, discount: round2(subtotal * (promo.value / 100)), shipping: null };
  }
  if (promo.type === 'shipping') {
    return { code: normalized, promo, discount: 0, shipping: methodKey === 'standard' ? 0 : null };
  }
  return { code: null, promo: null, discount: 0, shipping: null };
}

function shippingPrice(methodKey, merchandiseTotal, forcedFree = null) {
  const method = SHIPPING_METHODS[methodKey];
  if (!method) throw httpError(422, 'Choose a valid shipping method.');
  if (forcedFree !== null) return forcedFree;
  if (methodKey === 'standard' && merchandiseTotal >= FREE_SHIPPING_THRESHOLD) return 0;
  return method.price;
}

function newOrderNumber() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from(crypto.randomBytes(4)).map((byte) => alphabet[byte % alphabet.length]).join('');
  let number;
  do {
    number = `VLN-${block()}-${block()}`;
  } while (db.orders.some((order) => order.number === number));
  return number;
}

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function findOrder(number, email, token) {
  const order = db.orders.find((entry) => entry.number.toUpperCase() === String(number).toUpperCase());
  if (!order) return null;
  if (token && safeEqual(order.token, token)) return order;
  if (email && order.customer.email === String(email).toLowerCase()) return order;
  return null;
}

// ---------------------------------------------------------------- pages

const pageCache = new Map();
async function loadPartial(name) {
  if (!pageCache.has(name)) pageCache.set(name, await fsp.readFile(path.join(VIEWS_DIR, 'partials', name), 'utf8'));
  return pageCache.get(name);
}

async function renderPage(viewFile, meta) {
  const [view, header, footer] = await Promise.all([
    fsp.readFile(path.join(VIEWS_DIR, viewFile), 'utf8'),
    loadPartial('header.html'),
    loadPartial('footer.html')
  ]);
  const tokens = {
    '{{TITLE}}': escapeHtml(meta.title),
    '{{DESCRIPTION}}': escapeHtml(meta.description),
    '{{CANONICAL}}': escapeHtml(meta.canonical),
    '{{OG_IMAGE}}': escapeHtml(meta.ogImage),
    '{{OG_TYPE}}': escapeHtml(meta.ogType || 'website'),
    '{{ROBOTS}}': meta.robots || 'index, follow',
    '{{JSONLD}}': meta.jsonld
      ? `<script type="application/ld+json">${JSON.stringify(meta.jsonld).replace(/[<>&]/g, (char) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char])}</script>`
      : '',
    '{{PAGE_SCRIPTS}}': meta.scripts || '',
    '{{YEAR}}': String(new Date().getFullYear()),
    ...contactTokens(),
    ...categoryTokens()
  };
  if (meta.tokens) Object.assign(tokens, meta.tokens);
  let html = view
    .replace('<!--@header-->', header)
    .replace('<!--@footer-->', footer);
  for (const [token, value] of Object.entries(tokens)) html = html.split(token).join(value);
  return html;
}

async function servePage(req, res, viewFile, meta) {
  try {
    const origin = baseUrl(req);
    const canonical = origin + meta.path;
    const ogImage = /^https?:\/\//.test(meta.ogImage || '') ? meta.ogImage : origin + (meta.ogImage || '/images/hero.jpg');
    const html = await renderPage(viewFile, { ...meta, canonical, ogImage });
    sendHtml(res, 200, html);
  } catch (error) {
    if (error.code === 'ENOENT') return notFound(req, res);
    throw error;
  }
}

async function notFound(req, res) {
  try {
    const html = await renderPage('404.html', {
      title: 'Page not found — VELUNE',
      description: 'The page you were looking for has moved or no longer exists.',
      canonical: baseUrl(req) + req.url,
      ogImage: `${baseUrl(req)}/images/hero.jpg`,
      robots: 'noindex, follow',
      scripts: ''
    });
    sendHtml(res, 404, html);
  } catch {
    sendText(res, 404, 'Page not found');
  }
}

// ---------------------------------------------------------------- API routes

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (!['GET', 'HEAD'].includes(req.method)) assertSameOrigin(req);

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), orders: db.orders.length });
  }

  if (req.method === 'GET' && pathname === '/api/products') {
    return sendJson(res, 200, {
      products: db.products.map(enrichProduct),
      categories: db.categories
    });
  }

  const productMatch = pathname.match(/^\/api\/products\/([a-z0-9-]+)$/);
  if (req.method === 'GET' && productMatch) {
    const product = db.products.find((entry) => entry.slug === productMatch[1]);
    if (!product) return sendJson(res, 404, { error: 'Product not found' });
    const related = db.products.filter((entry) => entry.category === product.category && entry.slug !== product.slug).slice(0, 4);
    return sendJson(res, 200, { product: enrichProduct(product), related: related.map(enrichProduct) });
  }

  if (req.method === 'GET' && pathname === '/api/shipping') {
    return sendJson(res, 200, {
      methods: SHIPPING_METHODS,
      freeThreshold: FREE_SHIPPING_THRESHOLD,
      promosAvailable: Object.keys(PROMOS),
      states: [...US_STATES].sort()
    });
  }

  if (req.method === 'POST' && pathname === '/api/newsletter') {
    rateLimit(req, 'newsletter', 8, 60_000);
    const body = await readJson(req);
    if (clampStr(body.website, 20)) return sendJson(res, 200, { ok: true });
    const email = clampStr(body.email, 254).toLowerCase();
    if (!isEmail(email)) return sendJson(res, 422, { error: 'Enter a valid email address.' });
    if (db.subscribers.some((entry) => entry.email === email)) {
      return sendJson(res, 200, { ok: true, message: 'You are already on the list.' });
    }
    db.subscribers.push({ email, createdAt: now() });
    await persist();
    return sendJson(res, 201, { ok: true, message: 'You are on the list. One considered email a month.' });
  }

  if (req.method === 'POST' && pathname === '/api/support/ticket') {
    rateLimit(req, 'ticket', 6, 10 * 60_000);
    const body = await readJson(req);
    if (clampStr(body.website, 20)) return sendJson(res, 201, { ok: true, ticket: { id: 'T-hidden' } });
    const email = clampStr(body.email, 254).toLowerCase();
    const message = clampStr(body.message, 1500);
    const name = clampStr(body.name, 80);
    if (!isEmail(email)) return sendJson(res, 422, { error: 'Enter a valid email address.' });
    if (message.length < 10) return sendJson(res, 422, { error: 'Please add a little more detail (10+ characters).' });
    const account = currentCustomer(req);
    const ticket = {
      id: `T-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      name: name || (account ? `${account.firstName} ${account.lastName}`.trim() : ''),
      email,
      subject: clampStr(body.subject, 120) || 'General enquiry',
      message,
      orderNumber: clampStr(body.orderNumber, 20).toUpperCase() || null,
      customerId: account?.id || null,
      status: 'open',
      createdAt: now()
    };
    db.tickets.push(ticket);
    await persist();
    return sendJson(res, 201, {
      ok: true,
      ticket,
      message: 'Message received. A human replies within one business day, Monday–Friday.'
    });
  }

  if (req.method === 'POST' && pathname === '/api/promo') {
    rateLimit(req, 'promo', 30, 60_000);
    const body = await readJson(req);
    const code = clampStr(body.code, 30).toUpperCase();
    const promo = PROMOS[code];
    if (!promo) return sendJson(res, 422, { error: 'That code is not recognised.' });
    return sendJson(res, 200, { code, label: promo.label, type: promo.type, value: promo.value });
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    rateLimit(req, 'orders', 20, 60_000);
    const body = await readJson(req);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > 20) throw httpError(422, 'Your cart appears to be empty.');
    const idempotencyKey = clampStr(body.idempotencyKey, 100);
    const emailInput = clampStr(body.customer?.email, 254).toLowerCase();
    const duplicate = idempotencyKey
      ? db.orders.find((order) => order.idempotencyKey === idempotencyKey && order.customer.email === emailInput)
      : null;
    if (duplicate) return sendJson(res, 200, { order: publicOrder(duplicate), token: duplicate.token, duplicate: true });

    const { customer, shipping } = validateAddress(body);
    const account = currentCustomer(req);
    const methodKey = clampStr(body.shippingMethod, 20) || 'standard';
    if (!SHIPPING_METHODS[methodKey]) throw httpError(422, 'Choose a valid shipping method.');

    const lineItems = [];
    let subtotal = 0;
    for (const item of items) {
      const product = db.products.find((entry) => entry.slug === clampStr(item.slug, 80));
      const qty = Number(item.qty);
      if (!product) throw httpError(422, 'A product in your cart is no longer available.');
      if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw httpError(422, `Choose a quantity between 1 and 10 for ${product.name}.`);
      if (product.stock < qty) throw httpError(409, `Only ${product.stock} left of ${product.name}.`);
      subtotal += product.price * qty;
      lineItems.push({
        slug: product.slug,
        name: product.name,
        price: product.price,
        qty,
        variant: clampStr(item.variant, 80) || (product.variants[0]?.options[0] ?? ''),
        image: product.image
      });
    }
    subtotal = round2(subtotal);

    const promo = calculatePromo(body.promoCode, subtotal, methodKey);
    const merchandiseTotal = round2(subtotal - promo.discount);
    const shipCost = shippingPrice(methodKey, merchandiseTotal, promo.shipping);
    const tax = 0;
    const total = round2(merchandiseTotal + shipCost + tax);
    if (total <= 0) throw httpError(422, 'Order total is not valid.');

    for (const line of lineItems) {
      const product = db.products.find((entry) => entry.slug === line.slug);
      product.stock -= line.qty;
      line.image = product.image;
    }

    const number = newOrderNumber();
    const token = crypto.randomBytes(24).toString('hex');
    const timestamp = now();
    const order = {
      id: `ord_${crypto.randomBytes(8).toString('hex')}`,
      number,
      token,
      idempotencyKey: idempotencyKey || null,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'Confirmed',
      paymentMethod: 'Cash on delivery',
      paymentStatus: 'Payment on delivery',
      customerId: account?.id || null,
      customer,
      shipping,
      items: lineItems,
      subtotal,
      discount: promo.discount,
      promoCode: promo.code,
      shippingMethod: methodKey,
      shippingCost: shipCost,
      tax,
      total,
      currency: 'USD',
      notes: clampStr(body.notes, 500),
      trackingNumber: null,
      statusHistory: [{ status: 'Confirmed', at: timestamp }],
      restocked: false
    };
    db.orders.push(order);
    await persist();
    return sendJson(res, 201, { order: publicOrder(order), token, whatsapp: whatsappOrderUrl(order) });
  }

  const orderMatch = pathname.match(/^\/api\/orders\/(VLN-[A-Z0-9]{4}-[A-Z0-9]{4})$/i);
  if (req.method === 'GET' && orderMatch) {
    rateLimit(req, 'order-read', 60, 60_000);
    const token = clampStr(url.searchParams.get('token'), 80);
    const order = findOrder(orderMatch[1], null, token);
    if (!order) return sendJson(res, 404, { error: 'Order not found. Check your link or look it up with your email.' });
    return sendJson(res, 200, { order: publicOrder(order), whatsapp: whatsappOrderUrl(order) });
  }

  if (req.method === 'POST' && pathname === '/api/orders/lookup') {
    rateLimit(req, 'order-lookup', 10, 10 * 60_000);
    const body = await readJson(req);
    const number = clampStr(body.number, 20).toUpperCase();
    const email = clampStr(body.email, 254).toLowerCase();
    if (!/^VLN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(number)) return sendJson(res, 422, { error: 'Enter a valid order number (e.g. VLN-AB12-CD34).' });
    if (!isEmail(email)) return sendJson(res, 422, { error: 'Enter the email used at checkout.' });
    const order = findOrder(number, email, null);
    if (!order) return sendJson(res, 404, { error: 'No order matches that number and email.' });
    return sendJson(res, 200, { order: publicOrder(order), token: order.token, whatsapp: whatsappOrderUrl(order) });
  }

  // ------------------------------------------------------------ customer accounts

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    rateLimit(req, 'register', 6, 10 * 60_000);
    const body = await readJson(req);
    if (clampStr(body.website, 20)) return sendJson(res, 201, { ok: true });
    const firstName = clampStr(body.firstName, 60);
    const lastName = clampStr(body.lastName, 60);
    const email = clampStr(body.email, 254).toLowerCase();
    const password = String(body.password ?? '');
    if (firstName.length < 2) return sendJson(res, 422, { error: 'Please enter your first name.' });
    if (lastName.length < 2) return sendJson(res, 422, { error: 'Please enter your last name.' });
    if (!isEmail(email)) return sendJson(res, 422, { error: 'Enter a valid email address.' });
    if (password.length < 8) return sendJson(res, 422, { error: 'Use at least 8 characters for your password.' });
    if (password.length > 200) return sendJson(res, 422, { error: 'That password is too long.' });
    if (db.customers.some((customer) => customer.email === email)) {
      return sendJson(res, 409, { error: 'An account with this email already exists. Try signing in.' });
    }
    const timestamp = now();
    const customer = {
      id: `cust_${crypto.randomBytes(8).toString('hex')}`,
      firstName,
      lastName,
      email,
      phone: clampStr(body.phone, 30),
      passwordHash: await hashPassword(password),
      marketingOptIn: Boolean(body.marketingOptIn),
      sessionVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    db.customers.push(customer);
    await persist();
    return sendJson(
      res,
      201,
      { customer: publicCustomer(customer), token: signCustomerToken(customer), message: 'Your account is ready.' },
      { 'Set-Cookie': customerCookie(req, signCustomerToken(customer), SESSION_TTL) }
    );
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    rateLimit(req, 'login', 10, 10 * 60_000);
    const body = await readJson(req);
    const email = clampStr(body.email, 254).toLowerCase();
    const password = String(body.password ?? '');
    const customer = db.customers.find((entry) => entry.email === email);
    const valid = customer ? await verifyPassword(password, customer.passwordHash) : false;
    if (!valid) {
      return sendJson(res, 401, { error: 'Email or password is not correct.' });
    }
    customer.lastLoginAt = now();
    await persist();
    return sendJson(
      res,
      200,
      { customer: publicCustomer(customer), token: signCustomerToken(customer) },
      { 'Set-Cookie': customerCookie(req, signCustomerToken(customer), SESSION_TTL) }
    );
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': customerCookie(req, '', 0) });
  }

  if (req.method === 'GET' && pathname === '/api/auth/session') {
    const customer = currentCustomer(req);
    return sendJson(res, 200, { customer: customer ? publicCustomer(customer) : null });
  }

  if (req.method === 'GET' && pathname === '/api/account/orders') {
    rateLimit(req, 'account-orders', 60, 60_000);
    const customer = requireCustomer(req);
    // Only orders explicitly linked at checkout are disclosed. Matching by email
    // would let anyone who registers with an address read that person's orders.
    const orders = db.orders
      .filter((order) => order.customerId === customer.id)
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    // The private token is only released to the signed-in owner so links to the
    // confirmation page keep working without weakening public order lookup.
    return sendJson(res, 200, { orders: orders.map((order) => ({ ...publicOrder(order), token: order.token })) });
  }

  if (req.method === 'PATCH' && pathname === '/api/account') {
    const customer = requireCustomer(req);
    const body = await readJson(req);
    if (body.firstName !== undefined) {
      const firstName = clampStr(body.firstName, 60);
      if (firstName.length < 2) return sendJson(res, 422, { error: 'Please enter your first name.' });
      customer.firstName = firstName;
    }
    if (body.lastName !== undefined) {
      const lastName = clampStr(body.lastName, 60);
      if (lastName.length < 2) return sendJson(res, 422, { error: 'Please enter your last name.' });
      customer.lastName = lastName;
    }
    if (body.phone !== undefined) customer.phone = clampStr(body.phone, 30);
    if (body.marketingOptIn !== undefined) customer.marketingOptIn = Boolean(body.marketingOptIn);
    customer.updatedAt = now();
    await persist();
    return sendJson(res, 200, { customer: publicCustomer(customer), message: 'Profile updated.' });
  }

  if (req.method === 'POST' && pathname === '/api/account/password') {
    rateLimit(req, 'password-change', 10, 60 * 60_000);
    const customer = requireCustomer(req);
    const body = await readJson(req);
    const currentPassword = String(body.currentPassword ?? '');
    const newPassword = String(body.newPassword ?? '');
    if (!(await verifyPassword(currentPassword, customer.passwordHash))) {
      return sendJson(res, 401, { error: 'Your current password is not correct.' });
    }
    if (newPassword.length < 8) return sendJson(res, 422, { error: 'Use at least 8 characters for your new password.' });
    if (newPassword.length > 200) return sendJson(res, 422, { error: 'That password is too long.' });
    customer.passwordHash = await hashPassword(newPassword);
    customer.sessionVersion = (Number(customer.sessionVersion) || 1) + 1;
    customer.updatedAt = now();
    await persist();
    return sendJson(
      res,
      200,
      { ok: true, token: signCustomerToken(customer), message: 'Password updated. Other devices have been signed out.' },
      { 'Set-Cookie': customerCookie(req, signCustomerToken(customer), SESSION_TTL) }
    );
  }

  // ------------------------------------------------------------ admin

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    rateLimit(req, 'admin-login', 6, 10 * 60_000);
    const body = await readJson(req);
    const username = clampStr(body.username, 100);
    const password = typeof body.password === 'string' ? body.password : '';
    const expectedUser = String(process.env.ADMIN_USERNAME || db.settings.adminUsername || ADMIN_USERNAME);
    const providedUser = crypto.createHash('sha256').update(username.toLowerCase()).digest();
    const expectedUserHash = crypto.createHash('sha256').update(expectedUser.toLowerCase()).digest();
    const passwordHash = process.env.ADMIN_PASSWORD_HASH || db.settings.adminPasswordHash || '';
    // Verify the password even when the username mismatches, so a wrong username
    // does not shortcut the scrypt cost and leak which field failed.
    const [userOk, passwordOk] = await Promise.all([
      Promise.resolve(crypto.timingSafeEqual(providedUser, expectedUserHash)),
      passwordHash ? verifyPassword(password, passwordHash) : Promise.resolve(false)
    ]);
    if (!userOk || !passwordOk) {
      return sendJson(res, 401, { error: 'Incorrect username or password.' });
    }
    return sendJson(res, 200, { token: signAdminToken(), expiresIn: 12 * 60 * 60 });
  }

  if (pathname.startsWith('/api/admin/')) requireAdmin(req);

  if (req.method === 'GET' && pathname === '/api/admin/overview') {
    const active = db.orders.filter((order) => order.status !== 'Cancelled');
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = active.filter((order) => new Date(order.createdAt).getTime() >= cutoff);
    const revenue30 = round2(recent.reduce((sum, order) => sum + order.total, 0));
    const units = new Map();
    for (const order of active) {
      for (const item of order.items) units.set(item.slug, (units.get(item.slug) || 0) + item.qty);
    }
    const topProducts = [...units.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([slug, count]) => ({ slug, name: db.products.find((product) => product.slug === slug)?.name || slug, units: count }));
    return sendJson(res, 200, {
      stats: {
        revenue30,
        orders30: recent.length,
        aov30: recent.length ? round2(revenue30 / recent.length) : 0,
        allOrders: db.orders.length,
        lowStock: db.products.filter((product) => product.stock <= 8).length,
        openTickets: db.tickets.filter((ticket) => ticket.status === 'open').length,
        subscribers: db.subscribers.length,
        customers: db.customers.length
      },
      recentOrders: db.orders.slice(-6).reverse().map(publicOrder),
      lowStockProducts: db.products.filter((product) => product.stock <= 8).map(enrichProduct),
      topProducts,
      productsCount: db.products.length
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/orders') {
    return sendJson(res, 200, { orders: [...db.orders].reverse().map(publicOrder) });
  }

  const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/(VLN-[A-Z0-9]{4}-[A-Z0-9]{4})$/);
  if (req.method === 'PATCH' && adminOrderMatch) {
    const order = db.orders.find((entry) => entry.number === adminOrderMatch[1]);
    if (!order) return sendJson(res, 404, { error: 'Order not found' });
    const body = await readJson(req);
    if (body.status !== undefined) {
      const status = clampStr(body.status, 20);
      if (!ORDER_STATUSES.includes(status)) return sendJson(res, 422, { error: 'Invalid order status.' });
      if (status !== order.status) {
        if (status === 'Cancelled' && !order.restocked) {
          for (const item of order.items) {
            const product = db.products.find((entry) => entry.slug === item.slug);
            if (product) product.stock += item.qty;
          }
          order.restocked = true;
          order.paymentStatus = 'Cancelled — no payment due';
        }
        order.status = status;
        order.statusHistory.push({ status, at: now() });
      }
    }
    if (body.trackingNumber !== undefined) {
      order.trackingNumber = clampStr(body.trackingNumber, 80) || null;
    }
    order.updatedAt = now();
    await persist();
    return sendJson(res, 200, { order: publicOrder(order) });
  }

  if (req.method === 'GET' && pathname === '/api/admin/products') {
    return sendJson(res, 200, { products: db.products.map(enrichProduct), categories: db.categories });
  }

  if (req.method === 'POST' && pathname === '/api/admin/products') {
    const body = await readJson(req);
    const payload = productPayload(body);
    let slug = payload.slug;
    let counter = 2;
    while (db.products.some((product) => product.slug === slug)) slug = `${payload.slug}-${counter++}`;
    payload.slug = slug;
    payload.id = slug;
    db.products.push(payload);
    await persist();
    return sendJson(res, 201, { product: enrichProduct(payload) });
  }

  const adminProductMatch = pathname.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/);
  if (adminProductMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const index = db.products.findIndex((product) => product.slug === adminProductMatch[1]);
    if (index === -1) return sendJson(res, 404, { error: 'Product not found' });
    if (req.method === 'DELETE') {
      db.products.splice(index, 1);
      await persist();
      return sendJson(res, 200, { ok: true });
    }
    const body = await readJson(req);
    const updated = productPayload({ ...db.products[index], ...body }, db.products[index]);
    db.products[index] = updated;
    await persist();
    return sendJson(res, 200, { product: enrichProduct(updated) });
  }

  if (req.method === 'POST' && pathname === '/api/admin/uploads') {
    const body = await readJson(req, 7_500_000);
    const mime = clampStr(body.mime, 40).toLowerCase();
    const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    const extension = extensions[mime];
    if (!extension) return sendJson(res, 422, { error: 'Upload a JPEG, PNG or WebP image.' });
    let base64 = String(body.data || '');
    if (base64.startsWith('data:')) base64 = base64.slice(base64.indexOf(',') + 1);
    if (!base64) return sendJson(res, 422, { error: 'Choose an image to upload.' });
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      return sendJson(res, 422, { error: 'That image could not be read.' });
    }
    if (buffer.length < 128) return sendJson(res, 422, { error: 'That image appears to be empty.' });
    if (buffer.length > UPLOAD_MAX_BYTES) return sendJson(res, 413, { error: 'Images must be 5 MB or smaller.' });
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    if ((mime === 'image/jpeg' && !isJpeg) || (mime === 'image/png' && !isPng) || (mime === 'image/webp' && !isWebp)) {
      return sendJson(res, 422, { error: 'The file contents do not match the image type.' });
    }
    const filename = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
    await fsp.mkdir(UPLOADS_DIR, { recursive: true });
    await fsp.writeFile(path.join(UPLOADS_DIR, filename), buffer);
    return sendJson(res, 201, {
      path: `/images/uploads/${filename}`,
      bytes: buffer.length,
      message: 'Image uploaded. Save the product to publish it.'
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/customers') {
    return sendJson(res, 200, {
      customers: db.customers
        .map(adminCustomer)
        .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    });
  }

  const adminCustomerMatch = pathname.match(/^\/api\/admin\/customers\/(cust_[a-f0-9]{16})$/);
  if (req.method === 'DELETE' && adminCustomerMatch) {
    const index = db.customers.findIndex((customer) => customer.id === adminCustomerMatch[1]);
    if (index === -1) return sendJson(res, 404, { error: 'Customer not found' });
    db.customers.splice(index, 1);
    for (const order of db.orders) {
      if (order.customerId === adminCustomerMatch[1]) order.customerId = null;
    }
    await persist();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/admin/settings') {
    return sendJson(res, 200, { settings: adminSettings(), categories: db.categories });
  }

  if (req.method === 'PATCH' && pathname === '/api/admin/settings') {
    const body = await readJson(req);
    const updates = {};
    if (body.supportEmail !== undefined) {
      const email = clampStr(body.supportEmail, 254).toLowerCase();
      if (!isEmail(email)) return sendJson(res, 422, { error: 'Enter a valid support email address.' });
      updates.supportEmail = email;
    }
    if (body.whatsapp !== undefined) {
      const digits = digitsOnly(body.whatsapp);
      if (digits && (digits.length < 7 || digits.length > 15)) {
        return sendJson(res, 422, { error: 'WhatsApp needs 7–15 digits including the country code.' });
      }
      updates.whatsapp = digits;
    }
    if (body.telegram !== undefined) {
      const handle = telegramHandle(body.telegram);
      if (handle && !/^[A-Za-z0-9_]{3,32}$/.test(handle)) {
        return sendJson(res, 422, { error: 'Telegram usernames use 3–32 letters, numbers or underscores.' });
      }
      updates.telegram = handle;
    }
    if (body.hours !== undefined) {
      const hours = clampStr(body.hours, 120);
      if (!hours) return sendJson(res, 422, { error: 'Support hours cannot be empty.' });
      updates.hours = hours;
    }
    if (body.responseTime !== undefined) {
      const responseTime = clampStr(body.responseTime, 120);
      if (!responseTime) return sendJson(res, 422, { error: 'Response time cannot be empty.' });
      updates.responseTime = responseTime;
    }
    if (body.announcement !== undefined) {
      const announcement = clampStr(body.announcement, 160);
      if (!announcement) return sendJson(res, 422, { error: 'Announcement cannot be empty.' });
      updates.announcement = announcement;
    }
    Object.assign(db.settings, updates, { updatedAt: now() });
    await persist();
    return sendJson(res, 200, { settings: adminSettings(), message: 'Store settings saved.' });
  }

  if (req.method === 'POST' && pathname === '/api/admin/categories') {
    const body = await readJson(req);
    const name = clampStr(body.name, 40);
    if (name.length < 2) return sendJson(res, 422, { error: 'Category name must be at least 2 characters.' });
    const slug = slugify(name);
    if (!slug) return sendJson(res, 422, { error: 'Use letters or numbers in the category name.' });
    if (db.categories.some((category) => category.slug === slug)) {
      return sendJson(res, 409, { error: 'A category with that name already exists.' });
    }
    const category = { slug, name, line: clampStr(body.line, 80) };
    db.categories.push(category);
    await persist();
    return sendJson(res, 201, { category, categories: db.categories });
  }

  const adminCategoryMatch = pathname.match(/^\/api\/admin\/categories\/([a-z0-9-]+)$/);
  if (adminCategoryMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const category = db.categories.find((entry) => entry.slug === adminCategoryMatch[1]);
    if (!category) return sendJson(res, 404, { error: 'Category not found' });
    if (req.method === 'DELETE') {
      if (db.categories.length <= 1) return sendJson(res, 409, { error: 'Keep at least one category.' });
      if (db.products.some((product) => product.category === category.slug)) {
        return sendJson(res, 409, { error: 'Move or delete the products in this category first.' });
      }
      db.categories = db.categories.filter((entry) => entry.slug !== category.slug);
      await persist();
      return sendJson(res, 200, { ok: true, categories: db.categories });
    }
    const body = await readJson(req);
    if (body.name !== undefined) {
      const name = clampStr(body.name, 40);
      if (name.length < 2) return sendJson(res, 422, { error: 'Category name must be at least 2 characters.' });
      category.name = name;
    }
    if (body.line !== undefined) category.line = clampStr(body.line, 80);
    await persist();
    return sendJson(res, 200, { category, categories: db.categories });
  }

  if (req.method === 'GET' && pathname === '/api/admin/tickets') {
    return sendJson(res, 200, { tickets: [...db.tickets].reverse() });
  }

  const ticketMatch = pathname.match(/^\/api\/admin\/tickets\/(T-[A-F0-9]+)$/);
  if (req.method === 'PATCH' && ticketMatch) {
    const ticket = db.tickets.find((entry) => entry.id === ticketMatch[1]);
    if (!ticket) return sendJson(res, 404, { error: 'Ticket not found' });
    const body = await readJson(req);
    const status = clampStr(body.status, 20);
    if (!['open', 'resolved'].includes(status)) return sendJson(res, 422, { error: 'Invalid ticket status.' });
    ticket.status = status;
    ticket.updatedAt = now();
    await persist();
    return sendJson(res, 200, { ticket });
  }

  if (req.method === 'GET' && pathname === '/api/admin/subscribers') {
    return sendJson(res, 200, { subscribers: [...db.subscribers].reverse() });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------- static + SEO

async function serveStatic(req, res, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (relative.includes('\0')) return sendText(res, 400, 'Bad request');
  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, 'Forbidden');

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  const ext = path.extname(filePath).toLowerCase();
  const isAsset = ['.jpg', '.jpeg', '.png', '.webp', '.svg', '.woff2'].includes(ext);
  const cache = isAsset ? 'public, max-age=604800' : 'public, max-age=300, must-revalidate';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache,
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString()
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath)
    .on('error', () => res.end())
    .pipe(res);
  return true;
}

async function serveSitemap(req, res) {
  const base = baseUrl(req);
  const staticPaths = ['/', '/shop', '/contact', '/policies'];
  const urls = [
    ...staticPaths.map((entry) => ({ loc: base + entry, priority: entry === '/' ? '1.0' : '0.7' })),
    ...db.products.map((product) => ({ loc: `${base}/product/${product.slug}`, priority: '0.8' }))
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((entry) => `  <url><loc>${escapeHtml(entry.loc)}</loc><changefreq>weekly</changefreq><priority>${entry.priority}</priority></url>`)
    .join('\n')}\n</urlset>`;
  sendText(res, 200, xml, MIME['.xml'], { 'Cache-Control': 'public, max-age=3600' });
}

function serveRobots(req, res) {
  const base = baseUrl(req);
  const body = `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /checkout\nDisallow: /order\nDisallow: /api/\n\nSitemap: ${base}/sitemap.xml\n`;
  sendText(res, 200, body, MIME['.txt'], { 'Cache-Control': 'public, max-age=3600' });
}

// ---------------------------------------------------------------- router

const PAGE_META = {
  shop: {
    view: 'shop.html',
    title: 'Shop All — VELUNE',
    description: 'Considered homeware, audio, carry and timepieces. Small-batch objects chosen for how they live, not how they look on a shelf.',
    path: '/shop',
    ogImage: '/images/editorial/materials.jpg',
    scripts: '<script src="/js/shop.js" defer></script>'
  },
  checkout: {
    view: 'checkout.html',
    title: 'Secure Checkout — VELUNE',
    description: 'Complete your VELUNE order.',
    path: '/checkout',
    ogImage: '/images/hero.jpg',
    robots: 'noindex, nofollow',
    scripts: '<script src="/js/checkout.js" defer></script>'
  },
  order: {
    view: 'order.html',
    title: 'Order Tracking — VELUNE',
    description: 'Track your VELUNE order.',
    path: '/order',
    ogImage: '/images/hero.jpg',
    robots: 'noindex, nofollow',
    scripts: '<script src="/js/order.js" defer></script>'
  },
  contact: {
    view: 'contact.html',
    title: 'Contact & Client Care — VELUNE',
    description: 'Reach VELUNE client care by email, WhatsApp or Telegram. Order help, returns and product questions.',
    path: '/contact',
    ogImage: '/images/editorial/craft.jpg',
    scripts: '<script src="/js/contact.js" defer></script>'
  },
  account: {
    view: 'account.html',
    title: 'Your Account — VELUNE',
    description: 'Sign in to your VELUNE account.',
    path: '/account',
    ogImage: '/images/hero.jpg',
    robots: 'noindex, nofollow',
    scripts: '<script src="/js/account.js" defer></script>'
  },
  policies: {
    view: 'policies.html',
    title: 'Shipping, Returns & Policies — VELUNE',
    description: 'Shipping timelines, returns, privacy, terms and support details for VELUNE.',
    path: '/policies',
    ogImage: '/images/editorial/craft.jpg',
    scripts: ''
  },
  admin: {
    view: 'admin.html',
    title: 'VELUNE Admin',
    description: 'Store operations.',
    path: '/admin',
    ogImage: '/images/hero.jpg',
    robots: 'noindex, nofollow',
    scripts: '<script src="/js/admin.js" defer></script>'
  }
};

async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  res.on('finish', () => {
    if (IS_PROD) console.log(`${req.method} ${pathname} ${res.statusCode}`);
  });

  if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD, POST, PATCH, DELETE');
    return sendText(res, 405, 'Method not allowed');
  }

  if (pathname.startsWith('/api/')) {
    try {
      return await handleApi(req, res, url);
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, code: error.code });
      console.error('[api]', error);
      return sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');

  if (pathname === '/sitemap.xml') return serveSitemap(req, res);
  if (pathname === '/robots.txt') return serveRobots(req, res);

  if (pathname === '/') {
    return servePage(req, res, 'home.html', {
      title: 'VELUNE — Considered objects for modern living',
      description: 'Considered homeware, audio, carry and timepieces. Small-batch objects with quiet materials, honest construction and a long life ahead.',
      path: '/',
      ogImage: '/images/hero.jpg',
      scripts: '<script src="/js/home.js" defer></script>',
      jsonld: [
        {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: 'VELUNE',
          url: baseUrl(req),
          logo: `${baseUrl(req)}/favicon.svg`,
          email: db.settings.supportEmail
        },
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'VELUNE',
          url: baseUrl(req)
        }
      ]
    });
  }

  if (pathname === '/shop') return servePage(req, res, PAGE_META.shop.view, PAGE_META.shop);
  if (pathname === '/checkout') return servePage(req, res, PAGE_META.checkout.view, PAGE_META.checkout);
  if (pathname === '/order') return servePage(req, res, PAGE_META.order.view, PAGE_META.order);
  if (pathname === '/contact') return servePage(req, res, PAGE_META.contact.view, PAGE_META.contact);
  if (pathname === '/account' || pathname === '/login' || pathname === '/register') {
    return servePage(req, res, PAGE_META.account.view, PAGE_META.account);
  }
  if (pathname === '/policies') return servePage(req, res, PAGE_META.policies.view, PAGE_META.policies);
  if (pathname === '/admin') return servePage(req, res, PAGE_META.admin.view, PAGE_META.admin);

  const productMatch = pathname.match(/^\/product\/([a-z0-9-]+)$/);
  if (productMatch) {
    const product = db.products.find((entry) => entry.slug === productMatch[1]);
    if (!product) return notFound(req, res);
    const base = baseUrl(req);
    const badge = product.stock < 1 ? 'Sold out' : product.badge || '';
    const badgeMarkup = badge
      ? `<span class="product-badge${product.stock < 1 ? ' product-badge--sold' : ''}">${escapeHtml(badge)}</span>`
      : '';
    const priceText = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(product.price);
    const compareMarkup =
      product.compareAt && product.compareAt > product.price
        ? ` <s>${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(product.compareAt)}</s> <span class="save">Save ${Math.round((1 - product.price / product.compareAt) * 100)}%</span>`
        : '';
    const variantsMarkup = (product.variants || [])
      .map(
        (variant) => `<div class="variant-group" data-variant-group data-variant-name="${escapeHtml(variant.name)}">
          <div class="variant-label">${escapeHtml(variant.name)}: <strong data-variant-value>${escapeHtml(variant.options[0] || '')}</strong></div>
          <div class="variant-options">
            ${variant.options
              .map(
                (option, index) =>
                  `<button type="button" class="variant-btn${index === 0 ? ' is-selected' : ''}" data-variant-option="${escapeHtml(option)}">${escapeHtml(option)}</button>`
              )
              .join('')}
          </div>
        </div>`
      )
      .join('');
    const stockText =
      product.stock < 1 ? 'Out of stock — check back soon' : product.stock <= 5 ? `Only ${product.stock} left` : 'In stock — ready to ship';
    const stockClass = product.stock < 1 ? 'is-out' : product.stock <= 5 ? 'is-low' : '';
    return servePage(req, res, 'product.html', {
      title: `${product.name} — VELUNE`,
      description: product.short || product.description.slice(0, 150),
      path: `/product/${product.slug}`,
      ogImage: product.image,
      ogType: 'product',
      scripts: '<script src="/js/product.js" defer></script>',
      tokens: {
        '{{PRODUCT_NAME}}': escapeHtml(product.name),
        '{{PRODUCT_CATEGORY}}': escapeHtml(categoryName(product.category)),
        '{{PRODUCT_CATEGORY_SLUG}}': escapeHtml(product.category),
        '{{PRODUCT_CARD_IMAGE}}': escapeHtml(cardImageFor(product)),
        '{{PRODUCT_IMAGE}}': escapeHtml(product.image),
        '{{PRODUCT_PRICE}}': priceText + compareMarkup,
        '{{PRODUCT_SHORT}}': escapeHtml(product.short),
        '{{PRODUCT_DESCRIPTION}}': escapeHtml(product.description),
        '{{PRODUCT_DETAILS}}': product.details.map((line) => `<li>${escapeHtml(line)}</li>`).join(''),
        '{{PRODUCT_SPECS}}': product.specs
          .map((spec) => `<tr><td>${escapeHtml(spec.k)}</td><td>${escapeHtml(spec.v)}</td></tr>`)
          .join(''),
        '{{PRODUCT_VARIANTS}}': variantsMarkup,
        '{{PRODUCT_STOCK_TEXT}}': escapeHtml(stockText),
        '{{PRODUCT_STOCK_CLASS}}': stockClass,
        '{{PRODUCT_BADGE}}': badgeMarkup,
        '{{PRODUCT_RATING}}': Number(product.rating).toFixed(1),
        '{{PRODUCT_REVIEWS}}': String(product.reviewCount),
        '{{PRODUCT_SKU}}': escapeHtml(product.id)
      },
      jsonld: {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: product.name,
        image: [base + product.image],
        description: product.short,
        sku: product.id,
        brand: { '@type': 'Brand', name: 'VELUNE' },
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: product.rating,
          reviewCount: product.reviewCount
        },
        offers: {
          '@type': 'Offer',
          url: `${base}/product/${product.slug}`,
          priceCurrency: 'USD',
          price: product.price.toFixed(2),
          availability: product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
          itemCondition: 'https://schema.org/NewCondition'
        }
      }
    });
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(302, { Location: '/favicon.svg' });
    return res.end();
  }

  const served = await serveStatic(req, res, pathname);
  if (served) return;

  return notFound(req, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('[fatal]', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    else res.end();
  });
});

ensureAdminCredentials().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`\n  VELUNE is running at http://localhost:${PORT}`);
    console.log(`  Admin: http://localhost:${PORT}/admin (username: ${process.env.ADMIN_USERNAME || db.settings.adminUsername || ADMIN_USERNAME})`);
    const passwordSource = process.env.ADMIN_PASSWORD_HASH
      ? 'ADMIN_PASSWORD_HASH (env)'
      : process.env.ADMIN_PASSWORD
        ? 'ADMIN_PASSWORD (env)'
        : db.settings.adminPasswordHash
          ? 'stored hash in data/db.json'
          : 'none — see one-time password above';
    console.log(`  Admin password source: ${passwordSource}`);
    if (!IS_PROD && !process.env.ADMIN_SECRET) {
      console.log('  Note: set ADMIN_SECRET (and ADMIN_PASSWORD for a fixed password) before exposing this server publicly.\n');
    }
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\n  Saving data and shutting down…');
    await writeQueue;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
