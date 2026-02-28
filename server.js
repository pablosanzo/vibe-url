const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const APPS_DIR = path.join(__dirname, 'apps');
const DATA_FILE = path.join(__dirname, 'data.json');
const CONSTITUTION_FILE = path.join(__dirname, 'constitution.md');
const CONSTITUTION_HISTORY_DIR = path.join(__dirname, 'constitution-history');

// --- Data persistence ---

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return { apps: {}, logins: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Initialize data file and constitution history
if (!fs.existsSync(DATA_FILE)) saveData({ apps: {}, logins: [] });
fs.mkdirSync(CONSTITUTION_HISTORY_DIR, { recursive: true });

// --- Auth ---

const USERS = {
  pablo: { password: hashPassword('vibe-pablo-2026') },
  francisca: { password: hashPassword('vibe-francisca-2026') },
};

const sessions = new Map(); // token -> { user, createdAt }

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (token && sessions.has(token)) {
    req.user = sessions.get(token).user;
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// --- Track in-progress builds ---

const builds = new Map();

// Ensure apps directory exists
fs.mkdirSync(APPS_DIR, { recursive: true });

// --- Middleware ---

app.use(cookieParser());
app.use(express.json());

// Serve static assets from public/
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- Admin routes (before /:slug catch-all) ---

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/constitution', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/projects', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (!user || user.password !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user: username, createdAt: Date.now() });

  // Log the login
  const data = loadData();
  data.logins.push({ user: username, timestamp: new Date().toISOString() });
  saveData(data);

  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true, user: username });
});

app.post('/admin/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) sessions.delete(token);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/admin/me', (req, res) => {
  const token = req.cookies?.session;
  if (token && sessions.has(token)) {
    return res.json({ user: sessions.get(token).user });
  }
  res.status(401).json({ error: 'Not logged in' });
});

app.get('/admin/api/constitution', requireAuth, (req, res) => {
  const content = fs.readFileSync(CONSTITUTION_FILE, 'utf-8');
  res.json({ content });
});

app.put('/admin/api/constitution', requireAuth, (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'Content required' });
  }

  // Archive current version before overwriting
  const current = fs.readFileSync(CONSTITUTION_FILE, 'utf-8');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(
    path.join(CONSTITUTION_HISTORY_DIR, `${timestamp}_${req.user}.md`),
    current
  );

  fs.writeFileSync(CONSTITUTION_FILE, content);
  res.json({ ok: true });
});

app.get('/admin/api/projects', requireAuth, (req, res) => {
  const data = loadData();
  const projects = [];

  // Read all directories in apps/
  if (fs.existsSync(APPS_DIR)) {
    const dirs = fs.readdirSync(APPS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      const slug = dir.name;
      const indexPath = path.join(APPS_DIR, slug, 'index.html');
      if (!fs.existsSync(indexPath)) continue;

      const stat = fs.statSync(indexPath);
      const appData = data.apps[slug] || {};

      projects.push({
        slug,
        createdAt: appData.createdAt || stat.birthtime.toISOString(),
        visits: appData.visits || 0,
      });
    }
  }

  // Sort by creation date, newest first
  projects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ projects });
});

app.delete('/admin/api/projects/:slug', requireAuth, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: 'Invalid slug' });

  const appDir = path.join(APPS_DIR, slug);
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
  }

  const data = loadData();
  delete data.apps[slug];
  saveData(data);

  res.json({ ok: true });
});

// --- Landing page ---

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- SSE endpoint for generation progress ---

app.get('/api/generate/:slug', (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!slug) {
    return res.status(400).json({ error: 'Invalid slug' });
  }

  const appDir = path.join(APPS_DIR, slug);
  const appFile = path.join(appDir, 'index.html');

  // Already built — tell client immediately
  if (fs.existsSync(appFile)) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'done', slug })}\n\n`);
    return res.end();
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // If build already in progress, attach to it
  if (builds.has(slug)) {
    const build = builds.get(slug);
    for (const log of build.logs) {
      res.write(`data: ${JSON.stringify({ type: 'log', message: log })}\n\n`);
    }
    build.clients.add(res);
    req.on('close', () => build.clients.delete(res));
    return;
  }

  // Start a new build
  const clients = new Set([res]);
  const logs = [];
  req.on('close', () => clients.delete(res));

  const prompt = slugToPrompt(slug);
  // Read constitution fresh each time (so admin edits take effect)
  const constitution = fs.readFileSync(CONSTITUTION_FILE, 'utf-8');
  const fullPrompt = `${constitution}\n\n## User request\n${prompt}`;

  fs.mkdirSync(appDir, { recursive: true });

  const promptFile = path.join(appDir, '.prompt.txt');
  fs.writeFileSync(promptFile, fullPrompt);

  const vibePath = require('child_process').execSync('which vibe').toString().trim();
  const vibeProcess = spawn(vibePath, [
    '--agent', 'vibeurl',
    '--output', 'streaming',
    '--max-turns', '15',
    '--max-price', '1.00',
    '-p', fullPrompt,
  ], {
    cwd: appDir,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  vibeProcess.stdin.end();

  builds.set(slug, { process: vibeProcess, clients, logs });

  const broadcast = (data) => {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      client.write(msg);
    }
  };

  let buffer = '';

  vibeProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const logLine = extractLogMessage(msg);
        if (logLine) {
          logs.push(logLine);
          broadcast({ type: 'log', message: logLine });
        }
      } catch {
        if (line.trim()) {
          logs.push(line.trim());
          broadcast({ type: 'log', message: line.trim() });
        }
      }
    }
  });

  vibeProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      logs.push(text);
      broadcast({ type: 'log', message: text });
    }
  });

  vibeProcess.on('close', (code) => {
    builds.delete(slug);

    if (code === 0 && fs.existsSync(appFile)) {
      // Record creation timestamp
      const data = loadData();
      if (!data.apps[slug]) data.apps[slug] = {};
      data.apps[slug].createdAt = new Date().toISOString();
      data.apps[slug].visits = 0;
      saveData(data);

      broadcast({ type: 'done', slug });
    } else {
      fs.rmSync(appDir, { recursive: true, force: true });
      broadcast({ type: 'error', message: 'Generation failed. Try again.' });
    }

    for (const client of clients) {
      client.end();
    }
  });
});

// --- Serve generated apps or loading page ---

app.get('/:slug', (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!slug) {
    return res.status(400).send('Invalid URL');
  }

  const appFile = path.join(APPS_DIR, slug, 'index.html');

  if (fs.existsSync(appFile)) {
    // Track visit
    const data = loadData();
    if (!data.apps[slug]) data.apps[slug] = {};
    data.apps[slug].visits = (data.apps[slug].visits || 0) + 1;
    saveData(data);

    return res.sendFile(appFile);
  }

  res.sendFile(path.join(__dirname, 'public', 'loading.html'));
});

// Serve static assets within generated apps
app.get('/:slug/:file', (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!slug) return res.status(400).send('Invalid URL');

  const filePath = path.join(APPS_DIR, slug, req.params.file);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  res.status(404).send('Not found');
});

// --- Helpers ---

function sanitizeSlug(raw) {
  const slug = raw.toLowerCase().replace(/[^a-z0-9\-_]/g, '');
  if (!slug || slug.length > 200) return null;
  return slug;
}

function slugToPrompt(slug) {
  return slug.replace(/[-_]/g, ' ').trim();
}

function extractLogMessage(msg) {
  if (msg.role === 'system' || msg.role === 'user') return null;

  if (msg.role === 'assistant' && msg.tool_calls) {
    const tool = msg.tool_calls[0];
    if (tool?.function?.name === 'write_file') return 'Writing your app...';
    if (tool?.function?.name) return `Running ${tool.function.name}...`;
  }

  if (msg.role === 'assistant' && msg.content) {
    return msg.content.substring(0, 300);
  }

  if (msg.role === 'tool' && msg.name === 'write_file') {
    return 'File written successfully';
  }
  if (msg.role === 'tool') {
    return `${msg.name || 'tool'} completed`;
  }

  return null;
}

app.listen(PORT, () => {
  console.log(`vibe-url server running at http://localhost:${PORT}`);
});
