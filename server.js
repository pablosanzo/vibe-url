const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const { Mistral } = require('@mistralai/mistralai');

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

// --- Mistral API client (reads key from vibe CLI config) ---

function getMistralKey() {
  try {
    const envFile = fs.readFileSync(path.join(require('os').homedir(), '.vibe', '.env'), 'utf-8');
    const match = envFile.match(/MISTRAL_API_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

const mistralKey = getMistralKey();
const mistral = mistralKey ? new Mistral({ apiKey: mistralKey }) : null;

async function generateConstitutionSummary() {
  if (!mistral) {
    console.error('No Mistral API key found, skipping constitution summary generation');
    return;
  }
  try {
    const constitution = fs.readFileSync(CONSTITUTION_FILE, 'utf-8');
    const result = await mistral.chat.complete({
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: `You are summarizing a "constitution" — a set of rules that governs how an AI generates web apps on vibe-url.com.\n\nCreate a concise summary as 5-8 bullet points for end users visiting the site. Focus on:\n- What they can expect from generated apps\n- What kinds of things are allowed and encouraged\n- What is NOT allowed (harmful content, etc.)\n- Any cool design/quality guarantees\n\nKeep it friendly, concise, and in lowercase style (matching the site's tone). Each bullet should be one short sentence. No markdown headers, just bullet points starting with •\n\nHere is the constitution:\n\n${constitution}` }],
    });
    const summary = result.choices[0].message.content.trim();
    const data = loadData();
    data.constitutionSummary = summary;
    data.summarizedAt = new Date().toISOString();
    saveData(data);
    console.log('Constitution summary generated');
  } catch (err) {
    console.error('Failed to generate constitution summary:', err.message);
  }
}

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
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
  res.json({ content, hash });
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

  // Regenerate summary in the background
  generateConstitutionSummary();
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
        constitutionHash: appData.constitutionHash || null,
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

// --- Public API ---

app.get('/api/constitution-summary', (req, res) => {
  const data = loadData();
  res.json({
    summary: data.constitutionSummary || null,
    summarizedAt: data.summarizedAt || null,
  });
});

app.get('/api/latest', (req, res) => {
  const data = loadData();
  const slugs = Object.entries(data.apps || {})
    .filter(([, v]) => v.createdAt)
    .sort((a, b) => new Date(b[1].createdAt) - new Date(a[1].createdAt))
    .slice(0, 30)
    .map(([slug]) => slug);
  res.json({ slugs });
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
  const constitutionHash = crypto.createHash('sha256').update(constitution).digest('hex').slice(0, 8);
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

  // Let the client know we're connected and working
  const startMsg = 'mistral vibe is generating your app';
  logs.push(startMsg);
  res.write(`data: ${JSON.stringify({ type: 'log', message: startMsg })}\n\n`);

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
      data.apps[slug].constitutionHash = constitutionHash;
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

    // Inject branding bar
    let html = fs.readFileSync(appFile, 'utf-8');
    html = html.replace('</body>', brandingBar(slug) + '</body>');
    res.type('html').send(html);
    return;
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

function brandingBar(slug) {
  const url = `https://vibe-url.com/${slug}`;
  const prompt = slugToPrompt(slug);
  const emojis = ['😯', '🤯', '😮', '😏', '😎', '🫢', '🤭', '😳', '🔥', '✨', '🪄', '💅'];
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  const shareText = encodeURIComponent(`I created an app just by typing in a URL ${emoji}\n\n${url}`);
  const improveUrl = `/?improve=${encodeURIComponent(slug)}`;

  return `
<div id="vibe-bar" style="
  position:fixed;top:12px;left:12px;z-index:99999;
  font-family:'Space Grotesk','Segoe UI',system-ui,sans-serif;font-size:13px;
  display:flex;align-items:center;gap:6px;
  background:rgba(10,10,11,0.92);backdrop-filter:blur(12px);
  border:1px solid rgba(255,255,255,0.08);border-radius:40px;
  padding:6px 6px 6px 16px;color:#e8e8ed;
  box-shadow:0 4px 24px rgba(0,0,0,0.4);
  animation:vibe-slide-up 0.4s ease;
">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&display=swap');
    @keyframes vibe-slide-up{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
    #vibe-bar a,#vibe-bar button{font-family:inherit;font-size:12px;font-weight:500;text-decoration:none;cursor:pointer}
    #vibe-bar .vb-btn{display:flex;align-items:center;gap:5px;border:none;border-radius:32px;padding:7px 14px;transition:all 0.15s}
    #vibe-bar .vb-share{background:#ff6b2b;color:#fff;position:relative}
    #vibe-bar .vb-share:hover{opacity:0.9}
    #vibe-bar .vb-improve{background:transparent;color:#6b6b76}
    #vibe-bar .vb-improve:hover{color:#e8e8ed;background:rgba(255,255,255,0.06)}
    #vibe-bar .vb-logo{font-weight:700;font-size:15px;color:#e8e8ed;margin-right:6px;text-decoration:none;position:relative}
    #vibe-bar .vb-logo span{color:#ff6b2b}
    #vibe-bar .vb-tooltip{
      position:absolute;top:calc(100% + 10px);left:0;
      background:rgba(17,17,19,0.96);backdrop-filter:blur(12px);
      border:1px solid rgba(255,255,255,0.08);border-radius:8px;
      padding:8px 12px;white-space:nowrap;
      font-size:11px;font-weight:500;color:#a1a1aa;
      box-shadow:0 8px 24px rgba(0,0,0,0.5);
      opacity:0;pointer-events:none;transform:translateY(-4px);
      transition:opacity 0.15s,transform 0.15s;
    }
    #vibe-bar .vb-logo:hover .vb-tooltip{opacity:1;transform:translateY(0)}
    #vibe-bar .vb-dropdown{
      display:none;position:absolute;top:calc(100% + 8px);right:0;
      background:rgba(17,17,19,0.96);backdrop-filter:blur(12px);
      border:1px solid rgba(255,255,255,0.08);border-radius:10px;
      padding:4px;min-width:180px;
      box-shadow:0 8px 32px rgba(0,0,0,0.5);
    }
    #vibe-bar .vb-dropdown.open{display:block}
    #vibe-bar .vb-dropdown a{
      display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:7px;
      color:#e8e8ed;font-size:12px;font-weight:500;white-space:nowrap;
    }
    #vibe-bar .vb-dropdown a:hover{background:rgba(255,255,255,0.06)}
    #vibe-bar .vb-dropdown .vb-dim{color:#6b6b76}
  </style>
  <a class="vb-logo" href="https://vibe-url.com">vibe<span>-</span>url<span class="vb-tooltip">Type any app idea in the URL, get it built instantly</span></a>
  <a class="vb-btn vb-improve" href="${improveUrl}">improve</a>
  <button class="vb-btn vb-share" onclick="document.getElementById('vibe-dd').classList.toggle('open')" type="button">
    share ▾
    <div class="vb-dropdown" id="vibe-dd">
      <a href="https://x.com/intent/post?text=${shareText}" target="_blank" rel="noopener">
        <span>𝕏</span> Share on X
      </a>
      <a href="https://wa.me/?text=${shareText}" target="_blank" rel="noopener">
        <span>💬</span> WhatsApp
      </a>
      <a href="#" onclick="event.preventDefault();event.stopPropagation();navigator.clipboard.writeText('${url}');this.textContent='Copied!';setTimeout(()=>{this.innerHTML='<span>🔗</span> Copy URL'},1500)">
        <span>🔗</span> Copy URL
      </a>
    </div>
  </button>
</div>
<script>document.addEventListener('click',function(e){if(!e.target.closest('#vibe-bar .vb-share'))document.getElementById('vibe-dd').classList.remove('open')})</script>
`;
}

function extractLogMessage(msg) {
  if (msg.role === 'system' || msg.role === 'user') return null;

  if (msg.role === 'assistant' && msg.tool_calls) {
    const tool = msg.tool_calls[0];
    if (tool?.function?.name === 'write_file') return 'writing your app';
    if (tool?.function?.name) return `running ${tool.function.name}`;
  }

  if (msg.role === 'assistant' && msg.content) {
    return msg.content.substring(0, 300).toLowerCase();
  }

  if (msg.role === 'tool' && msg.name === 'write_file') {
    return 'file written successfully';
  }
  if (msg.role === 'tool') {
    return `${(msg.name || 'tool')} completed`;
  }

  return null;
}

app.listen(PORT, () => {
  console.log(`vibe-url server running at http://localhost:${PORT}`);
});
