import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const certsDir = path.join(projectRoot, 'certs');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const SHELL = process.env.SHELL_CMD || process.env.SHELL || '/bin/bash';
const WORKDIR = process.env.WORKDIR || projectRoot;
const TOKEN = process.env.TERMINAL_TOKEN || '';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '';

const app = express();
app.disable('x-powered-by');
app.use(express.static(publicDir, {
  extensions: ['html']
}));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, shell: SHELL, workdir: WORKDIR });
});

// ── URL proxy ───────────────────────────────────────────────────────
// Fetches external URLs server-side to bypass CORS restrictions.
// Used by html-display component to render web pages on VR monitors.
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'missing url param' });
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrbitalStation/1.0)' }
    });
    const contentType = resp.headers.get('content-type') || 'text/html';
    const body = await resp.text();
    res.setHeader('Content-Type', contentType);
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Use HTTPS if certs exist, otherwise fall back to HTTP
const certPath = process.env.TLS_CERT || path.join(certsDir, 'cert.pem');
const keyPath = process.env.TLS_KEY || path.join(certsDir, 'key.pem');
let server;
let usesTLS = false;

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  server = https.createServer({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  }, app);
  usesTLS = true;
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server, path: '/pty' });

function isOriginAllowed(origin) {
  if (!ALLOW_ORIGIN) return true;
  return origin === ALLOW_ORIGIN;
}

wss.on('connection', (socket, request) => {
  const origin = request.headers.origin || '';
  if (!isOriginAllowed(origin)) {
    socket.close(1008, 'origin not allowed');
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = url.searchParams.get('token') || '';
  if (TOKEN && token !== TOKEN) {
    socket.close(1008, 'invalid token');
    return;
  }

  const cols = clampInt(url.searchParams.get('cols'), 120, 40, 240);
  const rows = clampInt(url.searchParams.get('rows'), 34, 12, 80);

  const term = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: WORKDIR,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
  });

  const send = (payload) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  send({
    type: 'hello',
    cols,
    rows,
    shell: SHELL,
    cwd: WORKDIR
  });

  term.onData((data) => {
    send({ type: 'output', data });
  });

  term.onExit(({ exitCode, signal }) => {
    send({ type: 'exit', exitCode, signal });
    try {
      socket.close();
    } catch {
      // noop
    }
  });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    switch (msg.type) {
      case 'input':
        if (typeof msg.data === 'string' && msg.data.length > 0) {
          term.write(msg.data);
        }
        break;
      case 'resize': {
        const nextCols = clampInt(msg.cols, cols, 20, 300);
        const nextRows = clampInt(msg.rows, rows, 6, 120);
        try {
          term.resize(nextCols, nextRows);
        } catch {
          // Some shells can briefly reject resize during teardown.
        }
        break;
      }
      case 'signal':
        if (msg.signal === 'SIGINT') term.kill('SIGINT');
        else if (msg.signal === 'SIGTERM') term.kill('SIGTERM');
        break;
      case 'stdin':
        if (typeof msg.data === 'string' && msg.data.length > 0) {
          term.write(msg.data);
        }
        break;
      default:
        break;
    }
  });

  const cleanup = () => {
    try {
      term.kill();
    } catch {
      // noop
    }
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

// ── HTTP/SSE fallback transport ──────────────────────────────────────
// visionOS Safari blocks WSS to self-signed certs but allows regular
// HTTPS (same cert the page was loaded from). SSE for output, POST for input.
const httpSessions = new Map();

app.get('/pty/stream', (req, res) => {
  const token = req.query.token || '';
  if (TOKEN && token !== TOKEN) {
    return res.status(403).json({ error: 'invalid token' });
  }

  const cols = clampInt(req.query.cols, 80, 40, 240);
  const rows = clampInt(req.query.rows, 24, 12, 80);
  const sessionId = crypto.randomUUID();

  const term = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: WORKDIR,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
  });

  httpSessions.set(sessionId, term);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  const sseWrite = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  sseWrite({
    type: 'hello',
    sessionId,
    cols,
    rows,
    shell: SHELL,
    cwd: WORKDIR
  });

  term.onData((data) => {
    sseWrite({ type: 'output', data });
  });

  term.onExit(({ exitCode, signal }) => {
    sseWrite({ type: 'exit', exitCode, signal });
    httpSessions.delete(sessionId);
    res.end();
  });

  req.on('close', () => {
    httpSessions.delete(sessionId);
    try { term.kill(); } catch {}
  });
});

app.post('/pty/input', express.json(), (req, res) => {
  const { sessionId, data, type } = req.body;
  const term = httpSessions.get(sessionId);
  if (!term) return res.status(404).json({ error: 'session not found' });

  if (type === 'resize') {
    const nextCols = clampInt(req.body.cols, 80, 20, 300);
    const nextRows = clampInt(req.body.rows, 24, 6, 120);
    try { term.resize(nextCols, nextRows); } catch {}
  } else if (typeof data === 'string' && data.length > 0) {
    term.write(data);
  }

  res.json({ ok: true });
});

// ── Hot-swap channel (SSE) with persistence ─────────────────────────
// SSE side-channel for injecting code/entities into VR without page reload.
// Uses SSE instead of WebSocket because visionOS Safari blocks WSS to self-signed certs.
// All pushes are persisted to disk and replayed on new client connections.
const hotSwapClients = new Set();
const hotSwapStateFile = path.join(projectRoot, 'hot-swap-state.json');

function loadHotSwapState() {
  try {
    if (fs.existsSync(hotSwapStateFile)) {
      return JSON.parse(fs.readFileSync(hotSwapStateFile, 'utf8'));
    }
  } catch {}
  return [];
}

function saveHotSwapState(state) {
  fs.writeFileSync(hotSwapStateFile, JSON.stringify(state, null, 2));
}

const hotSwapState = loadHotSwapState();
console.log(`[hot-swap] loaded ${hotSwapState.length} persisted entries`);

app.get('/hot-swap/stream', (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  // Replay persisted state to new client
  for (const entry of hotSwapState) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  hotSwapClients.add(res);
  console.log(`[hot-swap] SSE client connected (${hotSwapClients.size} total), replayed ${hotSwapState.length} entries`);
  _req.on('close', () => {
    hotSwapClients.delete(res);
    console.log(`[hot-swap] SSE client disconnected (${hotSwapClients.size} total)`);
  });
});

function broadcastHotSwap(payload) {
  const msg = JSON.stringify(payload);
  let sent = 0;
  for (const client of hotSwapClients) {
    try {
      client.write(`data: ${msg}\n\n`);
      sent++;
    } catch {}
  }
  return sent;
}

// Push arbitrary JS/entities to all connected VR clients and persist
app.post('/hot-swap/push', express.json({ limit: '1mb' }), (req, res) => {
  const { code, entities, remove } = req.body;
  const payload = {};
  if (code) payload.type = 'eval';
  if (entities) payload.type = 'entities';
  if (remove) payload.type = 'remove';
  Object.assign(payload, req.body);
  if (!payload.type) payload.type = 'eval';

  // Persist: tagged entities replace previous entries with same tag
  const persist = req.body.persist !== false; // default true
  if (persist) {
    if (payload.tag && (payload.type === 'entities' || payload.type === 'eval')) {
      // Replace existing entry with same tag
      const idx = hotSwapState.findIndex(e => e.tag === payload.tag);
      if (idx >= 0) hotSwapState[idx] = payload;
      else hotSwapState.push(payload);
    } else if (payload.type === 'remove' && payload.selector) {
      // Remove matching persisted entries by tag
      const tagMatch = payload.selector.match(/\[data-hotswap[=]"?([^"\]]+)"?\]/);
      if (tagMatch) {
        const tag = tagMatch[1];
        const idx = hotSwapState.findIndex(e => e.tag === tag);
        if (idx >= 0) hotSwapState.splice(idx, 1);
      }
      hotSwapState.push(payload);
    } else {
      hotSwapState.push(payload);
    }
    saveHotSwapState(hotSwapState);
  }

  const sent = broadcastHotSwap(payload);
  console.log(`[hot-swap] pushed to ${sent} client(s), ${hotSwapState.length} persisted entries`);
  res.json({ ok: true, clients: sent, persisted: hotSwapState.length });
});

// View persisted state
app.get('/hot-swap/state', (_req, res) => {
  res.json(hotSwapState);
});

// Clear persisted state
app.delete('/hot-swap/state', (_req, res) => {
  hotSwapState.length = 0;
  saveHotSwapState(hotSwapState);
  res.json({ ok: true, cleared: true });
});

server.listen(PORT, HOST, () => {
  const proto = usesTLS ? 'https' : 'http';
  console.log(`VR terminal server listening on ${proto}://${HOST}:${PORT}`);
  console.log(`Shell: ${SHELL}`);
  console.log(`Workdir: ${WORKDIR}`);
  if (usesTLS) console.log('TLS: enabled');
  if (TOKEN) console.log('Token protection: enabled');
  if (ALLOW_ORIGIN) console.log(`Allowed origin: ${ALLOW_ORIGIN}`);
});

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
