const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
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
  name: 'member_session',
  secret: SESSION_SECRET,
  maxAge: 30 * 24 * 60 * 60 * 1000,
  sameSite: 'lax',
  httpOnly: true,
}));

function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e);
}

app.post('/api/register', ah(async (req, res) => {
  const { email, password, display_name } = req.body || {};
  const emailNorm = (email || '').trim().toLowerCase();

  if (!validEmail(emailNorm)) return res.status(400).json({ error: 'invalid_email' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'weak_password' });

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `insert into public.members (email, display_name, status, tools_enabled, source, password_hash)
     values ($1, $2, 'pending', false, 'self_signup', $3)
     returning id, email, display_name, status, tools_enabled`,
    [emailNorm, display_name || null, passwordHash]
  );

  // Not logging them in: access is gated on admin approval (status -> active).
  res.json({ ok: true, pending: true, member: rows[0] });
}));

app.post('/api/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const emailNorm = (email || '').trim().toLowerCase();
  if (!emailNorm || !password) return res.status(400).json({ error: 'missing_credentials' });

  const { rows } = await pool.query(
    `select id, email, display_name, status, tools_enabled, password_hash
     from public.members where lower(email) = $1 limit 1`,
    [emailNorm]
  );
  const member = rows[0];
  if (!member || !member.password_hash) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = await bcrypt.compare(password, member.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
  if (member.status === 'pending') return res.status(403).json({ error: 'pending_approval' });
  if (member.status !== 'active') return res.status(403).json({ error: 'inactive' });

  req.session.member_id = member.id;
  res.json({
    ok: true,
    member: { id: member.id, email: member.email, display_name: member.display_name, tools_enabled: member.tools_enabled },
  });
}));

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/session', ah(async (req, res) => {
  if (!req.session || !req.session.member_id) return res.json({ authed: false });
  const { rows } = await pool.query(
    `select id, email, display_name, status, tools_enabled from public.members where id = $1`,
    [req.session.member_id]
  );
  if (!rows[0] || rows[0].status !== 'active') return res.json({ authed: false });
  res.json({ authed: true, member: rows[0] });
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error('Request error:', err);
  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'email_already_registered' });
  }
  res.status(500).json({ error: 'internal_error' });
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection (process kept alive):', err));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`comunidade-login listening on ${port}`));
