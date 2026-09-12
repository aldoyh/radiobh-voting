**Voting App Code for Radio Bahrain**

Simple full-stack Node.js/Express app with IP + session voting limit.

**1. server.js** (Backend):
```js
const express = require('express');
const app = express();
const votes = new Map(); // songId -> count
const votedIPs = new Set();
const votedSessions = new Set();

app.use(express.json());
app.use(express.static('public'));

app.get('/songs', (req, res) => res.json([
  {id:1, title:'Song A'}, {id:2, title:'Song B'}, {id:3, title:'Song C'}
]));

app.post('/vote', (req, res) => {
  const ip = req.ip;
  const session = req.headers['x-session'] || 'default';
  if (votedIPs.has(ip) || votedSessions.has(session)) {
    return res.status(403).json({error: 'Already voted'});
  }
  const {songId} = req.body;
  votes.set(songId, (votes.get(songId) || 0) + 1);
  votedIPs.add(ip);
  votedSessions.add(session);
  res.json({success: true, votes: Object.fromEntries(votes)});
});

app.get('/results', (req, res) => res.json(Object.fromEntries(votes)));

app.listen(3000, () => console.log('Voting app on http://localhost:3000'));
```

**2. public/index.html** (Frontend):
```html
<!DOCTYPE html>
<html>
<head><title>Radio Bahrain Vote</title></head>
<body>
  <h1>Radio Bahrain Audience Vote</h1>
  <div id="songs"></div>
  <div id="result"></div>

  <script>
    fetch('/songs').then(r=>r.json()).then(songs => {
      const div = document.getElementById('songs');
      songs.forEach(s => {
        const btn = document.createElement('button');
        btn.textContent = `Vote ${s.title}`;
        btn.onclick = () => vote(s.id);
        div.appendChild(btn);
      });
    });

    function vote(id) {
      fetch('/vote', {
        method: 'POST',
        headers: {'Content-Type':'application/json', 'x-session': Math.random().toString()},
        body: JSON.stringify({songId: id})
      }).then(r => r.json()).then(data => {
        document.getElementById('result').innerHTML = JSON.stringify(data);
      });
    }
  </script>
</body>
</html>
```

**Setup**: `npm init -y && npm i express` → Run `node server.js`. Deploy on VPS/Heroku.

For production: Use Redis/DB for persistence, rate limiting, CAPTCHA.