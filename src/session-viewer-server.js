/**
 * Session Viewer Web Server
 *
 * Serves a web UI for viewing reverse-ollama session logs.
 *
 * Environment variables:
 *   - SESSION_VIEWER_HOST: Host to listen on (default: 127.0.0.1)
 *   - SESSION_VIEWER_PORT: Port to listen on (default: 3000)
 *   - SESSION_VIEWER_PASSWORD: Required password for basic auth (username: admin)
 *   - SESSION_LOG_DIR: Directory containing session files
 *
 * Usage:
 *   SESSION_VIEWER_HOST=0.0.0.0 SESSION_VIEWER_PORT=8080 SESSION_VIEWER_PASSWORD=secret123 node src/session-viewer-server.js
 */

import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { getSessionLogDir } from './session-log.js';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';

function getHost() {
  const host = (process.env.SESSION_VIEWER_HOST || '').trim();
  return host || DEFAULT_HOST;
}

function getPort() {
  const port = parseInt(process.env.SESSION_VIEWER_PORT || '', 10);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

function getPassword() {
  return process.env.SESSION_VIEWER_PASSWORD || '';
}

function isAuthEnabled() {
  return getPassword().length > 0;
}

function checkAuth(req) {
  if (!isAuthEnabled()) {
    return false;
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) {
    return false;
  }

  const encoded = authHeader.slice(6);
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const [username, password] = decoded.split(':');

  // Username is always 'admin', password is from env
  return username === 'admin' && password === getPassword();
}

function sendAuthChallenge(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Session Viewer"',
    'Content-Type': 'text/plain',
  });
  res.end('Authentication required');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// Parse JSONL file and return sessions with metadata
async function parseSessionFile(filePath) {
  const content = await readFile(filePath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);

  const sessions = [];
  for (const line of lines) {
    try {
      const session = JSON.parse(line);
      sessions.push(session);
    } catch {
      // Skip invalid lines
    }
  }

  return sessions;
}

function getSessionTokenUsage(session) {
  const entries = Array.isArray(session?.entries) ? session.entries : [];
  let inputTokens = 0;
  let outputTokens = 0;
  let foundUsage = false;

  for (const entry of entries) {
    if (entry?.type !== 'message' || entry?.message?.role !== 'assistant' || !entry?.message?.usage) {
      continue;
    }

    const usage = entry.message.usage;
    inputTokens += Number(usage.input ?? usage.prompt_tokens ?? usage.prompt_eval_count ?? 0) || 0;
    outputTokens += Number(usage.output ?? usage.completion_tokens ?? usage.eval_count ?? 0) || 0;
    foundUsage = true;
  }

  if (!foundUsage) {
    return { inputTokens: null, outputTokens: null };
  }

  return { inputTokens, outputTokens };
}

// Get list of all session files with metadata
async function listSessions() {
  const sessionDir = getSessionLogDir();

  try {
    const files = await readdir(sessionDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    const sessions = [];

    for (const file of jsonlFiles) {
      const filePath = join(sessionDir, file);
      try {
        const fileSessions = await parseSessionFile(filePath);

        for (let i = 0; i < fileSessions.length; i++) {
          const session = fileSessions[i];
          const header = session.header || {};
          const proxy = session._proxy || {};

          const tokenUsage = getSessionTokenUsage(session);

          sessions.push({
            id: `${file}:${i}`,
            filename: file,
            index: i,
            sessionId: header.id || 'unknown',
            timestamp: header.timestamp || proxy.timestamp || 'unknown',
            source: proxy.source || 'unknown',
            path: proxy.path || 'unknown',
            method: proxy.method || 'unknown',
            statusCode: proxy.statusCode || null,
            matchedCategory: proxy.matchedCategory || null,
            entryCount: (session.entries || []).length,
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens,
            durationMs: Number.isFinite(Number(proxy.durationMs)) ? Number(proxy.durationMs) : null,
          });
        }
      } catch {
        // Skip files that can't be read
      }
    }

    // Sort by timestamp descending (newest first)
    sessions.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime() || 0;
      const tb = new Date(b.timestamp).getTime() || 0;
      return tb - ta;
    });

    return sessions;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// Get a specific session by file and index
async function getSession(filename, index) {
  const sessionDir = getSessionLogDir();
  const filePath = join(sessionDir, filename);

  try {
    const sessions = await parseSessionFile(filePath);
    return sessions[index] || null;
  } catch {
    return null;
  }
}

// HTML template for the viewer
function getViewerHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reverse-Ollama Session Viewer</title>
  <style>
    :root {
      --accent: #8abeb7;
      --border: #5f87ff;
      --borderAccent: #00d7ff;
      --borderMuted: #505050;
      --success: #b5bd68;
      --error: #cc6666;
      --warning: #f0c674;
      --muted: #808080;
      --dim: #666666;
      --text: #e5e5e7;
      --thinkingText: #808080;
      --selectedBg: #3a3a4a;
      --userMessageBg: #343541;
      --userMessageText: #e5e5e7;
      --customMessageBg: #2d2838;
      --customMessageText: #e5e5e7;
      --customMessageLabel: #9575cd;
      --toolSuccessBg: #283228;
      --toolErrorBg: #3c2828;
      --mdHeading: #f0c674;
      --mdCode: #8abeb7;
      --body-bg: rgb(36, 37, 46);
      --container-bg: rgb(44, 45, 55);
      --line-height: 18px;
      --content-line-height: 1.35;
      --content-paragraph-gap: 3px;
      --message-line-height: 1.2;
      --content-block-gap: 8px;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
      font-size: 12px;
      line-height: var(--content-line-height);
      color: var(--text);
      background: var(--body-bg);
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: var(--line-height);
    }

    h1 {
      font-size: 14px;
      color: var(--borderAccent);
      margin-bottom: calc(var(--line-height) * 2);
    }

    .back-btn {
      display: inline-block;
      padding: 4px 12px;
      background: var(--container-bg);
      border: 1px solid var(--border);
      border-radius: 3px;
      color: var(--text);
      cursor: pointer;
      text-decoration: none;
      font-size: 11px;
      margin-bottom: var(--line-height);
    }

    .back-btn:hover {
      background: var(--selectedBg);
      border-color: var(--borderAccent);
    }

    /* Session list */
    .session-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .session-item {
      display: grid;
      grid-template-columns: 180px 120px 1fr 70px 90px 70px 60px;
      gap: 12px;
      padding: 8px 12px;
      background: var(--container-bg);
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      align-items: center;
    }

    .session-item:hover {
      background: var(--selectedBg);
    }

    .session-time {
      color: var(--muted);
    }

    .session-source {
      color: var(--accent);
    }

    .session-path {
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-category {
      color: var(--customMessageLabel);
      font-size: 10px;
    }

    .session-status {
      text-align: center;
      font-weight: bold;
    }

    .session-status.success { color: var(--success); }
    .session-status.error { color: var(--error); }
    .session-status.warning { color: var(--warning); }

    .session-tokens,
    .session-duration,
    .session-entries {
      color: var(--muted);
      text-align: right;
    }

    .list-header {
      display: grid;
      grid-template-columns: 180px 120px 1fr 70px 90px 70px 60px;
      gap: 12px;
      padding: 8px 12px;
      font-size: 10px;
      color: var(--muted);
      border-bottom: 1px solid var(--borderMuted);
      margin-bottom: 4px;
    }

    .empty-state {
      text-align: center;
      padding: 48px;
      color: var(--muted);
    }

    /* Session detail */
    .session-detail {
      display: flex;
      flex-direction: column;
      gap: var(--line-height);
    }

    .header {
      background: var(--container-bg);
      border-radius: 4px;
      padding: var(--line-height);
    }

    .header h2 {
      font-size: 12px;
      color: var(--borderAccent);
      margin-bottom: var(--line-height);
    }

    .header-info {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 8px;
      font-size: 11px;
    }

    .info-item {
      color: var(--dim);
    }

    .info-label {
      font-weight: 600;
      margin-right: 8px;
    }

    .info-value {
      color: var(--text);
    }

    .info-value.success { color: var(--success); }
    .info-value.error { color: var(--error); }
    .info-value.warning { color: var(--warning); }

    /* Messages */
    .messages {
      display: flex;
      flex-direction: column;
      gap: var(--line-height);
    }

    .user-message {
      background: var(--userMessageBg);
      color: var(--userMessageText);
      padding: var(--line-height);
      border-radius: 4px;
      font-size: 0;
    }

    .assistant-message {
      padding: var(--line-height);
      background: transparent;
      font-size: 0;
    }

    .message-content {
      overflow-wrap: anywhere;
      line-height: var(--content-line-height);
      font-size: 0px;
    }

    .message-text {
      display: block;
      white-space: pre-wrap;
      margin: 0;
      font-size: 12px;
      line-height: var(--message-line-height);
    }

    .message-content p {
      margin: 0;
      margin-block: 0;
      line-height: var(--message-line-height);
      font-size: 12px;
    }

    .message-content p + p {
      margin-top: var(--content-paragraph-gap);
    }

    .thinking-text {
      color: var(--thinkingText);
      font-style: italic;
      white-space: pre-wrap;
      line-height: var(--content-line-height);
      margin-bottom: var(--content-block-gap);
    }

    .message-role {
      font-size: 10px;
      color: var(--muted);
      margin-bottom: 4px;
    }

    .message-role.user { color: var(--accent); }
    .message-role.assistant { color: var(--success); }
    .message-role.system { color: var(--customMessageLabel); }

    /* Model change */
    .model-change {
      padding: 8px var(--line-height);
      color: var(--dim);
      font-size: 11px;
      background: var(--container-bg);
      border-radius: 4px;
    }

    .model-name {
      color: var(--borderAccent);
      font-weight: bold;
    }

    /* Error */
    .error-block {
      background: var(--toolErrorBg);
      padding: var(--line-height);
      border-radius: 4px;
      border-left: 3px solid var(--error);
    }

    .error-header {
      font-weight: bold;
      color: var(--error);
    }

    .error-message {
      color: var(--text);
      margin-top: 4px;
    }

    /* Proxy metadata */
    .proxy-block {
      background: var(--customMessageBg);
      border-radius: 4px;
      padding: var(--line-height);
    }

    .proxy-header {
      font-weight: bold;
      color: var(--customMessageLabel);
      margin-bottom: var(--line-height);
    }

    .body-block {
      margin-top: var(--line-height);
    }

    .body-header {
      font-weight: bold;
      color: var(--warning);
      font-size: 11px;
      margin-bottom: 4px;
    }

    .body-block pre {
      background: var(--body-bg);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 10px;
      line-height: 14px;
      max-height: 300px;
      overflow-y: auto;
    }

    .body-block code {
      font-family: inherit;
      color: var(--text);
    }

    .token-usage {
      font-size: 10px;
      color: var(--muted);
      margin-top: 4px;
    }

    /* Responsive */
    @media (max-width: 800px) {
      .session-item, .list-header {
        grid-template-columns: 1fr;
        gap: 4px;
      }

      .list-header {
        display: none;
      }

      .session-item {
        padding: 12px;
      }
    }
  </style>
</head>
<body>
  <div class="container" id="app">
    Loading...
  </div>

  <script>
    const state = {
      view: 'list', // 'list' or 'detail'
      sessions: [],
      currentSession: null,
      currentFile: null,
      currentIndex: null,
      loading: false,
      error: null,
    };

    async function fetchJson(url) {
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(err.error || 'Request failed');
      }
      return res.json();
    }

    async function loadSessions() {
      state.loading = true;
      state.error = null;
      render();

      try {
        const data = await fetchJson('/api/sessions');
        state.sessions = data.sessions;
        state.view = 'list';
      } catch (err) {
        state.error = err.message;
      } finally {
        state.loading = false;
        render();
      }
    }

    function showListView() {
      state.view = 'list';
      state.currentSession = null;
      state.currentFile = null;
      state.currentIndex = null;
      render();
    }

    async function loadSession(filename, index, options = {}) {
      const { pushHistory = true } = options;

      state.loading = true;
      state.error = null;
      render();

      try {
        const data = await fetchJson(\`/api/sessions/\${encodeURIComponent(filename)}/\${index}\`);
        state.currentSession = data.session;
        state.currentFile = filename;
        state.currentIndex = index;
        state.view = 'detail';

        if (pushHistory) {
          window.history.pushState(
            { view: 'detail', filename, index },
            '',
            \`\${window.location.pathname}\${window.location.search}#session=\${encodeURIComponent(filename)}:\${index}\`,
          );
        }
      } catch (err) {
        state.error = err.message;
      } finally {
        state.loading = false;
        render();
      }
    }

    function goBack() {
      if (window.history.state && window.history.state.view === 'detail') {
        window.history.back();
        return;
      }

      showListView();
    }

    function escapeHtml(str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function renderMessageText(value) {
      const source = value == null ? '' : String(value);
      const escaped = escapeHtml(source);
      const lf = String.fromCharCode(10);
      const cr = String.fromCharCode(13);
      const normalized = escaped.replaceAll(cr + lf, lf).replaceAll(cr, lf);
      const paragraphBreak = lf + lf;
      const paragraphs = normalized
        .split(paragraphBreak)
        .map((part) => part.trim())
        .filter(Boolean);

      if (paragraphs.length === 0) {
        return '';
      }

      return paragraphs
        .map((paragraph) => '<p>' + paragraph.replaceAll(lf, '<br>') + '</p>')
        .join('');
    }

    function formatJson(str) {
      try {
        const obj = typeof str === 'string' ? JSON.parse(str) : str;
        return JSON.stringify(obj, null, 2);
      } catch {
        return String(str);
      }
    }

    function formatDate(isoString) {
      try {
        const d = new Date(isoString);
        return d.toLocaleString();
      } catch {
        return isoString;
      }
    }

    function formatDuration(durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        return '-';
      }

      if (durationMs < 1000) {
        return String(Math.round(durationMs)) + 'ms';
      }

      return (durationMs / 1000).toFixed(2) + 's';
    }

    function formatTokenUsage(inputTokens, outputTokens) {
      if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) {
        return '-';
      }

      const input = Number.isFinite(inputTokens) ? inputTokens : 0;
      const output = Number.isFinite(outputTokens) ? outputTokens : 0;
      return String(input) + '/' + String(output);
    }

    function getSessionTokenUsage(session) {
      const entries = Array.isArray(session?.entries) ? session.entries : [];
      let inputTokens = 0;
      let outputTokens = 0;
      let found = false;

      for (const entry of entries) {
        if (entry?.type !== 'message' || entry?.message?.role !== 'assistant' || !entry?.message?.usage) {
          continue;
        }

        const usage = entry.message.usage;
        inputTokens += Number(usage.input ?? usage.prompt_tokens ?? usage.prompt_eval_count ?? 0) || 0;
        outputTokens += Number(usage.output ?? usage.completion_tokens ?? usage.eval_count ?? 0) || 0;
        found = true;
      }

      if (!found) {
        return { inputTokens: null, outputTokens: null };
      }

      return { inputTokens, outputTokens };
    }

    function render() {
      const app = document.getElementById('app');

      if (state.loading && !state.sessions.length && !state.currentSession) {
        app.innerHTML = '<div class="empty-state">Loading...</div>';
        return;
      }

      if (state.error) {
        app.innerHTML = \`<div class="empty-state"><p style="color: var(--error);">Error: \${escapeHtml(state.error)}</p></div>\`;
        return;
      }

      if (state.view === 'list') {
        renderList(app);
      } else {
        renderDetail(app);
      }
    }

    function renderList(app) {
      if (state.sessions.length === 0) {
        app.innerHTML = \`
          <h1>Session Viewer</h1>
          <div class="empty-state">
            <p>No sessions found.</p>
            <p style="margin-top: 8px; color: var(--muted);">Sessions will appear here when requests are logged.</p>
          </div>
        \`;
        return;
      }

      let html = \`
        <h1>Session Viewer (\${state.sessions.length} sessions)</h1>
        <div class="list-header">
          <span>Time</span>
          <span>Source</span>
          <span>Path</span>
          <span>Status</span>
          <span>Tokens</span>
          <span>Time</span>
          <span>Entries</span>
        </div>
        <div class="session-list">
      \`;

      for (const s of state.sessions) {
        const statusClass = s.statusCode >= 500 ? 'error' : s.statusCode >= 400 ? 'warning' : 'success';
        html += \`
          <div class="session-item" onclick="loadSession('\${escapeHtml(s.filename)}', \${s.index})">
            <span class="session-time">\${escapeHtml(formatDate(s.timestamp))}</span>
            <span class="session-source">\${escapeHtml(s.source)}</span>
            <span class="session-path">\${escapeHtml(s.method)} \${escapeHtml(s.path)}</span>
            <span class="session-status \${statusClass}">\${s.statusCode || '-'}</span>
            <span class="session-tokens">\${escapeHtml(formatTokenUsage(s.inputTokens, s.outputTokens))}</span>
            <span class="session-duration">\${escapeHtml(formatDuration(s.durationMs))}</span>
            <span class="session-entries">\${s.entryCount}</span>
          </div>
        \`;
      }

      html += '</div>';
      app.innerHTML = html;
    }

    function renderDetail(app) {
      const s = state.currentSession;
      const proxy = s._proxy || {};
      const header = s.header || {};
      const tokenUsage = getSessionTokenUsage(s);

      let html = \`
        <a href="#" class="back-btn" onclick="goBack(); return false;">← Back to list</a>
        <div class="session-detail">
          <div class="header">
            <h2>Session Details</h2>
            <div class="header-info">
              <div class="info-item"><span class="info-label">ID:</span><span class="info-value">\${escapeHtml(header.id || 'unknown')}</span></div>
              <div class="info-item"><span class="info-label">Time:</span><span class="info-value">\${escapeHtml(formatDate(header.timestamp || proxy.timestamp))}</span></div>
              <div class="info-item"><span class="info-label">Source:</span><span class="info-value">\${escapeHtml(proxy.source || 'unknown')}</span></div>
              <div class="info-item"><span class="info-label">Path:</span><span class="info-value">\${escapeHtml(proxy.method)} \${escapeHtml(proxy.path || 'unknown')}</span></div>
              <div class="info-item"><span class="info-label">Tokens:</span><span class="info-value">\${escapeHtml(formatTokenUsage(tokenUsage.inputTokens, tokenUsage.outputTokens))} (in/out)</span></div>
              <div class="info-item"><span class="info-label">Request Time:</span><span class="info-value">\${escapeHtml(formatDuration(Number(proxy.durationMs)))}</span></div>
              <div class="info-item"><span class="info-label">Category:</span><span class="info-value">\${escapeHtml(proxy.matchedCategory || 'none')}</span></div>
              <div class="info-item"><span class="info-label">Actions:</span><span class="info-value">\${(proxy.appliedActions || []).map(a => escapeHtml(a)).join(', ') || 'none'}</span></div>
              <div class="info-item">
                <span class="info-label">Status:</span>
                <span class="info-value \${proxy.statusCode >= 400 ? 'error' : 'success'}">\${proxy.statusCode || 'unknown'}</span>
              </div>
            </div>
          </div>
          <div class="messages">
      \`;

      // Render entries
      for (const entry of (s.entries || [])) {
        if (entry.type === 'model_change') {
          html += \`
            <div class="model-change">
              Model: <span class="model-name">\${escapeHtml(entry.modelId || 'unknown')}</span>
            </div>
          \`;
        } else if (entry.type === 'message') {
          const role = entry.message?.role || 'unknown';
          const content = entry.message?.content;
          const usage = entry.message?.usage;
          const model = entry.message?.model;

          let contentHtml = '';
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === 'thinking') {
                contentHtml += \`<div class="thinking-text">\${escapeHtml(part.thinking || '')}</div>\`;
              } else if (part.type === 'text') {
                contentHtml += renderMessageText(part.text || '');
              }
            }
          } else {
            contentHtml = renderMessageText(String(content || ''));
          }

          if (role === 'user') {
            html += \`
              <div class="user-message">
                <div class="message-role user">User</div>
                <div class="message-content"><div class="message-text">\${contentHtml}</div></div>
              </div>
            \`;
          } else if (role === 'assistant') {
            html += \`
              <div class="assistant-message">
                <div class="message-role assistant">Assistant</div>
                <div class="message-content"><div class="message-text">\${contentHtml}</div></div>
                \${usage ? \`<div class="token-usage">Tokens: \${usage.input || usage.prompt_tokens || 0} in / \${usage.output || usage.completion_tokens || 0} out</div>\` : ''}
                \${model ? \`<div class="token-usage">Model: \${escapeHtml(model)}</div>\` : ''}
              </div>
            \`;
          } else if (role === 'system') {
            html += \`
              <div class="user-message" style="background: var(--customMessageBg);">
                <div class="message-role system">System</div>
                <div class="message-content"><div class="message-text">\${contentHtml}</div></div>
              </div>
            \`;
          }
        } else if (entry.type === 'error') {
          html += \`
            <div class="error-block">
              <div class="error-header">Error</div>
              <div class="error-message">\${escapeHtml(entry.error?.message || 'Unknown error')}</div>
              \${entry.error?.statusCode ? \`<div class="token-usage">Status: \${entry.error.statusCode}</div>\` : ''}
            </div>
          \`;
        }
      }

      // Proxy metadata
      if (proxy.request || proxy.response) {
        html += \`
          <div class="proxy-block">
            <div class="proxy-header">Request/Response Details</div>
            \${proxy.request?.incomingBody ? \`
              <div class="body-block">
                <div class="body-header">Incoming Request Body</div>
                <pre><code>\${escapeHtml(formatJson(proxy.request.incomingBody))}</code></pre>
              </div>
            \` : ''}
            \${proxy.request?.outgoingBody ? \`
              <div class="body-block">
                <div class="body-header">Outgoing Request Body (transformed)</div>
                <pre><code>\${escapeHtml(formatJson(proxy.request.outgoingBody))}</code></pre>
              </div>
            \` : ''}
            \${proxy.response?.body ? \`
              <div class="body-block">
                <div class="body-header">Response Body</div>
                <pre><code>\${escapeHtml(formatJson(proxy.response.body))}</code></pre>
              </div>
            \` : ''}
          </div>
        \`;
      }

      html += \`
          </div>
        </div>
      \`;

      app.innerHTML = html;
    }

    function handlePopState(event) {
      const entry = event.state;

      if (entry && entry.view === 'detail' && typeof entry.filename === 'string' && Number.isInteger(entry.index)) {
        loadSession(entry.filename, entry.index, { pushHistory: false });
        return;
      }

      showListView();
    }

    function initNavigation() {
      window.history.replaceState(
        { view: 'list' },
        '',
        window.location.pathname + window.location.search,
      );
      window.addEventListener('popstate', handlePopState);
    }

    // Start
    initNavigation();
    loadSessions();
  </script>
</body>
</html>`;
}

// Request handler
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Check auth
  if (!checkAuth(req)) {
    sendAuthChallenge(res);
    return;
  }

  // API routes
  if (url.pathname === '/api/sessions') {
    try {
      const sessions = await listSessions();
      sendJson(res, 200, { sessions });
    } catch (error) {
      sendError(res, 500, error.message);
    }
    return;
  }

  if (url.pathname.startsWith('/api/sessions/') && (url.pathname.includes('..') || url.pathname.includes('\\'))) {
    sendError(res, 400, 'Invalid filename');
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(\d+)$/);
  if (sessionMatch) {
    const filename = decodeURIComponent(sessionMatch[1]);
    const index = parseInt(sessionMatch[2], 10);

    // Security: prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      sendError(res, 400, 'Invalid filename');
      return;
    }

    try {
      const session = await getSession(filename, index);
      if (!session) {
        sendError(res, 404, 'Session not found');
        return;
      }
      sendJson(res, 200, { session });
    } catch (error) {
      sendError(res, 500, error.message);
    }
    return;
  }

  // Serve HTML viewer for all other routes
  if (url.pathname === '/' || url.pathname === '/index.html') {
    sendHtml(res, 200, getViewerHtml());
    return;
  }

  sendError(res, 404, 'Not found');
}

export function createSessionViewerServer() {
  return createServer(handleRequest);
}

export function startSessionViewer(callback) {
  const server = createSessionViewerServer();
  const host = getHost();
  const port = getPort();

  if (!isAuthEnabled()) {
    const error = new Error('SESSION_VIEWER_PASSWORD must be set');
    if (callback) {
      callback(error);
    }
    return server;
  }

  server.listen(port, host, () => {
    const addressHost = host.includes(':') ? `[${host}]` : host;
    const address = `http://${addressHost}:${port}`;

    if (callback) {
      callback(null, { host, port, address, authEnabled: isAuthEnabled() });
    }
  });

  server.on('error', (error) => {
    if (callback) {
      callback(error);
    }
  });

  return server;
}

export default {
  createSessionViewerServer,
  startSessionViewer,
  getHost,
  getPort,
  getPassword,
  isAuthEnabled,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  startSessionViewer((error, info) => {
    if (error) {
      console.error(`Failed to start session viewer: ${error.message}`);
      process.exit(1);
      return;
    }

    console.log(`Session viewer listening on ${info.address} (auth: admin / <SESSION_VIEWER_PASSWORD>)`);
  });
}
