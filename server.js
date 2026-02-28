const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const APPS_DIR = path.join(__dirname, 'apps');
const CONSTITUTION = fs.readFileSync(path.join(__dirname, 'constitution.md'), 'utf-8');

// Track in-progress builds: slug -> { process, clients: Set<res>, logs: string[] }
const builds = new Map();

// Ensure apps directory exists
fs.mkdirSync(APPS_DIR, { recursive: true });

// Serve static assets from public/
app.use('/public', express.static(path.join(__dirname, 'public')));

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SSE endpoint for generation progress
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
    // Send existing logs
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
  const fullPrompt = `${CONSTITUTION}\n\n## User request\n${prompt}`;

  fs.mkdirSync(appDir, { recursive: true });

  // Write prompt to temp file
  const promptFile = path.join(appDir, '.prompt.txt');
  fs.writeFileSync(promptFile, fullPrompt);

  // Use Python directly to avoid shell/pipe buffering issues
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
  // Close stdin so vibe doesn't wait for input
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
    buffer = lines.pop(); // Keep incomplete line in buffer

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
        // Not valid JSON, send as raw log
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
      broadcast({ type: 'done', slug });
    } else {
      // Clean up failed build
      fs.rmSync(appDir, { recursive: true, force: true });
      broadcast({ type: 'error', message: 'Generation failed. Try again.' });
    }

    for (const client of clients) {
      client.end();
    }
  });
});

// Serve generated apps or loading page
app.get('/:slug', (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!slug) {
    return res.status(400).send('Invalid URL');
  }

  const appFile = path.join(APPS_DIR, slug, 'index.html');

  if (fs.existsSync(appFile)) {
    return res.sendFile(appFile);
  }

  // Serve loading page — it will connect to SSE
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
  // Allow alphanumeric, hyphens, and underscores
  const slug = raw.toLowerCase().replace(/[^a-z0-9\-_]/g, '');
  if (!slug || slug.length > 200) return null;
  return slug;
}

function slugToPrompt(slug) {
  return slug.replace(/[-_]/g, ' ').trim();
}

function extractLogMessage(msg) {
  // Skip system and user messages (they're just our prompt echoed back)
  if (msg.role === 'system' || msg.role === 'user') return null;

  // Assistant message with tool calls (planning to write file, etc.)
  if (msg.role === 'assistant' && msg.tool_calls) {
    const tool = msg.tool_calls[0];
    if (tool?.function?.name === 'write_file') return 'Writing your app...';
    if (tool?.function?.name) return `Running ${tool.function.name}...`;
  }

  // Assistant text response
  if (msg.role === 'assistant' && msg.content) {
    return msg.content.substring(0, 300);
  }

  // Tool result
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
