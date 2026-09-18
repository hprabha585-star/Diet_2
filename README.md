# FastCoach (MySQL / Hostinger rewrite)

Coach-led fasting cohort platform, rebuilt on MySQL for Hostinger, plus a
new self-guided **Fasting Tracker** plan for clients who don't want a
coach or the 55-day protocol at all.

```
fastcoach/
├── config/db.js          Sequelize + MySQL connection
├── models/index.js        All tables (Sequelize models) + associations
├── middleware/auth.js      JWT auth
├── routes/                 auth.js, client.js, admin.js
├── utils/                  helpers, protocol day *defaults* (reference only), seed/check scripts
├── public/                 static frontend — served by the SAME Node process
│   ├── index.html           landing + login/register
│   ├── client/dashboard.html + js/client.js
│   ├── admin/dashboard.html  + js/admin.js
│   └── css/                tokens.css, landing.css, dashboard.css
└── server.js               one process: /api/* + static frontend
```

## What changed from the Render/MongoDB version

1. **Database**: MongoDB/Mongoose → MySQL/Sequelize. Every model was
   redesigned as relational tables (see `models/index.js`). Embedded
   arrays (weight logs, water entries, checklist items, meals,
   milestones) are now their own tables with foreign keys.
2. **Single process, single host**: Hostinger runs one Node app, so the
   frontend is now served as static files from the same Express process
   as the API. There's no more `config.js` API base URL, no
   `CLIENT_ORIGIN`/CORS config, and no `render.yaml` — everything is
   same-origin.
3. **Fasting/eating window timing bug — fixed.** The old code computed
   the live fasting state on the server using the server's own clock
   (`now.getHours()`), so if the server ran in UTC every client in IST
   saw a window 5h30m off. The server now only ever sends
   `startHour`/`endHour`/`isFullDayFast`; **every browser computes its
   own state and countdown in its own local time**
   (`public/js/api.js` → `computeFastingState`). Challenge-day rollover
   (`User.currentChallengeDay()`) now compares calendar dates, not raw
   millisecond timestamps, so it rolls at local midnight instead of at
   whatever clock time the client happened to be activated.
4. **"Assign plan" replaces the standalone 55-day protocol tab.** There
   is no more separately-edited `ProtocolDay` table that could drift out
   of sync with what a client actually has. `utils/protocolDefaults.js`
   is now just static reference data used to *pre-fill* the day picker
   in Assign Plan — applying a day always writes straight to the
   client's real `Regimen` (window + meals + habits together), whether
   for one client or "apply to all". This also fixes the old bug where
   `apply-all` could push a day without any meals/habits attached.
5. **Checklist**: meals and habit milestones are shown in separate
   sections. Coach-assigned items are **tick/untick only** — no edit,
   no delete, enforced server-side (`PATCH`/`DELETE` return 403 on
   non-custom items). Items a client adds themselves are fully
   editable/deletable but are excluded from `completionPercent`, streaks
   and points (`utils/helpers.js` → `recalcCompletion`).
6. **Client roster UI**: rebuilt as clean cards (name, status, day,
   today's adherence, points) with a single "⋯" menu per client instead
   of five inline buttons.
7. **Fasting Tracker plan**: a new `mode: 'tracker'` on `Plan`, and a
   `TrackerSession` table for simple start/stop fasting logs. Tracker
   clients get **no coach surface at all** — no regimen, no alerts, no
   assigned plan — only payments, chat and contact, since they still
   need to reach the coach and pay. The coach creates Tracker plans
   from the same Plans & pricing screen as the coached plans; both show
   up together on the landing page and the client's payment page.

## 1. Create the MySQL database (Hostinger hPanel)

1. hPanel → **Databases → MySQL Databases** → create a database and a
   user, and note the host (usually `localhost` on shared hosting),
   database name, username and password.
2. Copy `.env.example` to `.env` and fill in `DB_HOST`, `DB_NAME`,
   `DB_USER`, `DB_PASSWORD`, and a random `JWT_SECRET`.

## 2. Run locally (optional, before deploying)

```bash
npm install
cp .env.example .env      # fill in your MySQL details
npm run migrate           # creates all tables
npm run seed:admin        # creates your first coach login from .env values
npm run dev                # http://localhost:5000 — serves API + frontend together
```

## 3. Deploy to Hostinger

1. hPanel → **Advanced → Node.js** → create a new Node.js app, pointing
   its application root at this folder, with `server.js` as the entry
   file and Node ≥18.
2. Set the same environment variables from `.env.example` in the Node
   app's **Environment variables** panel (Hostinger's Node.js manager
   reads these instead of a `.env` file in production — keep `.env`
   locally only).
3. Upload this folder (or connect the Git repo) and run, from
   Hostinger's Node.js terminal:
   ```bash
   npm install
   npm run migrate
   npm run seed:admin
   ```
4. Start/restart the app from hPanel. It listens on the `PORT` Hostinger
   assigns automatically — don't hardcode a different port.
5. Visit your domain: the landing page, client and admin dashboards are
   all served from the same app, no separate static site or backend URL
   to configure.

## 4. First login

- **Coach/Admin**: the email/password from `ADMIN_EMAIL`/`ADMIN_PASSWORD`
  in `.env`, after running `npm run seed:admin`.
- **Clients**: sign up from the landing page, choose a plan (coached or
  Fasting Tracker), submit their UPI UTR, and wait for coach approval —
  Admin console → Payment approvals.

## Never insert users directly into MySQL

Passwords are stored as bcrypt hashes. A row added straight into the
database with a plain-text password will never log in — bcrypt has
nothing valid to compare against. Run `npm run check:passwords` to find
any account like this; fix it from Admin console → roster → Reset
password.

## Notes

- Payment screenshots are still stored as base64 (`Payment.screenshotBase64`,
  a `LONGTEXT` column) — fine for a small cohort, but move to object
  storage if this grows.
- `utils/protocolDefaults.js` holds the original 55-day plan as
  reference data only. Edit it if the coach's baseline protocol
  changes; it never gets written back to.
- The referral reward (₹500) still fires on a client's first approved
  payment, tracker or coached.
