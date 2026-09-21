# Upgrade notes — Fasting Tracker + fixes

## Files in this drop

```
models/index.js                 UPDATED  new tracker tables, extra TrackerSession columns
routes/tracker.js               NEW      the whole Fasting Tracker API  (/api/tracker/*)
routes/admin.js                 UPDATED  assigned-day lookup, custom days, BMI in client detail
routes/client.js                UPDATED  (from the previous drop) derived scoring
server.js                       UPDATED  mounts /api/tracker
utils/fastingContent.js         NEW      schedules, stages, education, tips, tasks, safety text
utils/scoring.js                NEW      points/streak logic (previous drop)
utils/rescoreAll.js             NEW      one-off backfill (previous drop)
utils/migrate.js                UPDATED  now uses sync({ alter: true }) — see below
public/client/tracker.html      NEW      the tracker section, with its own sub-pages
public/js/tracker.js            NEW      tracker frontend
public/css/tracker.css          NEW      tracker styles
public/client/dashboard.html    UPDATED  BMI card, tracker link, dead tracker view removed
public/js/client.js             UPDATED  BMI save fix, progress bar, dead tracker code removed
public/admin/dashboard.html     UPDATED  assign-plan status strip, client detail modal
public/js/admin.js              UPDATED  assign-plan prefill, custom days, client detail
public/css/dashboard.css        UPDATED  admin additions + polish pass
```

No new npm dependencies.

## Deploy steps

1. Upload the files over the existing ones (same paths).
2. **Back up the database**, then run once from Hostinger's Node terminal:
   ```bash
   npm run migrate        # now sync({ alter: true }) — see the warning below
   node utils/rescoreAll.js
   ```
3. Restart the app from hPanel.

### Why migrate changed

`sequelize.sync()` only creates tables that are **missing**. It will never
add a column to a table that already exists — so the new `scheduleKey`,
`eatingStartedAt`, `localDate` and other columns on `TrackerSessions`
would silently not appear, and the tracker would fail at runtime.
`npm run migrate` now runs `sync({ alter: true })`, which compares each
model to the live table and adds what's missing.

`alter: true` can drop or retype a column if a model and a table disagree.
Take a phpMyAdmin export first. The boot-time `sequelize.sync()` in
`server.js` is deliberately left as plain sync — alter on every restart is
not something you want in production.

## What's in the tracker

Separate pages inside `/client/tracker.html`: Today, Current fast,
Schedule, History, Statistics, Calendar, Meals & macros, Water, Fasting
stages, Education, Daily tasks, Settings.

Covers: schedule selection (12:12 → 23:1 and custom) with calculated end
times, start-fast confirmation with editable start time, single-active-fast
enforcement, live ring timer with stage, progress percentages, end-fast
confirmation recording completed vs ended-early, eating-window countdown,
history, statistics across week/month/all-time, weekly bar chart, calendar
with per-day detail, streaks that rest days don't break, daily goal,
nutrition goals and macro bars, meal logging with quick-add buttons, water
tracking with ml/oz/L units and history, rest days, weekly flexible
schedule, education articles, rotating dismissible tips, daily tasks,
empty states, and safety information.

## Two things the spec asks for that this cannot fully do

**Reminders.** Section 21 and 22 reminders are implemented as settings plus
in-app notifications that fire while FastCoach is open in a browser tab
(using the browser Notification API where the user grants permission).
Waking a closed phone needs Web Push: a service worker, VAPID keys, and a
background job on the server to send at the scheduled time. Hostinger's
Node app can host that, but it's a separate piece of work and I'd rather
flag it than pretend the current build does it.

**Nutrition database.** Meals are logged with the numbers the client types
in. There is no food database behind it — section 16 says not to use fake
calorie values, so nothing is auto-filled. Wiring in a food API later would
slot into `POST /api/tracker/meals` without changing the UI.

## Fixes in this drop

- **BMI "Save this" did nothing visible.** Two causes: `loadHistoryPage()`
  blanked the result panel immediately after saving, and the stored session
  user was never refreshed, so height/age looked unsaved on return. Both
  fixed; the confirmation now says what was saved, and errors surface
  instead of failing silently.
- **Coach couldn't see BMI.** The roster "⋯" menu has a new
  **View details & BMI** entry showing height, age, gender, current weight,
  change since start, BMI with its band, healthy weight range, recent
  weight log and assigned days.
- **Assign plan opened blank.** It now loads the client's actual saved
  regimen for the selected day — window, meals and habits — and says
  "Currently assigned, last saved <time>". A strip of chips shows every day
  already assigned; clicking one jumps to it. The 55-day default is only
  used when a day has nothing assigned, and there's a button to pull the
  default in deliberately.
- **Custom days.** The day field accepts any number ≥ 1. Assigning a day
  past the client's programme length extends `challengeLengthDays`
  automatically, for that client or for the whole cohort on apply-all.
  Days with no 55-day reference are labelled as custom and start blank.
