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

function loadSubscriptions() {
  try {
    subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch {
    subscriptions = [];
  }
}

function saveSubscriptions() {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2), 'utf8');
}

function loadVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  }
  try {
    return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2), 'utf8');
    console.log('VAPID keys generated and saved to vapid.json');
    return keys;
  }
}

const vapidKeys = loadVapidKeys();
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:sportfest@example.com';

webpush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);

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
    users.forEach(u => {
      const num = parseInt(String(u.id).replace('u', ''), 10);
      if (!isNaN(num) && num >= nextUserId) nextUserId = num + 1;
    });
    return;
  } catch {
    // create default admin
  }

  const defaultUsername = process.env.ADMIN_USERNAME || 'admin';
  const defaultPassword = process.env.ADMIN_PASSWORD || 'sportfest';
  const passwordHash = bcrypt.hashSync(defaultPassword, 10);
  users = [{ id: 'u1', username: defaultUsername, passwordHash }];
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
  return { id: user.id, username: user.username };
}

loadData();
loadSubscriptions();
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
    title: '⚽ Spiel gestartet — Sportfest 2025',
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

app.get('/api/auth/users', requireAuth, (req, res) => {
  res.json({ users: users.map(sanitizeUser) });
});

app.post('/api/auth/users', requireAuth, (req, res) => {
  const { username, password } = req.body || {};
  const trimmed = String(username || '').trim();
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
    passwordHash: bcrypt.hashSync(password, 10)
  };
  users.push(user);
  saveUsers();
  res.json({ ok: true, user: sanitizeUser(user) });
});

app.delete('/api/auth/users/:id', requireAuth, (req, res) => {
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
  res.json(data);
});

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.get('/api/push/status', requireAuth, (req, res) => {
  res.json({ subscribers: subscriptions.length });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    console.error('Push subscribe: invalid body', req.body);
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const exists = subscriptions.some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    subscriptions.push(sub);
    saveSubscriptions();
    console.log('Push subscribe: new subscriber, total:', subscriptions.length);
  }
  res.json({ ok: true, subscribers: subscriptions.length });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  saveSubscriptions();
  res.json({ ok: true });
});

app.post('/api/push/notify', requireAuth, async (req, res) => {
  const { matchId, test, title, body, message } = req.body;

  if (test) {
    try {
      const result = await sendPushToAll({
        title: '🔔 Test — Sportfest 2025',
        body: 'Push-Benachrichtigungen funktionieren!',
        url: '/'
      });
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
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Push error:', err);
      return res.status(500).json({ error: 'Push failed' });
    }
  }

  const customBody = String(body || message || '').trim();
  if (customBody) {
    const customTitle = String(title || 'Sportfest 2025').trim().slice(0, 80) || 'Sportfest 2025';
    try {
      const result = await sendPushToAll({
        title: customTitle,
        body: customBody.slice(0, 280),
        url: '/'
      });
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
  data = normalizeData(req.body);
  saveData();
  io.emit('update', data);
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('update', data);
});

server.listen(PORT, () => {
  console.log(`Sportfest 2025 running on port ${PORT}`);
  console.log(`Push subscribers: ${subscriptions.length}`);
});
