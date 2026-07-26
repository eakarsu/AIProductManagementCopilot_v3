import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexPath = path.join(projectRoot, 'public', 'index.html');

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 65_536) throw new Error('request body is too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function sql(sqlText, variables = {}) {
  return new Promise((resolve, reject) => {
    const args = [process.env.DATABASE_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t'];
    for (const [key, value] of Object.entries(variables)) args.push('-v', `${key}=${value}`);
    const child = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `psql exited ${code}`)));
    child.stdin.end(sqlText);
  });
}

function passwordDigest(password, salt = randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password, encoded) {
  const [scheme, salt, expectedHex] = String(encoded || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function issueToken(user) {
  const body = Buffer.from(JSON.stringify({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const signature = createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(req) {
  try {
    const value = req.headers.authorization || '';
    if (!value.startsWith('Bearer ')) return null;
    const [body, signature] = value.slice(7).split('.');
    if (!body || !signature) return null;
    const expected = createHmac('sha256', process.env.JWT_SECRET).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

async function bootstrapRuntime() {
  if (process.env.MIGRATE_ON_START !== 'true') return;
  for (const required of ['DATABASE_URL', 'JWT_SECRET', 'PROVISION_ADMIN_EMAIL', 'PROVISION_ADMIN_PASSWORD']) {
    if (!process.env[required]) throw new Error(`${required} is required`);
  }
  await sql(`
    CREATE TABLE IF NOT EXISTS runtime_pm_users (
      id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
      password_hash text NOT NULL, role text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS runtime_pm_ai_results (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES runtime_pm_users(id),
      prompt text NOT NULL, result_text text NOT NULL, model text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await sql(`
    INSERT INTO runtime_pm_users (id, email, name, password_hash, role)
    VALUES (gen_random_uuid(), :'email', :'name', :'password_hash', 'admin')
    ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, password_hash=EXCLUDED.password_hash, role='admin';
  `, {
    email: process.env.PROVISION_ADMIN_EMAIL.toLowerCase(),
    name: process.env.PROVISION_ADMIN_NAME || 'Runtime Admin',
    password_hash: passwordDigest(process.env.PROVISION_ADMIN_PASSWORD)
  });
}

export function validateDraft(body) {
  return typeof body.outcome !== 'string' || !body.outcome.trim() || typeof body.owner !== 'string' || !body.owner.trim() || !Array.isArray(body.evidenceIds) || body.evidenceIds.length === 0 ? 'outcome, owner, and at least one evidenceId are required' : null;
}

export function createDraft(body) {
  return { id: randomUUID(), status: 'proposed', outcome: body.outcome.trim(), owner: body.owner.trim(), evidenceIds: body.evidenceIds, createdAt: new Date().toISOString() };
}

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, { status: 'ok', service: 'product-management-copilot-v3' });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/demo-credentials') {
        if (process.env.NODE_ENV === 'production') return json(res, 404, { error: 'not found' });
        const email = process.env.DEMO_EMAIL || process.env.PROVISION_ADMIN_EMAIL;
        const password = process.env.DEMO_PASSWORD || process.env.PROVISION_ADMIN_PASSWORD;
        return email && password
          ? json(res, 200, { email, password })
          : json(res, 503, { error: 'Demo credentials are not configured' });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(req);
        const row = await sql("SELECT id, email, name, role, password_hash FROM runtime_pm_users WHERE lower(email)=lower(:'email') LIMIT 1", { email: String(body.email || '') });
        if (!row) return json(res, 401, { error: 'invalid credentials' });
        const [id, email, name, role, passwordHash] = row.split('\t');
        if (!passwordMatches(String(body.password || ''), passwordHash)) return json(res, 401, { error: 'invalid credentials' });
        const user = { id, email, name, role };
        return json(res, 200, { token: issueToken(user), user });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const identity = verifyToken(req);
        if (!identity) return json(res, 401, { error: 'authentication required' });
        const row = await sql("SELECT id, email, name, role FROM runtime_pm_users WHERE id=:'id'::uuid LIMIT 1", { id: identity.sub });
        if (!row) return json(res, 401, { error: 'user no longer exists' });
        const [id, email, name, role] = row.split('\t');
        return json(res, 200, { user: { id, email, name, role } });
      }
      if (req.method === 'POST' && url.pathname === '/api/ai/product-brief') {
        const identity = verifyToken(req);
        if (!identity) return json(res, 401, { error: 'authentication required' });
        const body = await readJson(req);
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return json(res, 400, { error: 'prompt is required' });
        const response = await fetch(`${process.env.OPENROUTER_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: process.env.OPENROUTER_MODEL, messages: [{ role: 'system', content: 'Write a concise product brief.' }, { role: 'user', content: prompt }] })
        });
        if (!response.ok) throw new Error(`OpenRouter request failed with HTTP ${response.status}`);
        const upstream = await response.json();
        const content = upstream.choices?.[0]?.message?.content?.trim();
        if (!content) throw new Error('OpenRouter returned no substantive content');
        const id = randomUUID();
        await sql("INSERT INTO runtime_pm_ai_results (id,user_id,prompt,result_text,model) VALUES (:'id'::uuid,:'user_id'::uuid,:'prompt',:'result',:'model')", {
          id, user_id: identity.sub, prompt, result: content, model: process.env.OPENROUTER_MODEL
        });
        return json(res, 200, { id, content, model: process.env.OPENROUTER_MODEL });
      }
      if (req.method === 'GET' && url.pathname === '/api/ai/history') {
        const identity = verifyToken(req);
        if (!identity) return json(res, 401, { error: 'authentication required' });
        const count = await sql("SELECT count(*) FROM runtime_pm_ai_results WHERE user_id=:'user_id'::uuid", { user_id: identity.sub });
        return json(res, 200, { total: Number(count || 0) });
      }
      if (req.method === 'POST' && url.pathname === '/api/decisions') {
        const body = await readJson(req);
        const validationError = validateDraft(body);
        if (validationError) return json(res, 400, { error: validationError });
        return json(res, 201, { data: createDraft(body), warning: 'Local draft only; external execution is not connected.' });
      }
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 500;
      return json(res, status, { error: status === 400 ? 'invalid JSON body' : error.message });
    }
  });
}

export function createUiApp() {
  return createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(indexPath));
    }
    if (req.url?.startsWith('/api/')) {
      const body = ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : await readJson(req);
      const upstream = await fetch(`http://127.0.0.1:${process.env.BACKEND_PORT}${req.url}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization || '' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const content = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8' });
      return res.end(content);
    }
    return json(res, 404, { error: 'not found' });
  });
}

const isMainModule = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMainModule) {
  const port = Number(process.env.PORT || 3000);
  const mode = process.env.SERVICE_MODE || 'api';
  if (mode === 'api') await bootstrapRuntime();
  (mode === 'ui' ? createUiApp() : createApp()).listen(port, '127.0.0.1', () => {
    console.log(`AI Product Management Copilot v3 ${mode} listening on http://127.0.0.1:${port}`);
  });
}
