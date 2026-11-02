const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');

let database = { sessions: {}, locations: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    database = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    console.error('Error loading DB, initializing fresh:', e);
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(database, null, 2));
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create tracking session
app.post('/api/sessions', (req, res) => {
  const sessionId = crypto.randomBytes(4).toString('hex');
  const label = (req.body && req.body.label) ? req.body.label.trim() : 'Target Device';
  const now = Date.now();

  database.sessions[sessionId] = {
    sessionId,
    label,
    createdAt: now
  };
  database.locations[sessionId] = [];
  saveDB();

  res.json(database.sessions[sessionId]);
});

// List all sessions
app.get('/api/sessions', (req, res) => {
  const list = Object.values(database.sessions).map(s => {
    const locs = database.locations[s.sessionId] || [];
    const lastLoc = locs.length > 0 ? locs[locs.length - 1] : null;
    return {
      sessionId: s.sessionId,
      label: s.label,
      createdAt: s.createdAt,
      pointCount: locs.length,
      lastSeen: lastLoc ? lastLoc.timestamp : null
    };
  }).sort((a, b) => b.createdAt - a.createdAt);

  res.json(list);
});

// Get session details and location history
app.get('/api/sessions/:id', (req, res) => {
  const session = database.sessions[req.params.id];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const points = database.locations[req.params.id] || [];
  res.json({
    ...session,
    points
  });
});

// Delete session
app.delete('/api/sessions/:id', (req, res) => {
  delete database.sessions[req.params.id];
  delete database.locations[req.params.id];
  saveDB();
  res.json({ status: 'deleted' });
});

// Receive location ping from target
app.post('/api/location/:id', (req, res) => {
  const sessionId = req.params.id;
  const now = Date.now();

  if (!database.sessions[sessionId]) {
    database.sessions[sessionId] = {
      sessionId,
      label: 'Direct Client',
      createdAt: now
    };
    database.locations[sessionId] = [];
  }

  const payload = {
    sessionId,
    latitude: parseFloat(req.body.latitude),
    longitude: parseFloat(req.body.longitude),
    accuracy: parseFloat(req.body.accuracy) || 0,
    speed: parseFloat(req.body.speed) || 0,
    heading: parseFloat(req.body.heading) || 0,
    battery: parseFloat(req.body.battery) || 0,
    timestamp: now
  };

  database.locations[sessionId].push(payload);
  saveDB();

  // Real-time broadcast to all connected admin clients for this session
  io.to(sessionId).emit('location_update', payload);

  res.json({ status: 'ok', timestamp: now });
});

// Socket.io room management
io.on('connection', (socket) => {
  socket.on('join_session', (sessionId) => {
    socket.join(sessionId);
  });
});

// Target mobile page
app.get('/track/:id', (req, res) => {
  const trackPath = path.join(__dirname, 'public', 'track.html');
  let html = fs.readFileSync(trackPath, 'utf-8');
  html = html.replace(/{{SESSION_ID}}/g, req.params.id);
  res.send(html);
});

// Admin dashboard route
app.get(['/', '/admin'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Node.js Location Tracker running on http://0.0.0.0:${PORT}`);
});

