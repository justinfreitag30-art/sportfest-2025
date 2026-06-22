const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const VAPID_FILE = path.join(__dirname, 'vapid.json');
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');

let data = { settings: { gameDurationMinutes: 10 }, teams: [], matches: [] };
let subscriptions = [];

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

loadData();
loadSubscriptions();

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
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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

app.get('/api/push/status', (req, res) => {
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

app.post('/api/push/notify', async (req, res) => {
  const { matchId, test } = req.body;

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

  if (!matchId) {
    return res.status(400).json({ error: 'matchId required' });
  }
  const match = data.matches.find(m => m.id === matchId);
  if (!match) {
    return res.status(404).json({ error: 'Match not found' });
  }
  try {
    const result = await sendPushToAll(buildMatchPushPayload(match));
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Push error:', err);
    res.status(500).json({ error: 'Push failed' });
  }
});

app.post('/api/save', (req, res) => {
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
