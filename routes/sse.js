/**
 * V4 — Server-Sent Events for live inbox updates
 * Browser opens an EventSource('/api/sse/inbox?username=X') and receives
 * live notification events as they arrive in the notifications table.
 *
 * Polling-based polling (every 5s the route checks for new rows since last
 * client cursor). For high-volume installs, replace with a real pub/sub
 * (Redis Streams, Postgres LISTEN/NOTIFY, etc.).
 */
const router = require('express').Router();
const db = require('../db/connection');

// Active connections: { username: [ {res, lastId, lastTs} ] }
const _connections = new Map();

router.get('/inbox', async (req, res) => {
  // Release Gate hardening — the stream is bound to the AUTHENTICATED user
  // (req.user, set by the global Bearer gate in server.js). The legacy
  // ?username= parameter is no longer an identity source: if present and
  // different from the token's user it is an explicit 403, so no
  // authenticated user can subscribe to another user's notifications.
  const authUser = req.user && req.user.username;
  if (!authUser) return res.status(401).end('unauthorized');
  if (req.query.username && String(req.query.username) !== String(authUser)) {
    return res.status(403).end('forbidden: the stream is bound to the authenticated user');
  }
  const username = authUser;

  // SSE headers. `no-transform` is load-bearing: the compression middleware's
  // default filter skips responses that declare it — otherwise the stream is
  // gzip-buffered and events sit in the compressor instead of reaching the
  // client in real time (discovered by tests/integration/sse.security.test.js).
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'   // disable proxy buffering
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Initial hello
  res.write(`event: hello\ndata: ${JSON.stringify({ username, ts: Date.now() })}\n\n`);

  let lastId = null;
  let alive = true;

  // Track this connection
  if (!_connections.has(username)) _connections.set(username, []);
  const entry = { res, lastId };
  _connections.get(username).push(entry);

  // Heartbeat every 25s to keep proxies happy
  const hb = setInterval(() => {
    if (!alive) return;
    try { res.write(': heartbeat\n\n'); } catch(_) {}
  }, 25000);

  // Polling loop — every 5s check for new notifications since lastId
  const poll = setInterval(async () => {
    if (!alive) return;
    try {
      const sql = lastId
        ? `SELECT * FROM notifications WHERE username = ? AND id > ? ORDER BY id ASC LIMIT 50`
        : `SELECT * FROM notifications WHERE username = ? ORDER BY id DESC LIMIT 1`;
      const params = lastId ? [username, lastId] : [username];
      const [rows] = await db.query(sql, params);
      if (!lastId && rows.length) {
        lastId = rows[0].id;
        entry.lastId = lastId;
        // Don't emit historical; just bookmark
        return;
      }
      for (const r of rows) {
        const evt = {
          id: r.id,
          type: r.type,
          title: r.title,
          body: r.body,
          linkType: r.link_type,
          linkId: r.link_id,
          severity: r.severity,
          createdAt: r.created_at
        };
        res.write(`event: notification\ndata: ${JSON.stringify(evt)}\n\n`);
        lastId = r.id;
        entry.lastId = lastId;
      }
    } catch(e) {
      console.warn('[sse poll]', e.message);
    }
  }, 5000);

  req.on('close', () => {
    alive = false;
    clearInterval(hb);
    clearInterval(poll);
    const list = _connections.get(username) || [];
    const idx = list.indexOf(entry);
    if (idx !== -1) list.splice(idx, 1);
    if (!list.length) _connections.delete(username);
  });
});

// Manual broadcast endpoint (admin-only) — useful for system announcements
// V5-SEC: check role, not username string. Validate targetUsername exists.
router.post('/broadcast', async (req, res) => {
  try {
    const role = (req.user && req.user.role) || '';
    const isDev = !!(req.user && req.user.isDeveloper);
    if (role !== 'admin' && !isDev) return res.status(403).json({ error: 'admin only' });
    const { title, body, severity, targetUsername } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const target = targetUsername || null;   // null = all users with active SSE

    if (target) {
      // V5-SEC: validate target exists, prevents orphan notifications
      const [u] = await db.query('SELECT username FROM users WHERE username = ? LIMIT 1', [target]);
      if (!u.length) {
        return res.status(404).json({ error: 'target user not found: ' + target });
      }
      await db.query(
        `INSERT INTO notifications (id, username, type, title, body, severity)
         VALUES (?, ?, 'broadcast', ?, ?, ?)`,
        ['NOT-BC-' + Date.now() + '-' + Math.random().toString(36).slice(2,4),
         target, title, body, severity || 'info']);
    } else {
      // Broadcast to all currently-connected users
      for (const [u, _] of _connections.entries()) {
        await db.query(
          `INSERT INTO notifications (id, username, type, title, body, severity)
           VALUES (?, ?, 'broadcast', ?, ?, ?)`,
          ['NOT-BC-' + Date.now() + '-' + Math.random().toString(36).slice(2,4) + '-' + u,
           u, title, body, severity || 'info']);
      }
    }
    res.json({ success: true, deliveredTo: target ? 1 : _connections.size });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// Health check — how many active connections. The per-user breakdown is
// admin/developer-only (usernames of connected users are not for everyone);
// other authenticated users get the total plus their own count.
router.get('/health', (req, res) => {
  const counts = {};
  let total = 0;
  for (const [u, list] of _connections.entries()) {
    counts[u] = list.length;
    total += list.length;
  }
  const role = (req.user && req.user.role) || '';
  const isDev = !!(req.user && req.user.isDeveloper);
  if (role === 'admin' || isDev) {
    return res.json({ activeConnections: total, byUser: counts });
  }
  const me = (req.user && req.user.username) || '';
  res.json({ activeConnections: total, mine: counts[me] || 0 });
});

module.exports = router;
