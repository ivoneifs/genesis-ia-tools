const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SESSION_SECRET || !DATABASE_URL) {
  console.error('Missing required env vars: SESSION_SECRET, DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.on('error', (err) => console.error('Idle pg client error (pool kept alive):', err.message));

const app = express();
app.use(express.json());
app.use(cookieSession({
  name: 'session',
  secret: SESSION_SECRET,
  maxAge: 12 * 60 * 60 * 1000,
  sameSite: 'lax',
  httpOnly: true,
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'not_authenticated' });
}

// Wraps an async route handler so any rejected promise (bad SQL, constraint
// violation, network blip) becomes a clean JSON error response instead of an
// unhandled rejection that can crash the process.
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function genPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
}

function normalizePhone(p) {
  return (p || '').replace(/\D/g, '');
}

function isAllowedGateOrigin(origin) {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === 'appsbrasil.store' || host.endsWith('.appsbrasil.store') || host === 'localhost';
  } catch (e) { return false; }
}

// CORS for the public verify-membership endpoint only — the 27 tool sites call
// this cross-origin from their own subdomains. Mirrors the allow-list already
// enforced client-side in each tool's membership-gate.js.
app.use('/api/verify-membership', (req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedGateOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.post('/api/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const emailNorm = (email || '').trim().toLowerCase();
  if (!emailNorm || !password) return res.status(401).json({ error: 'wrong_password' });

  const { rows } = await pool.query('select id, email, password_hash from public.admins where lower(email) = $1', [emailNorm]);
  const admin = rows[0];
  if (!admin) return res.status(401).json({ error: 'wrong_password' });

  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'wrong_password' });

  req.session.authed = true;
  req.session.admin_id = admin.id;
  req.session.admin_email = admin.email;
  res.json({ ok: true, email: admin.email, id: admin.id });
}));

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({
    authed: !!(req.session && req.session.authed),
    email: req.session && req.session.admin_email,
    id: req.session && req.session.admin_id,
  });
});

app.get('/api/admins', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('select id, email, created_at from public.admins order by created_at asc');
  res.json(rows);
}));

app.post('/api/admins', requireAuth, ah(async (req, res) => {
  const { email, password } = req.body || {};
  const emailNorm = (email || '').trim().toLowerCase();
  if (!emailNorm) return res.status(400).json({ error: 'email_required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'weak_password' });

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    'insert into public.admins (email, password_hash) values ($1,$2) returning id, email, created_at',
    [emailNorm, passwordHash]
  );
  res.json(rows[0]);
}));

app.delete('/api/admins/:id', requireAuth, ah(async (req, res) => {
  if (req.params.id === req.session.admin_id) return res.status(400).json({ error: 'cannot_delete_self' });
  const { rows: countRows } = await pool.query('select count(*)::int as n from public.admins');
  if (countRows[0].n <= 1) return res.status(400).json({ error: 'cannot_delete_last_admin' });
  await pool.query('delete from public.admins where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Public — called anonymously by the browser gate on all 27 tool sites. Mirrors
// the contract the n8n webhook used to fulfill: POST {email, phone} ->
// {verified, display_name, member: {buyer_name}, reason, tools_enabled}.
app.post('/api/verify-membership', ah(async (req, res) => {
  const { email, phone } = req.body || {};
  const emailNorm = (email || '').trim().toLowerCase();
  const phoneNorm = normalizePhone(phone);

  if (!emailNorm && !phoneNorm) return res.status(400).json({ verified: false, reason: 'invalid' });

  const { rows } = await pool.query(
    `select display_name, buyer_name, status, tools_enabled
     from public.members
     where ($1 <> '' and lower(email) = $1) or ($2 <> '' and regexp_replace(coalesce(phone,''), '\\D', '', 'g') = $2)
     limit 1`,
    [emailNorm, phoneNorm]
  );
  const member = rows[0];

  if (!member) return res.json({ verified: false, reason: 'not_found' });
  if (member.status !== 'active') return res.json({ verified: false, reason: 'inactive' });

  res.json({
    verified: true,
    display_name: member.display_name || member.buyer_name || undefined,
    member: { buyer_name: member.buyer_name || member.display_name },
    tools_enabled: member.tools_enabled,
  });
}));

app.get('/api/members', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `select id, email, phone, buyer_name, display_name, status, tools_enabled,
            source, access_days, access_expires_at, created_at, updated_at
     from public.members order by created_at desc limit 500`
  );
  res.json(rows);
}));

app.post('/api/members', requireAuth, ah(async (req, res) => {
  const { email, phone, buyer_name, display_name, status, source, access_days } = req.body || {};
  if (!email && !phone) return res.status(400).json({ error: 'email_or_phone_required' });

  const plainPassword = genPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);
  const days = Number.isFinite(access_days) ? access_days : (access_days ? parseInt(access_days, 10) : null);
  const expiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;

  const { rows } = await pool.query(
    `insert into public.members (email, phone, buyer_name, display_name, status, source, password_hash, access_days, access_expires_at)
     values ($1,$2,$3,$4,coalesce($5,'active'),$6,$7,$8,$9)
     returning id, email, phone, buyer_name, display_name, status, tools_enabled, source, access_days, access_expires_at, created_at`,
    [email || null, phone || null, buyer_name || null, display_name || null, status || null, source || null, passwordHash, days, expiresAt]
  );
  res.json({ ...rows[0], generated_password: plainPassword });
}));

app.patch('/api/members/:id', requireAuth, ah(async (req, res) => {
  const { id } = req.params;
  const { email, phone, buyer_name, display_name, status, tools_enabled, source, access_days, regenerate_password } = req.body || {};

  const days = access_days === undefined ? undefined : (access_days ? parseInt(access_days, 10) : null);
  const expiresAt = days === undefined ? undefined : (days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null);

  let plainPassword = null;
  let passwordHash;
  if (regenerate_password) {
    plainPassword = genPassword();
    passwordHash = await bcrypt.hash(plainPassword, 10);
  }

  const fields = [];
  const values = [];
  let i = 1;
  const set = (col, val) => { fields.push(`${col} = $${i++}`); values.push(val); };

  if (email !== undefined) set('email', email || null);
  if (phone !== undefined) set('phone', phone || null);
  if (buyer_name !== undefined) set('buyer_name', buyer_name || null);
  if (display_name !== undefined) set('display_name', display_name || null);
  if (status !== undefined) set('status', status);
  if (tools_enabled !== undefined) set('tools_enabled', !!tools_enabled);
  if (source !== undefined) set('source', source || null);
  if (days !== undefined) { set('access_days', days); set('access_expires_at', expiresAt); }
  if (passwordHash) set('password_hash', passwordHash);
  set('updated_at', new Date().toISOString());

  if (fields.length === 0) return res.status(400).json({ error: 'no_fields' });

  values.push(id);
  const { rows } = await pool.query(
    `update public.members set ${fields.join(', ')} where id = $${i}
     returning id, email, phone, buyer_name, display_name, status, tools_enabled, source, access_days, access_expires_at, updated_at`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ ...rows[0], generated_password: plainPassword });
}));

app.delete('/api/members/:id', requireAuth, ah(async (req, res) => {
  await pool.query('delete from public.members where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/plans', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `select id, name, subtitle, badge, price_cents, currency, billing_period, cta_label,
            features, is_featured, is_active, sort_order, mp_preference_id, created_at, updated_at
     from public.pricing_plans order by sort_order asc, created_at asc`
  );
  res.json(rows);
}));

app.post('/api/plans', requireAuth, ah(async (req, res) => {
  const { name, subtitle, badge, price_cents, billing_period, cta_label, features, is_featured, is_active, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name_required' });
  const { rows } = await pool.query(
    `insert into public.pricing_plans (name, subtitle, badge, price_cents, billing_period, cta_label, features, is_featured, is_active, sort_order)
     values ($1,$2,$3,$4,coalesce($5,'one_time'),coalesce($6,'Criar conta grátis'),coalesce($7,'[]'::jsonb),coalesce($8,false),coalesce($9,true),coalesce($10,0))
     returning *`,
    [name, subtitle || null, badge || null, price_cents || 0, billing_period || null, cta_label || null,
     JSON.stringify(features || []), !!is_featured, is_active === undefined ? true : !!is_active, sort_order || 0]
  );
  res.json(rows[0]);
}));

app.patch('/api/plans/:id', requireAuth, ah(async (req, res) => {
  const { id } = req.params;
  const { name, subtitle, badge, price_cents, billing_period, cta_label, features, is_featured, is_active, sort_order } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  const set = (col, val) => { fields.push(`${col} = $${i++}`); values.push(val); };

  if (name !== undefined) set('name', name);
  if (subtitle !== undefined) set('subtitle', subtitle || null);
  if (badge !== undefined) set('badge', badge || null);
  if (price_cents !== undefined) set('price_cents', price_cents);
  if (billing_period !== undefined) set('billing_period', billing_period);
  if (cta_label !== undefined) set('cta_label', cta_label);
  if (features !== undefined) set('features', JSON.stringify(features));
  if (is_featured !== undefined) set('is_featured', !!is_featured);
  if (is_active !== undefined) set('is_active', !!is_active);
  if (sort_order !== undefined) set('sort_order', sort_order);

  if (fields.length === 0) return res.status(400).json({ error: 'no_fields' });
  values.push(id);
  const { rows } = await pool.query(
    `update public.pricing_plans set ${fields.join(', ')} where id = $${i} returning *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
}));

app.delete('/api/plans/:id', requireAuth, ah(async (req, res) => {
  await pool.query('delete from public.pricing_plans where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, 'public')));

// Central error handler — must be registered last. Any error passed to next()
// (including from the ah() wrapper) lands here instead of crashing the process
// or leaking a raw stack trace to the client.
app.use((err, req, res, next) => {
  console.error('Request error:', err);
  if (err && err.code === '23505') {
    if (err.constraint === 'admins_email_key') return res.status(409).json({ error: 'admin_email_taken' });
    return res.status(409).json({ error: 'duplicate_email_or_phone' });
  }
  res.status(500).json({ error: 'internal_error' });
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection (process kept alive):', err));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`admin-membros listening on ${port}`));
