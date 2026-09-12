const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'radiobh-votes.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT DEFAULT '',
    display_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ballots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id INTEGER NOT NULL,
    voter_hash TEXT NOT NULL UNIQUE,
    ip_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ballots_song ON ballots(song_id);
  CREATE INDEX IF NOT EXISTS idx_ballots_voter ON ballots(voter_hash);
`);

// Seed initial songs if none exist
const songCount = db.prepare('SELECT COUNT(*) as count FROM songs').get().count;
if (songCount === 0) {
  const seedSongs = [
    { title: 'Bahrain Nights', artist: 'Ahmed Al Qassim' },
    { title: 'Pearl of the Gulf', artist: 'Fatima Al Mahmoud' },
    { title: 'Desert Rose', artist: 'Khalid Bin Ali' },
    { title: 'Sea of Pearls', artist: 'Layla Hassan' },
    { title: 'Heritage Beat', artist: 'Mohammed Al Dosari' },
    { title: 'Sunset in Manama', artist: 'Aisha Al Khalifa' }
  ];
  
  const insert = db.prepare('INSERT INTO songs (title, artist, display_order) VALUES (?, ?, ?)');
  seedSongs.forEach((song, i) => {
    insert.run(song.title, song.artist, i);
  });
  console.log('[DB] Seeded 6 initial songs for Radio Bahrain voting');
}

// Prepared statements
const stmts = {
  getActiveSongs: db.prepare(`
    SELECT id, title, artist, display_order 
    FROM songs 
    WHERE active = 1 
    ORDER BY display_order ASC, id ASC
  `),
  
  getAllSongs: db.prepare(`
    SELECT id, title, artist, display_order, active 
    FROM songs 
    ORDER BY display_order ASC, id ASC
  `),
  
  addSong: db.prepare(`
    INSERT INTO songs (title, artist, display_order) 
    VALUES (?, ?, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM songs))
  `),
  
  updateSong: db.prepare('UPDATE songs SET title = ?, artist = ? WHERE id = ?'),
  
  toggleSongActive: db.prepare('UPDATE songs SET active = ? WHERE id = ?'),
  
  deleteSong: db.prepare('DELETE FROM songs WHERE id = ?'),
  
  getResults: db.prepare(`
    SELECT 
      s.id,
      s.title,
      s.artist,
      COUNT(b.id) as vote_count
    FROM songs s
    LEFT JOIN ballots b ON b.song_id = s.id
    WHERE s.active = 1
    GROUP BY s.id
    ORDER BY vote_count DESC, s.display_order ASC
  `),
  
  getTotalVotes: db.prepare('SELECT COUNT(*) as total FROM ballots'),
  
  hasVoted: db.prepare('SELECT 1 FROM ballots WHERE voter_hash = ?'),
  
  insertBallot: db.prepare(`
    INSERT INTO ballots (song_id, voter_hash, ip_hash) 
    VALUES (?, ?, ?)
  `),
  
  resetAll: db.prepare('DELETE FROM ballots'),
  
  getRecentVotes: db.prepare(`
    SELECT b.created_at, s.title 
    FROM ballots b 
    JOIN songs s ON s.id = b.song_id 
    ORDER BY b.created_at DESC 
    LIMIT 20
  `)
};

function getVoterHash(ip, sessionId, salt) {
  const data = `${ip || 'unknown'}|${sessionId || 'no-session'}|${salt || 'rbh2025'}`;
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 32);
}

function getResultsWithPercent() {
  const rows = stmts.getResults.all();
  const total = rows.reduce((sum, r) => sum + r.vote_count, 0) || 1;
  
  return rows.map(row => ({
    id: row.id,
    title: row.title,
    artist: row.artist,
    votes: row.vote_count,
    percent: total > 0 ? Math.round((row.vote_count / total) * 100) : 0
  }));
}

module.exports = {
  db,
  stmts,
  getVoterHash,
  getResultsWithPercent,
  
  // Convenience methods
  getActiveSongs: () => stmts.getActiveSongs.all(),
  getAllSongsAdmin: () => stmts.getAllSongs.all(),
  addSong: (title, artist) => stmts.addSong.run(title, artist || ''),
  updateSong: (id, title, artist) => stmts.updateSong.run(title, artist || '', id),
  toggleSong: (id, active) => stmts.toggleSongActive.run(active ? 1 : 0, id),
  deleteSong: (id) => stmts.deleteSong.run(id),
  
  castVote: (songId, voterHash, ipHash) => {
    const info = stmts.insertBallot.run(songId, voterHash, ipHash);
    return info.changes > 0;
  },
  
  hasAlreadyVoted: (voterHash) => !!stmts.hasVoted.get(voterHash),
  
  getVoteStats: () => ({
    totalVotes: stmts.getTotalVotes.get().total
  }),
  
  resetAllVotes: () => stmts.resetAll.run(),
  
  getRecentActivity: () => stmts.getRecentVotes.all()
};
