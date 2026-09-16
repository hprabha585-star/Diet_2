# FastCoach

A coach-led fasting & diet cohort platform: an Admin/Coach assigns individualized
daily fasting windows, meals, and habit checklists; Clients execute, track streaks,
and climb a cohort leaderboard. Zero-commission direct UPI payments, manually
approved by the coach, plus a ₹500-per-referral affiliate wallet.

```
fastcoach/
├── backend/     Node.js + Express + MongoDB (Mongoose) REST API
├── frontend/    Static HTML/CSS/JS — landing page, client dashboard, admin console
└── render.yaml  Render "Blueprint" that deploys both services together
```

## 1. Set up MongoDB Atlas (free tier)

1. Create a free account at https://www.mongodb.com/cloud/atlas/register
2. Create a new **M0 (free)** cluster.
3. Under **Database Access**, create a database user with a password.
4. Under **Network Access**, add `0.0.0.0/0` (allow access from anywhere) so Render can connect.
5. Click **Connect → Drivers**, copy the connection string. It looks like:
   ```
   mongodb+srv://<user>:<password>@<cluster>.mongodb.net/fastcoach?retryWrites=true&w=majority
   ```
   Make sure you add a database name (e.g. `/fastcoach`) before the `?`.

## 2. Run locally (optional, before deploying)

```bash
cd backend
cp .env.example .env      # fill in MONGO_URI, JWT_SECRET, CLIENT_ORIGIN
npm install
npm run seed:admin        # creates your first coach login from .env values
npm run dev                # starts on http://localhost:5000
```

Then open `frontend/index.html` directly in a browser (or serve the `frontend`
folder with any static server). It talks to `http://localhost:5000/api` by
default — see `frontend/js/config.js`.

## 3. Deploy to Render

### Option A — one-click Blueprint (recommended)
1. Push this whole folder to a GitHub repo.
2. In Render, choose **New → Blueprint** and point it at the repo. Render will
   read the top-level `render.yaml` and create **two services**:
   - `fastcoach-backend` — the Node API
   - `fastcoach-frontend` — the static site
3. When prompted, set the backend's environment variables:
   - `MONGO_URI` — your Atlas connection string from step 1
   - `CLIENT_ORIGIN` — the URL Render gives your frontend, e.g.
     `https://fastcoach-frontend.onrender.com`
   - `JWT_SECRET` is auto-generated for you.
4. Once the backend is live, copy its URL (e.g.
   `https://fastcoach-backend.onrender.com`) and update
   `frontend/js/config.js`:
   ```js
   window.FASTCOACH_API_BASE = "https://fastcoach-backend.onrender.com/api";
   ```
   Commit and push — the static site redeploys automatically.
5. Run the admin seed once, either locally against the Atlas URI, or via
   Render's **Shell** tab on the backend service: `npm run seed:admin`.

### Option B — two manual services
Create a **Web Service** from the `backend/` folder (Node, `npm install`,
`npm start`) and a **Static Site** from the `frontend/` folder (no build
command, publish directory `.`). Set the same environment variables as above.

## 4. First login

- Coach/Admin: whatever email/password you set in `ADMIN_EMAIL` /
  `ADMIN_PASSWORD` before running `npm run seed:admin`.
- Clients: sign up from the landing page, choose a tier, submit a UPI UTR
  number, and wait for the coach to approve it from the **Payment approvals**
  tab in the admin console.

## API reference (backend)

All routes are prefixed with `/api`. Client and admin routes require
`Authorization: Bearer <token>` from `/auth/login` or `/auth/register`.

| Method | Route | Who | Purpose |
|---|---|---|---|
| POST | `/auth/register` | public | Create a client account |
| POST | `/auth/login` | public | Log in, returns JWT |
| GET  | `/auth/me` | any | Current user |
| POST | `/client/payments` | client | Submit UTR + optional screenshot |
| GET  | `/client/dashboard` | client | Today's plan, fasting state, checklist |
| POST | `/client/checklist` | client | Toggle a habit / log water |
| POST | `/client/weight` | client | Log today's weight |
| GET  | `/client/history` | client | Weight + adherence history |
| GET  | `/client/leaderboard` | client | Cohort leaderboard |
| GET  | `/client/referral` | client | Referral code, wallet, payouts |
| POST | `/client/payout-request` | client | Request a UPI payout |
| GET  | `/admin/clients` | admin | Full roster with live fasting state |
| GET  | `/admin/clients/:id` | admin | One client's full history |
| POST | `/admin/clients/:id/activate` | admin | Manually activate a client |
| POST | `/admin/clients/:id/regimen` | admin | Assign/update a day's plan |
| GET  | `/admin/payments?status=` | admin | Payment queue |
| POST | `/admin/payments/:id/approve` | admin | Approve payment → activates client |
| POST | `/admin/payments/:id/reject` | admin | Reject payment |
| GET  | `/admin/leaderboard` | admin | Cohort leaderboard |
| GET  | `/admin/payouts?status=` | admin | Payout queue |
| POST | `/admin/payouts/:id/approve` | admin | Mark payout as paid |
| POST | `/admin/payouts/:id/reject` | admin | Reject payout |

## Never create users directly in MongoDB

Client and coach passwords are stored as bcrypt hashes. If you add a user
document straight into the Atlas UI with a plain-text password, login will
**always fail** for that account, even with the "right" password — bcrypt
has nothing valid to compare against.

Instead:
- **Clients** sign up themselves from the landing page, or the coach adds
  them from **Admin console → Client roster → + Add client** (hashes the
  password correctly and can activate them immediately, skipping payment
  approval if you want).
- **Locked-out client?** Admin console → roster row → **Reset password**.
- Suspect some accounts were added by hand already? Run
  `npm run check:passwords` from the `backend` folder — it lists any user
  whose password isn't a valid bcrypt hash so you know exactly who to fix
  via **Reset password**.

## Admin vs. client login

The sign-in form on the landing page now asks which kind of account you're
using (Client vs. Coach/Admin) before checking credentials. If the email
you enter belongs to the other role, you'll get a clear message telling you
to switch tabs rather than a confusing "invalid credentials" error.

## Notes & next steps

- Payment screenshots are stored as base64 directly on the `Payment` document
  for simplicity (capped by the 6MB JSON body limit in `server.js`). For
  production scale, swap this for object storage (e.g. Cloudinary or S3) and
  store just the URL.
- The fasting-state calculation in `utils/helpers.js` uses the server's clock
  and the hours in `fastingWindow`. If your coach and clients span multiple
  timezones, store an explicit timezone per user and adjust accordingly.
- The referral reward (₹500) fires on a client's **first** approved payment.
- Streak/points logic awards +100 points and +1 streak the first time a day's
  checklist completion crosses 80% — tune the threshold in
  `backend/routes/client.js`.

---

## What's new in this update

### Client dashboard
- **Sidebar navigation** — collapsible on mobile (hamburger in the top bar), with a
  new **55-day protocol** page and the current challenge day pinned at the bottom.
- **Points card replaced by a bar chart** — the "Today" page now shows a 14-day
  adherence chart directly above the checklist, with a toggle to view water
  intake instead. Points still accrue in the background and drive the leaderboard.
- **Editable checklist** — every item has Edit and Delete, and clients can add
  their own habits with **+ Add habit**. Coach-assigned items and client-added
  items are distinguished in the UI.
- **Editable water log** — each tap is stored as its own entry with a timestamp;
  entries can be edited or deleted, and a custom amount can be logged.
- **BMI calculator** on History & weight — height and goal weight are saved to the
  profile (visible to the coach), and each weight entry can be edited or deleted.
- **Pause fasting** — for illness, dizziness, medical advice, medication or travel.
  While paused the challenge day is frozen, the streak is protected, and the coach
  sees the reason on the roster. Resume from the banner or the fasting card.

### Coach console
- **55-day protocol tab** — the full step-by-step protocol (six phases, from a
  12-hour baseline through 24h/36h/48h fasts to a 16/8 exit), filterable by phase.
  Every day is editable: type, eating window, full-day-fast flag, focus notes and
  water target. "Reset to defaults" restores the original document.
- **Apply protocol day** — push a protocol day onto one client, or onto every
  active client at once from the day editor.
- **Pause / resume** a client's fasting from the roster, and see BMI per client.

### New backend endpoints

| Method | Route | Who | Purpose |
|---|---|---|---|
| POST | `/client/checklist/items` | client | Add a custom habit |
| PATCH | `/client/checklist/items/:key` | client | Rename or tick an item |
| DELETE | `/client/checklist/items/:key` | client | Remove an item |
| POST | `/client/water` | client | Log a water entry |
| PATCH | `/client/water/:entryId` | client | Edit a water entry |
| DELETE | `/client/water/:entryId` | client | Delete a water entry |
| PATCH | `/client/weight/:logId` | client | Edit a weight entry |
| DELETE | `/client/weight/:logId` | client | Delete a weight entry |
| POST | `/client/profile` | client | Save height / goal weight (BMI) |
| POST | `/client/fasting/pause` | client | Pause fasting with a reason |
| POST | `/client/fasting/resume` | client | Resume and unfreeze the clock |
| GET | `/client/protocol` | client | Read-only 55-day protocol |
| GET | `/admin/protocol` | admin | Full protocol |
| POST | `/admin/protocol/seed` | admin | Load / reset defaults |
| PUT | `/admin/protocol/:day` | admin | Edit one protocol day |
| DELETE | `/admin/protocol/:day` | admin | Remove a protocol day |
| POST | `/admin/protocol/apply-all` | admin | Push a day to all active clients |
| POST | `/admin/clients/:id/apply-protocol` | admin | Push a day to one client |
| POST | `/admin/clients/:id/pause` | admin | Pause / resume on a client's behalf |

### One extra setup step

After deploying, load the protocol into MongoDB once — either from the admin
console (**55-day protocol → Load defaults**) or from a shell:

```bash
cd backend
npm run seed:protocol          # insert missing days only
npm run seed:protocol -- --force   # overwrite coach edits with the defaults
```

Existing clients keep their data. Weight entries logged before this update can't
be edited (they were stored without an id) — new entries can.

---

## Update 2 — plans, gating, alerts, chat and contact

**BMI now uses age and gender instead of a goal weight.** The result panel shows
the BMI, the band it falls in, and the healthy weight range for that height
(BMI 18.5–24.9) with how far above or below it the person currently is. Age and
gender don't change the number — they change the reading, so under-18, over-65,
and male/female body-composition notes appear alongside it. Logging a weight
refreshes the BMI immediately.

**Fasting and eating windows are now two separate panels** showing duration and
timeline for each, with the live countdown inside whichever one is active.

**Nothing is visible to a client until the coach approves their payment.** Before
that, only Payment (plus Contact us and Message coach, so they can reach you) is
reachable, and the API refuses the other routes rather than relying on the UI.
The payment page shows the status of their last submission.

**Plans are coach-editable.** Admin console → Plans & pricing: name, price,
duration, tagline and feature list. Clients pick from these on their payment
page and the landing page's pricing section follows automatically. The original
Standard/VIP tiers are seeded the first time the page loads.

**Meals and habits now reach the checklist.** Previously a checklist created
before the coach assigned the day stayed empty forever. Today's checklist is now
re-synced against the assigned plan on every load: new meals and habits appear,
removed ones go, ticks are preserved, and the client's own habits are untouched.
Duplicate meal types (two snacks) no longer share a key and tick together.

**Alerts.** Admin console → Send alerts: to one client or the whole cohort, at
info/important/urgent priority. Clients see them on an Alerts page with an unread
badge in the sidebar.

**Chat.** Admin console → Messages: a thread per client with unread counts,
polling every 15 seconds. Clients get "Message coach" with the same thread.

**Contact us.** Admin console → Contact details: coach name, phone, WhatsApp,
email, UPI ID, address, support hours and a free-text note. Clients see them on a
Contact us page with tap-to-call and a WhatsApp button.

**Referrals in the admin console.** A Referral overview page:each client's code, who
referred them, who they've referred, wallet balance, amount paid out, and a manual
wallet adjustment for fixing mistakes.

**Mobile.** 16px form inputs (no iOS zoom-on-focus), bottom-sheet modals, stacked
window panels and BMI fields, larger tap targets, scrollable tables, and a
condensed two-column stat grid on small phones.
