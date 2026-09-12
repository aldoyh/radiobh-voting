require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const morgan = require('morgan');
const crypto = require('crypto');
const path = require('path');

const {
  getActiveSongs,
  getAllSongsAdmin,
  addSong,
  updateSong,
  toggleSong,
  deleteSong,
  getResultsWithPercent,
  getVoteStats,
  castVote,
  hasAlreadyVoted,
  getVoterHash,
  resetAllVotes,
  getRecentActivity
} = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'radiobahrain2025';
const VOTER_SALT = process.env.VOTER_SALT || 'rbh-vote-salt-2025-change-me';
const SESSION_SECRET = process.env.SESSION_SECRET || 'rbh-sid-secret-please-change-in-prod';

// Trust proxy for accurate IPs behind load balancers / proxies (Heroku, Fly.io, Cloudflare, etc.)
app.set('trust proxy', 1);

// Security & performance middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https:"],
    }
  }
}));
app.use(compression());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(SESSION_SECRET));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Static assets
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ========== SESSION + VOTER HELPERS ==========
const ADMIN_SESSIONS = new Set(); // Simple in-memory admin sessions (restart clears)

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function getClientIP(req) {
  // Priority order for real client IP
  const forwarded = req.headers['cf-connecting-ip'] || 
                    req.headers['x-real-ip'] ||
                    (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '0.0.0.0';
}

function ensureVoterSession(req, res) {
  let sid = req.signedCookies.rbh_sid;
  if (!sid) {
    sid = generateSessionId();
    res.cookie('rbh_sid', sid, {
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      maxAge: 1000 * 60 * 60 * 24 * 90 // 90 days
    });
  }
  return sid;
}

function getVoterHashFromRequest(req) {
  const ip = getClientIP(req);
  const sid = ensureVoterSession(req, res); // note: will set cookie if needed
  // We need to pass res too for cookie setting, so this helper is used carefully
  return null; // intentionally not used alone
}

// ========== RATE LIMITING ==========
const voteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 8, // generous but safe
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req),
  message: { error: 'Too many voting attempts. Please try again later.' }
});

const adminLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => getClientIP(req)
});

// ========== LIVE RESULTS (SSE) ==========
let sseClients = new Set();

function broadcastResults() {
  const payload = JSON.stringify({
    type: 'results',
    data: {
      results: getResultsWithPercent(),
      stats: getVoteStats()
    }
  });
  
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (e) {
      sseClients.delete(res);
    }
  }
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // for nginx

  // Send initial data
  const initial = JSON.stringify({
    type: 'results',
    data: {
      results: getResultsWithPercent(),
      stats: getVoteStats()
    }
  });
  res.write(`data: ${initial}\n\n`);

  sseClients.add(res);

  // Keep-alive ping every 25s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ========== PUBLIC API ==========
app.get('/api/songs', (req, res) => {
  res.json({ songs: getActiveSongs() });
});

app.get('/api/results', (req, res) => {
  res.json({
    results: getResultsWithPercent(),
    stats: getVoteStats()
  });
});

app.get('/api/status', (req, res) => {
  const stats = getVoteStats();
  res.json({
    votingOpen: true, // can be made dynamic later
    totalVotes: stats.totalVotes,
    serverTime: new Date().toISOString()
  });
});

app.post('/api/vote', voteLimiter, (req, res) => {
  try {
    const { songId } = req.body;
    if (!songId || typeof songId !== 'number') {
      return res.status(400).json({ error: 'Invalid song selection' });
    }

    const sid = ensureVoterSession(req, res); // ensures cookie is set
    const ip = getClientIP(req);
    const voterHash = getVoterHash(ip, sid, VOTER_SALT);

    if (hasAlreadyVoted(voterHash)) {
      return res.status(403).json({ error: 'You have already voted in this round' });
    }

    // Verify song exists and is active
    const songs = getActiveSongs();
    const valid = songs.some(s => s.id === songId);
    if (!valid) {
      return res.status(400).json({ error: 'Song not available for voting' });
    }

    const ipHash = crypto.createHash('sha256').update(ip + VOTER_SALT).digest('hex').slice(0, 16);
    const success = castVote(songId, voterHash, ipHash);

    if (!success) {
      return res.status(500).json({ error: 'Failed to record vote' });
    }

    const results = getResultsWithPercent();
    const stats = getVoteStats();

    // Live push to everyone
    broadcastResults();

    res.json({
      success: true,
      message: 'Thank you! Your vote has been recorded.',
      yourVote: songId,
      results,
      stats
    });
  } catch (err) {
    console.error('Vote error:', err);
    res.status(500).json({ error: 'Server error while recording vote' });
  }
});

// ========== ADMIN AUTH ==========
function requireAdmin(req, res, next) {
  const token = req.signedCookies.rbh_admin;
  if (token && ADMIN_SESSIONS.has(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Admin authentication required' });
}

app.post('/api/admin/login', adminLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  ADMIN_SESSIONS.add(token);

  res.cookie('rbh_admin', token, {
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    maxAge: 1000 * 60 * 60 * 8 // 8 hours
  });

  res.json({ success: true, message: 'Welcome, Radio Bahrain admin' });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.signedCookies.rbh_admin;
  if (token) ADMIN_SESSIONS.delete(token);
  res.clearCookie('rbh_admin');
  res.json({ success: true });
});

app.get('/api/admin/me', (req, res) => {
  const token = req.signedCookies.rbh_admin;
  res.json({ authenticated: !!(token && ADMIN_SESSIONS.has(token)) });
});

// ========== ADMIN ACTIONS ==========
app.get('/api/admin/songs', requireAdmin, (req, res) => {
  res.json({ songs: getAllSongsAdmin() });
});

app.post('/api/admin/songs', requireAdmin, (req, res) => {
  const { title, artist } = req.body;
  if (!title || title.trim().length < 2) {
    return res.status(400).json({ error: 'Title is required' });
  }
  const info = addSong(title.trim(), artist?.trim() || '');
  broadcastResults(); // in case admin adds while people are watching
  res.json({ success: true, id: info.lastInsertRowid });
});

app.put('/api/admin/songs/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { title, artist } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  updateSong(id, title.trim(), artist?.trim() || '');
  res.json({ success: true });
});

app.post('/api/admin/songs/:id/toggle', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { active } = req.body;
  toggleSong(id, !!active);
  broadcastResults();
  res.json({ success: true });
});

app.delete('/api/admin/songs/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  deleteSong(id);
  broadcastResults();
  res.json({ success: true });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  resetAllVotes();
  broadcastResults();
  res.json({ success: true, message: 'All votes have been reset' });
});

app.get('/api/admin/activity', requireAdmin, (req, res) => {
  res.json({ recent: getRecentActivity(), stats: getVoteStats() });
});

// ========== HTML PAGES (No build step) ==========

// Main voter page
app.get('/', (req, res) => {
  // Ensure voter cookie exists even on page load
  ensureVoterSession(req, res);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin panel page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    votes: getVoteStats().totalVotes 
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

// ========== START ==========
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║   📻 Radio Bahrain — Live Audience Voting                  ║
║                                                            ║
║   Server running on http://localhost:${PORT}                ║
║                                                            ║
║   Voter UI:     http://localhost:${PORT}/                   ║
║   Admin Panel:  http://localhost:${PORT}/admin              ║
║                                                            ║
║   Admin password: ${ADMIN_PASSWORD.padEnd(36)}║
╚════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  sseClients.forEach(r => r.end());
  process.exit(0);
});
