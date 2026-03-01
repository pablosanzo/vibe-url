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
  const data = loadData();
  const version = data.constitutionVersion || 1;
  res.json({ content, version });
});

app.get('/admin/api/constitution/versions', requireAuth, (req, res) => {
  const data = loadData();
  const currentVersion = data.constitutionVersion || 1;
  const versions = [{ version: currentVersion, label: `v${currentVersion} (current)`, current: true }];

  // Read history files, sorted newest first
  if (fs.existsSync(CONSTITUTION_HISTORY_DIR)) {
    const files = fs.readdirSync(CONSTITUTION_HISTORY_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();

    for (let i = 0; i < files.length; i++) {
      const v = currentVersion - 1 - i;
      if (v < 1) break;
      versions.push({ version: v, label: `v${v}`, file: files[i], current: false });
    }
  }

  res.json({ versions });
});

app.get('/admin/api/constitution/versions/:version', requireAuth, (req, res) => {
  const data = loadData();
  const currentVersion = data.constitutionVersion || 1;
  const requestedVersion = parseInt(req.params.version);

  if (requestedVersion === currentVersion) {
    const content = fs.readFileSync(CONSTITUTION_FILE, 'utf-8');
    return res.json({ content, version: currentVersion });
  }

  // Find the right history file
  const files = fs.existsSync(CONSTITUTION_HISTORY_DIR)
    ? fs.readdirSync(CONSTITUTION_HISTORY_DIR).filter(f => f.endsWith('.md')).sort().reverse()
    : [];

  const idx = currentVersion - 1 - requestedVersion;
  if (idx < 0 || idx >= files.length) {
    return res.status(404).json({ error: 'Version not found' });
  }

  const content = fs.readFileSync(path.join(CONSTITUTION_HISTORY_DIR, files[idx]), 'utf-8');
  res.json({ content, version: requestedVersion });
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

  // Increment version
  const data = loadData();
  data.constitutionVersion = (data.constitutionVersion || 1) + 1;
  saveData(data);

  fs.writeFileSync(CONSTITUTION_FILE, content);
  res.json({ ok: true, version: data.constitutionVersion });

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
        constitutionVersion: appData.constitutionVersion || null,
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

app.get('/api/generate/:slug', async (req, res) => {
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
  const buildData = loadData();
  const constitutionVersion = buildData.constitutionVersion || 1;

  fs.mkdirSync(appDir, { recursive: true });

  // Pre-research: check if this prompt needs real-world data, and fetch it
  let researchSection = '';
  if (mistral) {
    try {
      // Step 1: Does this need real-world data?
      const check = await mistral.chat.complete({
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: `Would building a web app for "${prompt}" benefit from real-world data that might not be in your training data (e.g., current dates, scores, schedules, prices, recent events)? Reply with just YES or NO.` }],
        temperature: 0,
      });
      const needsResearch = (check.choices[0].message.content || '').trim().toUpperCase().startsWith('YES');
      console.log(`[build:${slug}] needs research: ${needsResearch}`);

      if (needsResearch) {
        // Tell the client we're researching
        for (const c of clients) {
          c.write(`data: ${JSON.stringify({ type: 'phase', phase: 'researching' })}\n\n`);
        }

        // Step 2: Create a web search agent, fetch data, then clean up
        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${mistralKey}` };

        const agentRes = await fetch('https://api.mistral.ai/v1/agents', {
          method: 'POST', headers,
          body: JSON.stringify({ model: 'mistral-small-latest', name: 'vibe-url-researcher', tools: [{ type: 'web_search' }] }),
        });
        const agent = await agentRes.json();

        const convRes = await fetch('https://api.mistral.ai/v1/conversations', {
          method: 'POST', headers,
          body: JSON.stringify({ agent_id: agent.id, stream: false, inputs: `I'm building a web app for: "${prompt}". Search the web and provide all the relevant real-world data I need (dates, names, facts, numbers, etc.) in a concise format. Just the facts, no commentary.` }),
        });
        const conv = await convRes.json();

        const researchData = (conv.outputs || [])
          .filter(o => o.type === 'message.output')
          .flatMap(o => (o.content || []).filter(c => c.type === 'text').map(c => c.text))
          .join('\n')
          .trim();

        // Clean up agent
        fetch(`https://api.mistral.ai/v1/agents/${agent.id}`, { method: 'DELETE', headers }).catch(() => {});

        if (researchData) {
          researchSection = `\n\n## Research data (gathered from the web by the server)\nThe following real-world data was pre-fetched for accuracy. Use it to build the app:\n\n${researchData}`;
          console.log(`[build:${slug}] research fetched: ${researchData.length} chars`);
        }
      }
    } catch (err) {
      console.log(`[build:${slug}] research failed (continuing without): ${err.message}`);
    }
  }

  const fullPrompt = `${constitution}${researchSection}\n\n## User request\n${prompt}`;

  const promptFile = path.join(appDir, '.prompt.txt');
  fs.writeFileSync(promptFile, fullPrompt);

  // Tell client we're now building
  const broadcast0 = (data) => { for (const c of clients) c.write(`data: ${JSON.stringify(data)}\n\n`); };
  broadcast0({ type: 'phase', phase: 'building' });

  const vibePath = require('child_process').execSync('which vibe').toString().trim();
  const vibeProcess = spawn(vibePath, [
    '--agent', 'vibeurl',
    '--output', 'streaming',
    '--max-turns', '30',
    '--max-price', '2.00',
    '-p', fullPrompt,
  ], {
    cwd: appDir,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  vibeProcess.stdin.end();

  const buildStartTime = Date.now();
  builds.set(slug, { process: vibeProcess, clients, logs });

  // Calculate average build duration from past successful builds
  const avgDuration = (() => {
    const data = loadData();
    const durations = Object.values(data.apps || {}).map(a => a.buildDuration).filter(Boolean);
    if (durations.length === 0) return 60;
    return Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
  })();

  // Send estimate to client so loading page can calibrate the progress bar
  res.write(`data: ${JSON.stringify({ type: 'estimate', duration: avgDuration })}\n\n`);

  const broadcast = (data) => {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      client.write(msg);
    }
  };

  let buffer = '';
  let stderrBuffer = '';
  let turnCount = 0;
  let rawMessages = [];

  vibeProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        rawMessages.push(msg);
        if (msg.role === 'assistant') turnCount++;
        const logLine = extractLogMessage(msg);
        if (logLine) logs.push(logLine);
      } catch {
        if (line.trim()) logs.push(line.trim());
      }
    }
  });

  vibeProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      stderrBuffer += text + '\n';
      logs.push(text);
    }
  });

  vibeProcess.on('close', (code) => {
    builds.delete(slug);

    // Log build outcome for debugging
    const hasIndex = fs.existsSync(appFile);
    const appFiles = fs.existsSync(appDir) ? fs.readdirSync(appDir).filter(f => !f.startsWith('.')) : [];
    console.log(`[build:${slug}] exit=${code} turns=${turnCount} files=[${appFiles.join(',')}] hasIndex=${hasIndex}`);
    if (code !== 0 || !hasIndex) {
      console.log(`[build:${slug}] FAILED — stderr: ${stderrBuffer.trim().slice(-500)}`);
      console.log(`[build:${slug}] last 3 messages:`, rawMessages.slice(-3).map(m => ({ role: m.role, tool_calls: m.tool_calls?.[0]?.function?.name, content: (m.content || '').slice(0, 200) })));
    }

    if (code === 0 && hasIndex) {
      const buildDuration = Math.round((Date.now() - buildStartTime) / 1000);
      const data = loadData();
      if (!data.apps[slug]) data.apps[slug] = {};
      data.apps[slug].createdAt = new Date().toISOString();
      data.apps[slug].visits = 0;
      data.apps[slug].constitutionVersion = constitutionVersion;
      data.apps[slug].buildDuration = buildDuration;
      saveData(data);
      console.log(`[build:${slug}] completed in ${buildDuration}s`);

      broadcast({ type: 'done', slug });
    } else {
      fs.rmSync(appDir, { recursive: true, force: true });
      broadcast({ type: 'error', message: `Generation failed (exit ${code}, ${turnCount} turns). Try again.` });
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

    // Inject branding bar (replace LAST </body> — some apps have it in JS strings)
    let html = fs.readFileSync(appFile, 'utf-8');
    const lastIdx = html.lastIndexOf('</body>');
    if (lastIdx !== -1) {
      html = html.slice(0, lastIdx) + brandingBar(slug) + html.slice(lastIdx);
    }
    res.type('html').send(html);
    return;
  }

  res.sendFile(path.join(__dirname, 'public', 'loading.html'));
});

// Serve static assets within generated apps (any depth)
app.get('/:slug/{*filepath}', (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!slug) return res.status(400).send('Invalid URL');

  // filepath is an array of path segments in Express 5
  const segments = Array.isArray(req.params.filepath) ? req.params.filepath : [req.params.filepath];
  const subPath = segments.join('/');
  if (!subPath) return res.status(404).send('Not found');

  // Prevent directory traversal
  const resolved = path.resolve(path.join(APPS_DIR, slug, subPath));
  if (!resolved.startsWith(path.resolve(path.join(APPS_DIR, slug)))) {
    return res.status(403).send('Forbidden');
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return res.sendFile(resolved);
  }
  res.status(404).send('Not found');
});

// --- Helpers ---

function sanitizeSlug(raw) {
  const slug = raw.toLowerCase().replace(/[^a-z0-9\-_]/g, '');
  if (!slug || slug.length > 2000) return null;
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
<style id="vibe-bar-styles">
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&display=swap');
  @keyframes vibe-slide-up{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
  #vibe-bar,#vibe-bar *{all:initial;box-sizing:border-box}
  #vibe-bar{
    position:fixed!important;top:12px!important;left:12px!important;z-index:99999!important;
    font-family:'Space Grotesk','Segoe UI',system-ui,sans-serif!important;font-size:13px!important;
    line-height:normal!important;letter-spacing:normal!important;text-transform:none!important;
    display:flex!important;align-items:center!important;gap:6px!important;
    background:rgba(10,10,11,0.92)!important;backdrop-filter:blur(12px)!important;
    border:1px solid rgba(255,255,255,0.08)!important;border-radius:40px!important;
    padding:6px 6px 6px 16px!important;color:#e8e8ed!important;
    box-shadow:0 4px 24px rgba(0,0,0,0.4)!important;
    animation:vibe-slide-up 0.4s ease!important;
  }
  #vibe-bar a,#vibe-bar button{font-family:'Space Grotesk','Segoe UI',system-ui,sans-serif!important;font-size:12px!important;font-weight:500!important;text-decoration:none!important;cursor:pointer!important;line-height:normal!important;letter-spacing:normal!important;color:inherit!important}
  #vibe-bar .vb-btn{display:flex!important;align-items:center!important;gap:5px!important;border:none!important;border-radius:32px!important;padding:7px 14px!important;transition:all 0.15s!important}
  #vibe-bar .vb-share{background:#ff6b2b!important;color:#fff!important;position:relative!important}
  #vibe-bar .vb-share:hover{opacity:0.9!important}
  #vibe-bar .vb-improve{background:transparent!important;color:#6b6b76!important}
  #vibe-bar .vb-improve:hover{color:#e8e8ed!important;background:rgba(255,255,255,0.06)!important}
  #vibe-bar .vb-logo{font-weight:700!important;font-size:15px!important;color:#e8e8ed!important;margin-right:6px!important;text-decoration:none!important;position:relative!important;white-space:nowrap!important}
  #vibe-bar .vb-logo span{color:#ff6b2b!important}
  #vibe-bar .vb-tooltip{
    all:initial!important;font-family:'Space Grotesk','Segoe UI',system-ui,sans-serif!important;
    position:absolute!important;top:calc(100% + 10px)!important;left:0!important;
    background:rgba(17,17,19,0.96)!important;backdrop-filter:blur(12px)!important;
    border:1px solid rgba(255,255,255,0.08)!important;border-radius:8px!important;
    padding:8px 12px!important;white-space:nowrap!important;
    font-size:11px!important;font-weight:500!important;color:#a1a1aa!important;
    box-shadow:0 8px 24px rgba(0,0,0,0.5)!important;
    opacity:0!important;pointer-events:none!important;transform:translateY(-4px)!important;
    transition:opacity 0.15s,transform 0.15s!important;
  }
  #vibe-bar .vb-logo:hover .vb-tooltip{opacity:1!important;transform:translateY(0)!important}
  #vibe-bar .vb-dropdown{
    all:initial!important;font-family:'Space Grotesk','Segoe UI',system-ui,sans-serif!important;
    display:none!important;position:absolute!important;top:calc(100% + 8px)!important;right:0!important;
    background:rgba(17,17,19,0.96)!important;backdrop-filter:blur(12px)!important;
    border:1px solid rgba(255,255,255,0.08)!important;border-radius:10px!important;
    padding:4px!important;min-width:180px!important;
    box-shadow:0 8px 32px rgba(0,0,0,0.5)!important;
  }
  #vibe-bar .vb-dropdown.open{display:block!important}
  #vibe-bar .vb-dropdown a{
    display:flex!important;align-items:center!important;gap:8px!important;padding:8px 12px!important;border-radius:7px!important;
    color:#e8e8ed!important;font-size:12px!important;font-weight:500!important;white-space:nowrap!important;
  }
  #vibe-bar .vb-dropdown a:hover{background:rgba(255,255,255,0.06)!important}
  #vibe-bar .vb-dropdown .vb-dim{color:#6b6b76!important}
</style>
<div id="vibe-bar">
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
