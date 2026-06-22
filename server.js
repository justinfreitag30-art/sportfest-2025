const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const VAPID_FILE = path.join(__dirname, 'vapid.json');
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSION_SECRET_FILE = path.join(__dirname, 'session-secret.json');

let data = { settings: { gameDurationMinutes: 10 }, teams: [], matches: [] };
let subscriptions = [];
let users = [];
let nextUserId = 1;

function normalizeData(obj) {
  if (!obj.settings) obj.settings = { gameDurationMinutes: 10 };
  if (!obj.settings.gameDurationMinutes) obj.settings.gameDurationMinutes = 10;
  if (!obj.settings.standingsSport) obj.settings.standingsSport = 'Fußball';
  if (!Array.isArray(obj.pushSubscriptions)) obj.pushSubscriptions = [];
  obj.teams = (obj.teams || []).map(t => ({
    ...t,
    players: t.players || []
  }));
  obj.matches = (obj.matches || []).map(m => ({
    ...m,
    penalties: m.penalties || [],
    goals: m.goals || [],
    startedAt: m.startedAt || null,
    endedAt: m.endedAt || null
  }));
  return obj;
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    data = normalizeData(JSON.parse(raw));
  } catch (err) {
    console.error('Failed to load data.json:', err.message);
    data = { settings: { gameDurationMinutes: 10 }, teams: [], matches: [] };
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getPublicData() {
  const { pushSubscriptions, vapidKeys, activityLog, ...publicData } = data;
  return publicData;
}

const MAX_ACTIVITY_LOG = 500;

function appendActivityLogs(user, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  if (!Array.isArray(data.activityLog)) data.activityLog = [];

  const at = new Date().toISOString();
  entries.forEach(entry => {
    if (!entry?.text) return;
    data.activityLog.push({
      id: `log${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      at,
      userId: user?.id || null,
      username: user?.username || 'System',
      role: user?.role || 'admin',
      action: String(entry.action || 'other').slice(0, 40),
      text: String(entry.text).slice(0, 300)
    });
  });

  if (data.activityLog.length > MAX_ACTIVITY_LOG) {
    data.activityLog = data.activityLog.slice(-MAX_ACTIVITY_LOG);
  }
}

function syncSubscriptionsFromData() {
  subscriptions = Array.isArray(data.pushSubscriptions) ? [...data.pushSubscriptions] : [];
}

function loadSubscriptions() {
  syncSubscriptionsFromData();
  if (subscriptions.length > 0) return;

  try {
    const legacy = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    if (Array.isArray(legacy) && legacy.length > 0) {
      subscriptions = legacy;
      data.pushSubscriptions = subscriptions;
      saveData();
      console.log(`Migrated ${subscriptions.length} push subscriptions to data.json`);
    }
  } catch {
    // no legacy file
  }
}

function saveSubscriptions() {
  data.pushSubscriptions = subscriptions;
  saveData();
}

function ensureVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  }
  if (data.vapidKeys?.publicKey && data.vapidKeys?.privateKey) {
    return data.vapidKeys;
  }
  try {
    const fromFile = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    if (fromFile.publicKey && fromFile.privateKey) {
      data.vapidKeys = fromFile;
      saveData();
      return fromFile;
    }
  } catch {
    // generate below
  }
  const keys = webpush.generateVAPIDKeys();
  data.vapidKeys = keys;
  saveData();
  try {
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2), 'utf8');
  } catch {
    // optional backup file
  }
  console.log('VAPID keys generated and saved to data.json');
  return keys;
}

let vapidKeys;
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:sportfest@example.com';

function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_SECRET_FILE, 'utf8'));
    if (parsed.secret) return parsed.secret;
  } catch {
    // generate below
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SESSION_SECRET_FILE, JSON.stringify({ secret }, null, 2), 'utf8');
  console.log('Session secret generated and saved to session-secret.json');
  return secret;
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users, nextUserId }, null, 2), 'utf8');
}

function loadUsers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    users = parsed.users || [];
    nextUserId = parsed.nextUserId || 1;
    let migrated = false;
    users.forEach(u => {
      if (!u.role) {
        u.role = 'admin';
        migrated = true;
      }
      const num = parseInt(String(u.id).replace('u', ''), 10);
      if (!isNaN(num) && num >= nextUserId) nextUserId = num + 1;
    });
    if (migrated) saveUsers();
    return;
  } catch {
    // create default admin
  }

  const defaultUsername = process.env.ADMIN_USERNAME || 'admin';
  const defaultPassword = process.env.ADMIN_PASSWORD || 'sportfest';
  const passwordHash = bcrypt.hashSync(defaultPassword, 10);
  users = [{ id: 'u1', username: defaultUsername, passwordHash, role: 'admin' }];
  nextUserId = 2;
  saveUsers();
  console.log('Default admin account created:');
  console.log(`  Username: ${defaultUsername}`);
  console.log(`  Password: ${defaultPassword}`);
  console.log('  Please change the password after first login!');
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Nicht angemeldet' });
  }
  return res.redirect('/admin/login');
}

function sanitizeUser(user) {
  return { id: user.id, username: user.username, role: user.role || 'admin' };
}

function getSessionUser(req) {
  if (!req.session?.userId) return null;
  return users.find(u => u.id === req.session.userId) || null;
}

function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Nicht angemeldet' });
  }
  if ((user.role || 'admin') !== 'admin') {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  next();
}

const SCHIRI_LOCKED_MATCH_FIELDS = ['id', 'time', 'sport', 'emoji', 'teamA', 'teamB', 'status', 'startedAt', 'endedAt'];

function applySchiriSave(incoming) {
  const current = normalizeData(JSON.parse(JSON.stringify(data)));
  const next = normalizeData(incoming);

  if (JSON.stringify(next.teams) !== JSON.stringify(current.teams)) {
    throw new Error('Schiris dürfen Teams nicht ändern');
  }
  if (JSON.stringify(next.settings) !== JSON.stringify(current.settings)) {
    throw new Error('Schiris dürfen Einstellungen nicht ändern');
  }
  if (next.matches.length !== current.matches.length) {
    throw new Error('Schiris dürfen keine Spiele hinzufügen oder löschen');
  }

  const mergedMatches = current.matches.map(cur => {
    const inc = next.matches.find(m => m.id === cur.id);
    if (!inc) throw new Error('Unbekanntes Spiel');

    for (const field of SCHIRI_LOCKED_MATCH_FIELDS) {
      if (JSON.stringify(inc[field]) !== JSON.stringify(cur[field])) {
        throw new Error('Schiris dürfen nur Punkte und Strafen ändern');
      }
    }

    return {
      ...cur,
      scoreA: Number(inc.scoreA) || 0,
      scoreB: Number(inc.scoreB) || 0,
      goals: inc.goals || [],
      penalties: inc.penalties || []
    };
  });

  return { ...current, matches: mergedMatches };
}

loadData();
loadSubscriptions();
vapidKeys = ensureVapidKeys();
webpush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);
loadUsers();

const sessionSecret = loadSessionSecret();
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

app.set('trust proxy', 1);

function getTeamName(id) {
  const team = data.teams.find(t => t.id === id);
  return team ? team.name : 'Unbekannt';
}

function buildMatchPushPayload(match) {
  const emoji = match.emoji || '';
  return {
    title: '⚽ Spiel gestartet — Sportfest 2026',
    body: `${getTeamName(match.teamA)} vs ${getTeamName(match.teamB)} — ${match.sport} ${emoji} (${match.time} Uhr)`,
    url: '/'
  };
}

async function sendPushToAll(payload) {
  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0, message: 'Keine Abonnenten' };
  }

  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  const valid = [];

  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, body);
      valid.push(sub);
      sent++;
    } catch (err) {
      failed++;
      console.error('Push send failed:', err.statusCode, err.body || err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        // expired — remove
      } else {
        valid.push(sub);
      }
    }
  }));

  subscriptions = valid;
  saveSubscriptions();
  return { sent, failed, total: subscriptions.length };
}

app.use(express.json({ limit: '1mb' }));
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/admin');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin.html', (req, res) => {
  res.redirect('/admin/login');
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }

  const user = users.find(u => u.username.toLowerCase() === String(username).trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role || 'admin';
  res.json({ ok: true, user: sanitizeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Nicht angemeldet' });
  }
  const user = users.find(u => u.id === req.session.userId);
  if (!user) {
    return res.status(401).json({ error: 'Benutzer nicht gefunden' });
  }
  res.json(sanitizeUser(user));
});

app.get('/api/auth/users', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: users.map(sanitizeUser) });
});

app.post('/api/auth/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  const trimmed = String(username || '').trim();
  const userRole = role === 'schiri' ? 'schiri' : 'admin';
  if (!trimmed || trimmed.length < 2) {
    return res.status(400).json({ error: 'Benutzername muss mindestens 2 Zeichen haben' });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: 'Passwort muss mindestens 4 Zeichen haben' });
  }
  if (users.some(u => u.username.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  }

  const user = {
    id: `u${nextUserId++}`,
    username: trimmed,
    passwordHash: bcrypt.hashSync(password, 10),
    role: userRole
  };
  users.push(user);
  saveUsers();
  appendActivityLogs(getSessionUser(req), [{
    action: 'other',
    text: `Benutzerkonto „${trimmed}" angelegt (${userRole === 'schiri' ? 'Schiri' : 'Administrator'})`
  }]);
  saveData();
  res.json({ ok: true, user: sanitizeUser(user) });
});

app.delete('/api/auth/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Du kannst dein eigenes Konto nicht löschen' });
  }
  const before = users.length;
  users = users.filter(u => u.id !== id);
  if (users.length === before) {
    return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  }
  saveUsers();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/preview', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

app.get('/api/data', (req, res) => {
  res.json(getPublicData());
});

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.get('/api/push/status', requireAuth, requireAdmin, (req, res) => {
  res.json({ subscribers: subscriptions.length });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    console.error('Push subscribe: invalid body', req.body);
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  if (!sub.keys?.p256dh || !sub.keys?.auth) {
    console.error('Push subscribe: missing keys', sub.endpoint);
    return res.status(400).json({ error: 'Invalid subscription keys' });
  }

  const idx = subscriptions.findIndex(s => s.endpoint === sub.endpoint);
  if (idx >= 0) {
    subscriptions[idx] = sub;
    console.log('Push subscribe: updated subscriber, total:', subscriptions.length);
  } else {
    subscriptions.push(sub);
    console.log('Push subscribe: new subscriber, total:', subscriptions.length);
  }
  saveSubscriptions();
  res.json({ ok: true, subscribers: subscriptions.length });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  saveSubscriptions();
  res.json({ ok: true });
});

app.get('/api/activity-log', requireAuth, requireAdmin, (req, res) => {
  const logs = Array.isArray(data.activityLog) ? [...data.activityLog] : [];
  logs.reverse();
  res.json({ logs });
});

app.post('/api/push/notify', requireAuth, requireAdmin, async (req, res) => {
  const user = getSessionUser(req);
  const { matchId, test, title, body, message } = req.body;

  if (test) {
    try {
      const result = await sendPushToAll({
        title: '🔔 Test — Sportfest 2026',
        body: 'Push-Benachrichtigungen funktionieren!',
        url: '/'
      });
      appendActivityLogs(user, [{ action: 'push', text: 'Test-Push gesendet' }]);
      saveData();
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Push test error:', err);
      return res.status(500).json({ error: 'Push failed' });
    }
  }

  if (matchId) {
    const match = data.matches.find(m => m.id === matchId);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }
    try {
      const result = await sendPushToAll(buildMatchPushPayload(match));
      appendActivityLogs(user, [{
        action: 'push',
        text: `Push bei Spielstart: ${getTeamName(match.teamA)} vs ${getTeamName(match.teamB)}`
      }]);
      saveData();
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Push error:', err);
      return res.status(500).json({ error: 'Push failed' });
    }
  }

  const customBody = String(body || message || '').trim();
  if (customBody) {
    const customTitle = String(title || 'Sportfest 2026').trim().slice(0, 80) || 'Sportfest 2026';
    try {
      const result = await sendPushToAll({
        title: customTitle,
        body: customBody.slice(0, 280),
        url: '/'
      });
      appendActivityLogs(user, [{
        action: 'push',
        text: `Eigene Push-Nachricht: „${customBody.slice(0, 80)}${customBody.length > 80 ? '…' : ''}"`
      }]);
      saveData();
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Custom push error:', err);
      return res.status(500).json({ error: 'Push failed' });
    }
  }

  return res.status(400).json({ error: 'matchId, test oder Nachricht erforderlich' });
});

app.post('/api/save', requireAuth, (req, res) => {
  if (!req.body || !Array.isArray(req.body.teams) || !Array.isArray(req.body.matches)) {
    return res.status(400).json({ error: 'Invalid data format' });
  }

  const user = getSessionUser(req);
  const role = user?.role || 'admin';
  const logEntries = Array.isArray(req.body.logEntries) ? req.body.logEntries : [];

  try {
    const preservedSubs = data.pushSubscriptions || [];
    const preservedVapid = data.vapidKeys;
    const preservedLog = data.activityLog || [];

    const savePayload = {
      settings: req.body.settings,
      teams: req.body.teams,
      matches: req.body.matches
    };

    if (role === 'schiri') {
      data = applySchiriSave(savePayload);
    } else {
      data = normalizeData(savePayload);
    }

    data.pushSubscriptions = preservedSubs;
    if (preservedVapid) data.vapidKeys = preservedVapid;
    data.activityLog = preservedLog;
    subscriptions = data.pushSubscriptions;

    appendActivityLogs(user, logEntries);

    saveData();
    io.emit('update', getPublicData());
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message || 'Keine Berechtigung' });
  }
});

io.on('connection', (socket) => {
  socket.emit('update', getPublicData());
});

server.listen(PORT, () => {
  console.log(`Sportfest 2026 running on port ${PORT}`);
  console.log(`Push subscribers: ${subscriptions.length}`);
});
