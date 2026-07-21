import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
        return json(res, 200, { status: 'ok', service: 'product-management-copilot-v3', scope: 'minimal-local-boundary' });
      }
      if (req.method === 'POST' && url.pathname === '/api/decisions') {
        const body = await readJson(req);
        const validationError = validateDraft(body);
        if (validationError) return json(res, 400, { error: validationError });
        const record = createDraft(body);
        return json(res, 201, { data: record, warning: 'Local draft only; external execution is not connected.' });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 500;
      return json(res, status, { error: status === 400 ? 'invalid JSON body' : error.message });
    }
  });
}

const isMainModule = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMainModule) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`AI Product Management Copilot v3 minimal boundary listening on http://127.0.0.1:${port}`);
  });
}
