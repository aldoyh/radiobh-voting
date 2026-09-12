# 📻 Radio Bahrain — Live Audience Voting

A production-ready, real-time voting platform for Radio Bahrain live shows. Built for radio broadcast use cases with strong anti-cheat measures and an elegant bilingual-friendly interface.

## Features

- **One vote per listener** — Combines cryptographically hashed IP + long-lived session cookie
- **Real-time results** — Server-Sent Events (SSE) push updates instantly to all open voting pages
- **Admin dashboard** — Full control: add/edit/remove songs, reset votes, monitor live activity
- **Beautiful dark radio UI** — Bahrain-inspired red + gold accents, fully responsive
- **Zero-config persistence** — Embedded SQLite (`better-sqlite3`) with WAL mode
- **Secure by default** — Helmet headers, rate limiting, signed cookies, trust-proxy aware
- **No build step** — Pure vanilla JS + Tailwind via CDN. Deploy in seconds.

## Quick Start

```bash
# 1. Clone / copy the project
cd radiobh-voting

# 2. Install dependencies
npm install

# 3. (Optional) Configure secrets
cp .env.example .env
# Edit .env — change ADMIN_PASSWORD at minimum

# 4. Run the server
npm start
```

Open:
- **Voter UI**: http://localhost:3000
- **Admin Panel**: http://localhost:3000/admin  
  Default password: `radiobahrain2025` (change immediately!)

## Production Deployment

### Environment Variables

| Variable         | Required | Purpose                              | Recommendation                  |
|------------------|----------|--------------------------------------|---------------------------------|
| `ADMIN_PASSWORD` | Yes      | Password for /admin                  | Long random string              |
| `VOTER_SALT`     | Yes      | Used when hashing voter identity     | 32+ random characters           |
| `SESSION_SECRET` | Yes      | Signs voter + admin cookies          | 32+ random characters           |
| `PORT`           | No       | HTTP port                            | 3000 (or whatever your host uses) |

### Recommended Hosting

- **Fly.io** (excellent free tier + global edge)
- **Railway** / **Render**
- Any VPS with Node 18+

Example Fly.io `fly.toml` snippet:

```toml
[env]
  NODE_ENV = "production"

[http_service]
  internal_port = 3000
```

The app already sets `trust proxy = 1` so real client IPs work correctly behind Cloudflare, Fly, Nginx, etc.

## How the Anti-Cheat Works

1. On first visit → server issues a signed, HttpOnly, 90-day `rbh_sid` cookie
2. On vote → server computes `SHA256( realIP + sessionId + VOTER_SALT )`
3. This hash is stored in the `ballots` table with a UNIQUE constraint
4. Second vote from same person (even with VPN or incognito) is rejected server-side

Combined with rate limiting (8 attempts / 10 minutes per IP), this is extremely robust for radio show scale (hundreds to low thousands of concurrent voters).

## Admin Operations

From `/admin` you can:

- Add, edit, hide, or delete songs while the show is live
- Instantly reset the entire vote (useful between shows)
- Watch a live feed of the most recent votes
- See total participation numbers

All changes are instantly reflected on every listener's screen thanks to SSE broadcasts.

## Project Structure

```
radiobh-voting/
├── server.js              # The entire backend + route handlers
├── lib/
│   └── db.js              # SQLite layer + business logic
├── public/
│   ├── index.html         # Gorgeous voter-facing UI
│   └── admin.html         # Secure admin dashboard
├── data/
│   └── radiobh-votes.db   # Auto-created SQLite database
├── .env.example
├── package.json
└── README.md
```

## Tech Stack

- Node.js + Express
- better-sqlite3 (fast synchronous queries)
- Server-Sent Events for real-time
- Tailwind (CDN) + Font Awesome
- No Redis, no external DB, no frontend bundler

## Future Improvisations (Ideas)

- Time-boxed voting windows (e.g. only open during 7–8pm show)
- Multiple concurrent vote rounds / segments
- SMS fallback voting (Twilio integration)
- Arabic-first full RTL UI
- Analytics export (CSV)
- Public leaderboard page for social media

## License & Usage

Internal production use for Radio Bahrain. Feel free to adapt for other broadcasters.

---

Made with ❤️ for the people of Bahrain listening live.
