/**
 * WebRTC Chat by RCE — Signaling + Media Relay Server
 * ────────────────────────────────────────────────────
 * Self-contained module: works on any server.
 * - WebRTC peer-to-peer with self-hosted TURN (when on a VPS with public IP)
 * - WebSocket media relay fallback (when behind NAT / no public IP)
 * - Server-side audio recording for post-call transcription
 * - No live SpeechRecognition (saves CPU on client devices)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const TURN_PORT = process.env.TURN_PORT || 3478;
const TURN_SECRET = process.env.TURN_SECRET || 'rce-webrtc-shared-secret';
const PUBLIC_IP = process.env.PUBLIC_IP || ''; // Set on VPS for TURN
const RECORDINGS_DIR = path.join(__dirname, 'recordings');

// Ensure recordings directory exists
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

/**
 * Generate time-limited TURN credentials using the shared secret.
 * These credentials expire after 24 hours (coturn validates them).
 */
function generateTurnCreds() {
  const ttl = 86400; // 24 hours
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username = timestamp + ':webrtc';
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(username);
  const credential = hmac.digest('base64');
  return { username, credential };
}

/**
 * Build the ICE servers array for WebRTC.
 * If PUBLIC_IP is set (VPS deployment), includes our own STUN/TURN.
 * Otherwise falls back to Google STUN for NAT discovery.
 */
function getIceServers() {
  if (PUBLIC_IP) {
    const creds = generateTurnCreds();
    return [
      { urls: `stun:${PUBLIC_IP}:${TURN_PORT}` },
      {
        urls: [
          `turn:${PUBLIC_IP}:${TURN_PORT}`,
          `turn:${PUBLIC_IP}:${TURN_PORT}?transport=tcp`,
        ],
        username: creds.username,
        credential: creds.credential,
      },
    ];
  }
  // Fallback: Google STUN only (free, for NAT discovery)
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// ── Detect public IP ────────────────────────────────
function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// Old getICEServers removed — replaced by getIceServers() at top

// ── State ───────────────────────────────────────────
const clients = new Map();    // roomId → { name, roomId, connectedAt, ws }
const rooms = new Map();      // roomId → { peers: Set<ws>, persistent: bool }
const staffSubs = new Set();  // staff dashboard WebSockets
const transcripts = new Map(); // roomId → [ { callId, startedAt, entries, summary } ]

function generateRoomId() {
  return crypto.randomBytes(3).toString('hex');
}

function getOrCreateRoom(roomId, persistent = false) {
  if (!rooms.has(roomId)) rooms.set(roomId, { peers: new Set(), persistent });
  const room = rooms.get(roomId);
  if (persistent) room.persistent = true;
  return room;
}

function getClientList() {
  const list = [];
  for (const [roomId, client] of clients) {
    const room = rooms.get(roomId);
    const peerCount = room ? room.peers.size : 0;
    const clientTranscripts = transcripts.get(roomId) || [];
    list.push({
      roomId,
      name: client.name,
      connectedAt: client.connectedAt,
      online: !!client.ws && client.ws.readyState === 1,
      inCall: peerCount > 1,
      transcriptCount: clientTranscripts.length,
      lastCall: clientTranscripts.length > 0
        ? clientTranscripts[clientTranscripts.length - 1].startedAt
        : null,
    });
  }
  return list;
}

function broadcastClientList() {
  const list = getClientList();
  const msg = JSON.stringify({ type: 'client-list', clients: list });
  for (const ws of staffSubs) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── HTTP server ─────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  // API: ICE servers for WebRTC
  if (url.pathname === '/api/ice-servers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ iceServers: getIceServers() }));
  }

  // API: Clients
  if (url.pathname === '/api/clients') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ clients: getClientList() }));
  }

  // API: Transcripts
  if (url.pathname.match(/^\/api\/transcripts\/[a-f0-9]{6}$/i)) {
    const roomId = url.pathname.split('/').pop();
    const clientTranscripts = transcripts.get(roomId) || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ roomId, transcripts: clientTranscripts }));
  }

  // API: Create room
  if (url.pathname === '/api/create-room' && req.method === 'POST') {
    const roomId = generateRoomId();
    getOrCreateRoom(roomId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ roomId }));
  }

  // API: Upload audio recording (POST /api/upload-recording/:roomId/:role)
  if (req.method === 'POST' && url.pathname.match(/^\/api\/upload-recording\/[a-f0-9]+\/.+$/i)) {
    const parts = url.pathname.split('/');
    const roomId = parts[3];
    const role = parts[4] || 'unknown';
    const roomDir = path.join(RECORDINGS_DIR, roomId);
    if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });
    const filename = `${Date.now().toString(36)}-${role}.webm`;
    const filePath = path.join(roomDir, filename);
    const writeStream = fs.createWriteStream(filePath);
    req.pipe(writeStream);
    writeStream.on('finish', () => {
      console.log(`[${roomId}] 🎙️ Upload saved: ${filename} (${role})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file: filename }));
    });
    writeStream.on('error', (e) => {
      console.error(`[${roomId}] Upload error:`, e.message);
      res.writeHead(500); res.end('Upload failed');
    });
    return;
  }

  // Client page
  if (url.pathname === '/client' || url.pathname.match(/^\/client\/[a-f0-9]{6}$/i)) {
    return serveFile(res, 'client.html');
  }

  // Room page
  if (url.pathname.match(/^\/[a-f0-9]{6}$/i)) {
    return serveFile(res, 'room.html');
  }

  // Static files
  let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  const ext = path.extname(filePath);
  if (!ext) filePath += '.html';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

function serveFile(res, filename) {
  fs.readFile(path.join(__dirname, 'public', filename), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
}

// ── WebSocket signaling + media relay ───────────────
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 }); // 1MB max for video chunks

function heartbeat() { this.isAlive = true; }
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);
wss.on('close', () => clearInterval(pingInterval));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  ws.roomId = null;
  ws.userId = crypto.randomBytes(4).toString('hex');
  ws.role = null;

  ws.on('message', (raw, isBinary) => {
    // ── Binary = media chunk → relay to other peer ──
    if (isBinary) {
      const room = rooms.get(ws.roomId);
      if (!room) return;

      // Relay to other peer(s)
      let relayed = 0;
      for (const peer of room.peers) {
        if (peer !== ws && peer.readyState === 1) {
          peer.send(raw, { binary: true });
          relayed++;
        }
      }

      // Record chunks to disk for post-call transcription
      if (!ws._recordStream && ws.roomId) {
        try {
          const roomDir = path.join(RECORDINGS_DIR, ws.roomId);
          if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });
          const callId = Date.now().toString(36);
          const filename = `${callId}-${ws.role || 'unknown'}.webm`;
          ws._recordFile = path.join(roomDir, filename);
          ws._recordStream = fs.createWriteStream(ws._recordFile);
          console.log(`[${ws.roomId}] 🎙️ Recording ${ws.role} audio → ${filename}`);
        } catch (e) {
          console.error(`[${ws.roomId}] Failed to start recording:`, e.message);
        }
      }
      if (ws._recordStream) {
        ws._recordStream.write(Buffer.from(raw));
      }

      // Log periodically (first chunk and every 100th)
      if (!ws._binaryCount) ws._binaryCount = 0;
      ws._binaryCount++;
      if (ws._binaryCount === 1 || ws._binaryCount % 100 === 0) {
        console.log(`[${ws.roomId}] 📦 Binary from ${ws.role} ${ws.userId}: ${raw.length}B (chunk #${ws._binaryCount}, relayed to ${relayed} peers)`);
      }
      return;
    }

    // ── JSON = signaling ────────────────────────────
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'staff-subscribe': {
        ws.role = 'staff-dashboard';
        staffSubs.add(ws);
        ws.send(JSON.stringify({ type: 'client-list', clients: getClientList() }));
        console.log(`[dashboard] Staff subscribed (${staffSubs.size} active)`);
        break;
      }

      case 'client-register': {
        const roomId = msg.roomId;
        const name = msg.name || `Client ${roomId}`;
        ws.role = 'client';
        ws.roomId = roomId;

        const room = getOrCreateRoom(roomId, true);

        // ★ Clean up any stale client connections for this room
        for (const peer of room.peers) {
          if (peer !== ws && peer.role === 'client') {
            console.log(`[${roomId}] ⚠️  Removing stale client WS ${peer.userId}`);
            room.peers.delete(peer);
          }
        }

        room.peers.add(ws);
        clients.set(roomId, { name, roomId, connectedAt: Date.now(), ws });
        ws.send(JSON.stringify({ type: 'registered', roomId, name, iceServers: getIceServers() }));
        console.log(`[${roomId}] ✅ Client "${name}" registered (${room.peers.size} peers in room)`);

        // ★ If staff is already in the room, BOTH sides need peer-joined
        if (room.peers.size >= 2) {
          console.log(`[${roomId}] 🔗 Two peers present — notifying both to start streaming`);

          // Start a new transcript
          const callId = crypto.randomBytes(4).toString('hex');
          if (!transcripts.has(roomId)) transcripts.set(roomId, []);
          transcripts.get(roomId).push({
            callId, startedAt: Date.now(), endedAt: null, entries: [], summary: null,
          });

          // Tell EVERY peer about the other
          for (const peer of room.peers) {
            if (peer.readyState === 1) {
              const otherPeers = [...room.peers].filter(p => p !== peer);
              const otherId = otherPeers.length > 0 ? otherPeers[0].userId : 'unknown';
              peer.send(JSON.stringify({ type: 'peer-joined', userId: otherId }));
              console.log(`[${roomId}]   → Sent peer-joined to ${peer.role} ${peer.userId}`);
            }
          }
        }

        broadcastClientList();
        break;
      }

      case 'join': {
        const roomId = msg.roomId;
        const room = getOrCreateRoom(roomId);

        // ★ Clean up any stale staff connections for this room
        for (const peer of room.peers) {
          if (peer !== ws && peer.role === 'staff') {
            console.log(`[${roomId}] ⚠️  Removing stale staff WS ${peer.userId}`);
            room.peers.delete(peer);
          }
        }

        if (room.peers.size >= 2 && !room.peers.has(ws)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
          console.log(`[${roomId}] ❌ Room full, rejecting ${ws.userId}`);
          return;
        }

        ws.roomId = roomId;
        if (!ws.role) ws.role = 'staff';
        room.peers.add(ws);
        const peerCount = room.peers.size;

        console.log(`[${roomId}] ✅ ${ws.role} ${ws.userId} joined (${peerCount} peers in room)`);

        // Start transcript for this call
        if (peerCount >= 2) {
          const callId = crypto.randomBytes(4).toString('hex');
          if (!transcripts.has(roomId)) transcripts.set(roomId, []);
          transcripts.get(roomId).push({
            callId, startedAt: Date.now(), endedAt: null, entries: [], summary: null,
          });
        }

        ws.send(JSON.stringify({
          type: 'joined', roomId, userId: ws.userId, peerCount,
          isInitiator: peerCount >= 2,
          iceServers: getIceServers(),
        }));

        // ★ If both peers are now present, notify EVERYONE
        if (peerCount >= 2) {
          console.log(`[${roomId}] 🔗 Two peers present — notifying both to start streaming`);
          for (const peer of room.peers) {
            if (peer !== ws && peer.readyState === 1) {
              peer.send(JSON.stringify({ type: 'peer-joined', userId: ws.userId }));
              console.log(`[${roomId}]   → Sent peer-joined to ${peer.role} ${peer.userId}`);
            }
          }
        }

        broadcastClientList();
        break;
      }

      // WebRTC signaling relay (used when TURN works, e.g., on VPS)
      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        for (const peer of room.peers) {
          if (peer !== ws && peer.readyState === 1) {
            peer.send(JSON.stringify({ ...msg, from: ws.userId }));
          }
        }
        break;
      }

      // Peer restarted their MediaRecorder — tell the other side to rebuild MSE
      case 'new-stream': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        for (const peer of room.peers) {
          if (peer !== ws && peer.readyState === 1) {
            peer.send(JSON.stringify({ type: 'new-stream' }));
          }
        }
        console.log(`[${ws.roomId}] 🔄 ${ws.role} sent new-stream signal`);
        break;
      }

      case 'transcript': {
        const roomId = ws.roomId;
        if (!roomId) return;
        const clientTranscripts = transcripts.get(roomId);
        if (!clientTranscripts || clientTranscripts.length === 0) return;
        const currentCall = clientTranscripts[clientTranscripts.length - 1];
        if (currentCall.endedAt) return;

        const entry = {
          speaker: msg.speaker || (ws.role === 'client' ? 'Client' : 'Staff'),
          text: msg.text,
          timestamp: Date.now(),
          isFinal: msg.isFinal !== false,
        };

        if (entry.isFinal && entry.text.trim()) {
          currentCall.entries.push(entry);
          const room = rooms.get(roomId);
          if (room) {
            for (const peer of room.peers) {
              if (peer !== ws && peer.readyState === 1) {
                peer.send(JSON.stringify({ type: 'transcript', ...entry }));
              }
            }
          }
          broadcastClientList();
        }
        break;
      }

      case 'chat': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        for (const peer of room.peers) {
          if (peer !== ws && peer.readyState === 1) {
            peer.send(JSON.stringify({
              type: 'chat', from: ws.userId, message: msg.message, timestamp: Date.now(),
            }));
          }
        }
        break;
      }

      case 'hang-up': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const clientTranscripts = transcripts.get(ws.roomId);
        if (clientTranscripts && clientTranscripts.length > 0) {
          const current = clientTranscripts[clientTranscripts.length - 1];
          if (!current.endedAt) current.endedAt = Date.now();
        }
        for (const peer of room.peers) {
          if (peer !== ws && peer.readyState === 1) {
            peer.send(JSON.stringify({ type: 'peer-left', userId: ws.userId }));
          }
        }
        broadcastClientList();
        break;
      }

      // Client requests WS relay mode
      case 'request-ws-relay': {
        ws.send(JSON.stringify({ type: 'ws-relay-ready' }));
        const room = rooms.get(ws.roomId);
        if (room) {
          for (const peer of room.peers) {
            if (peer !== ws && peer.readyState === 1) {
              peer.send(JSON.stringify({ type: 'ws-relay-ready' }));
            }
          }
        }
        console.log(`[${ws.roomId}] WS relay mode activated`);
        break;
      }
    }
  });

  ws.on('close', () => {
    staffSubs.delete(ws);

    // Close any active recording stream
    if (ws._recordStream) {
      ws._recordStream.end();
      console.log(`[${ws.roomId}] 🎙️ Recording saved: ${ws._recordFile}`);
      ws._recordStream = null;
    }

    if (ws.roomId && rooms.has(ws.roomId)) {
      const room = rooms.get(ws.roomId);
      room.peers.delete(ws);

      const clientTranscripts = transcripts.get(ws.roomId);
      if (clientTranscripts && clientTranscripts.length > 0) {
        const current = clientTranscripts[clientTranscripts.length - 1];
        if (!current.endedAt) current.endedAt = Date.now();
      }

      for (const peer of room.peers) {
        if (peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'peer-left', userId: ws.userId }));
        }
      }

      if (ws.role === 'client') {
        const client = clients.get(ws.roomId);
        if (client && client.ws === ws) clients.delete(ws.roomId);
      }

      if (room.peers.size === 0 && !room.persistent) rooms.delete(ws.roomId);
      console.log(`[${ws.roomId}] 👋 ${ws.role || '?'} ${ws.userId} disconnected (${room.peers.size} peers remain)`);
      broadcastClientList();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log(`\n⚡ WebRTC Chat by RCE — running on http://localhost:${PORT}`);
  console.log(`\n📺 Tablet/Client:   http://localhost:${PORT}/client`);
  console.log(`📡 Staff Dashboard: http://localhost:${PORT}`);
  if (ips.length > 0) {
    console.log(`\n🌐 LAN access: ${ips.map(ip => `http://${ip}:${PORT}`).join(', ')}`);
  }
  console.log(`\n📡 Media relay: WebSocket (built-in, works behind any NAT)`);
  console.log(`🔑 TURN secret: ${TURN_SECRET}\n`);
});
