'use strict';

// HTTP API and live event stream for the card program, plus the dashboard.
// No authentication: this is a local demo and binds to 127.0.0.1 by default.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { CardProgram, ValidationError, NotFoundError } = require('./program');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['dashboard.html', 'text/html; charset=utf-8'],
  '/dashboard.css': ['dashboard.css', 'text/css; charset=utf-8'],
  '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
};
const MAX_BODY_BYTES = 10 * 1024;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    // Requiring JSON keeps plain HTML forms on other sites from posting here.
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      reject(new HttpError(415, 'Send the request body as application/json.'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading but keep the socket open long enough to answer 413.
        req.removeAllListeners('data');
        req.pause();
        reject(new HttpError(413, 'The request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'The request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function createServer(program) {
  const streams = new Set();
  program.on('event', (event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of streams) res.write(frame);
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const { method } = req;

    if (method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
      fs.createReadStream(path.join(PUBLIC_DIR, file)).pipe(res);
      return;
    }
    if (parts[0] !== 'api') throw new HttpError(404, 'Not found.');

    if (parts.length === 2 && parts[1] === 'events' && method === 'GET') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      streams.add(res);
      const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(beat); streams.delete(res); });
      return;
    }
    if (parts.length === 2 && parts[1] === 'cards') {
      if (method === 'GET') return sendJson(res, 200, { issuer: program.issuer.name, cards: program.listCards() });
      if (method === 'POST') return sendJson(res, 201, await program.issueCard(await readJson(req)));
    }
    if (parts.length === 3 && parts[1] === 'cards' && method === 'PATCH') {
      return sendJson(res, 200, await program.updateCard(parts[2], await readJson(req)));
    }
    if (parts.length === 4 && parts[1] === 'cards' && parts[3] === 'authorizations' && method === 'POST') {
      return sendJson(res, 201, program.authorize(parts[2], await readJson(req)));
    }
    if (parts.length === 2 && parts[1] === 'transactions' && method === 'GET') {
      return sendJson(res, 200, { transactions: program.listTransactions() });
    }
    throw new HttpError(404, 'Not found.');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof ValidationError) return sendJson(res, 400, { error: err.message });
      if (err instanceof NotFoundError) return sendJson(res, 404, { error: err.message });
      if (err instanceof HttpError) {
        if (err.status === 413) res.on('finish', () => req.destroy());
        return sendJson(res, err.status, { error: err.message });
      }
      console.error(err);
      sendJson(res, 500, { error: 'Unexpected server error.' });
    });
  });
  server.on('close', () => { for (const res of streams) res.end(); });
  return server;
}

function loadIssuer(name) {
  if (name === 'simulator') return new (require('./issuer/simulator').SimulatorIssuer)();
  if (name === 'jpmorgan') return new (require('./issuer/jpmorgan').JPMorganIssuer)();
  throw new Error(`Unknown ISSUER "${name}". Use "simulator" or "jpmorgan".`);
}

if (require.main === module) {
  const issuer = loadIssuer(process.env.ISSUER || 'simulator');
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  createServer(new CardProgram(issuer)).listen(port, host, () => {
    console.log(`Tessera real-time card program (${issuer.name}) at http://${host}:${port}`);
  });
}

module.exports = { createServer, loadIssuer };
