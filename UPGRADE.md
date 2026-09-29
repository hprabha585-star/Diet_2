# Upgrade notes — Today page, profile, protocol guide, admin flexibility

## Deploy

1. Back up the database.
2. Upload all files (same paths as before).
3. Run `npm run migrate` — the `focus` column on Regimen changed from
   VARCHAR to TEXT (so day-info notes stop truncating), and Settings
   gained a `defaultDayTemplate` JSON column. Both need `sync({ alter: true })`,
   which `npm run migrate` already runs.
4. Restart the app.

No new tables, no data loss — just column changes on tables that exist.

## What changed, and why

**Today header** — replaced the static "Today" title with the actual
date + weekday (e.g. "Saturday, 26 Sep"), computed in the browser so it's
always the viewer's own local date.

**Profile popup** — the name in the top-right is now a button. Clicking
it opens a popup with name, age, height, current weight and BMI, pulled
from a new `/api/client/profile-summary` endpoint (uses the *latest*
logged weight for BMI — the old `/history` endpoint was quietly using the
one-time starting weight instead, so BMI could look stale after logging a
new weight; that's fixed too).

**Alerts moved beside the profile** — it's now a bell icon with a badge
in the topbar, next to the profile button, instead of a full sidebar
entry. Clicking it still opens the same Alerts panel as before.

**Fasting/eating windows** — each panel now shows the *exact* clock time
the window starts and ends (e.g. "Starts 9:00 PM · Ends 1:00 PM"), and
the big timer counts **up** (elapsed time) for whichever window is
currently active, with the *other* panel showing a countdown to when it
starts. Both are computed from the same numbers the server already sends
(`startHour`/`endHour`), just read differently — no new API calls.

**Weight progress** — each entry in History & weight now shows a small
up/down badge comparing it to the entry logged before it, so day-to-day
change is visible at a glance instead of just a bare list of numbers.

**BMI save merged into the weight Save button** — clicking the plain
"Save" under "Log today's weight" now also saves height/age/gender (if
those fields are filled in below) and recalculates the BMI card
automatically, in the same click. The BMI card's own "Calculate"/"Save
this" still work independently if someone fills that card first.

**Program guide** — a new client-facing page (sidebar: "Program guide")
listing every day of the programme with whatever text the coach has
written for it. On the admin side, roster -> "..." -> Program guide opens
a lightweight, day-by-day textarea list — separate from the full Assign
Plan modal — so the coach can write "day 12: cheat meal, keep water up"
kind of notes without touching meals or the eating window. Each box saves
on blur (click away), no separate Save button needed.

**Default day template** — in Assign Plan, "Save this as my default day"
stores the current window + meals + habits as a reusable template; "Load
my default day" pulls it back into the form for any day, any client.
This is what makes assigning a normal, repeat-of-yesterday day fast
instead of retyping four meals every time.

**Assign a range of days** — Assign Plan now has a "Days to allocate"
field. Set day to 6 and days to 6, and the same window/meals/habits get
written to days 6-11 in one Apply — for one client or, combined with
"Apply to ALL active clients", the whole cohort at once. Assigning past
the end of someone's programme length extends it automatically, same as
the existing custom-day behaviour.

## Files touched

```
models/index.js                 Regimen.focus -> TEXT, Settings.defaultDayTemplate (JSON)
routes/admin.js                 default-day-template, program-guide, focus quick-edit,
                                 range assignment (day + days) on assign-plan & apply-all
routes/client.js                profile-summary, program-guide, /history BMI fix
public/js/api.js                fmtHour12() helper
public/js/client.js             showView/topbar rewrite, tick() rewrite, profile modal,
                                 program guide, weight deltas, weight+BMI save merge
public/js/admin.js              range assignment, default-day save/load, program guide editor
public/client/dashboard.html    topbar, fasting panels, profile modal, program guide view
public/admin/dashboard.html     range field, default-day buttons, program guide modal
public/css/dashboard.css        styles for all of the above
```

Nothing in the Fasting Tracker (tracker.html / tracker.js) or the coach's
payments/leaderboard/chat panels was touched.

## Hotfix — 2026-09-27

Three separate problems, from the "Could not save default day" error and
the missing Program guide report:

**1. `routes/auth.js` was missing from the zip entirely** — a packaging
mistake on my end from an earlier drop, not anything wrong with your
server. This caused `Cannot find module './routes/auth'` on every boot,
which is the 503 crash-loop from before. Fixed — the file is back in
this zip.

**2. "Could not save default day" (500) is almost certainly `npm run
migrate` not having been re-run** after the previous drop. That drop
changed `Regimen.focus` from VARCHAR to TEXT and added
`Settings.defaultDayTemplate` (JSON) — both need the migration to exist
in the database, or any write to them fails. **Run `node utils/migrate.js`
again now**, then retry "Save this as my default day". While you're in
there, also check `yourdomain.com/api/health` — `"tablesCreated": true`
with no `tableError` confirms the schema is in sync.

Separately, `apiRequest()` was silently dropping the `detail` field every
backend error already included — so a real database error like "Unknown
column defaultDayTemplate" was showing up as the bare, undiagnosable
"Could not save default day" with no way to tell what actually broke.
Fixed in `public/js/api.js` — every error anywhere in the app now shows
its real cause, not just the generic label.

**3. Assigning day 8 silently applied to 8 days (8 through 15) — no
confirmation.** The "Days to allocate" field defaults to 1 and is never
touched by anything else in the code, so this was very likely 8 typed
into that box by mistake — but the real bug is that applying to a single
client had **no confirmation at all**, even for an 8-day range (only
"Apply to ALL" asked first). Fixed two ways:
- A live preview line now shows exactly what "Apply" will do —
  "Applying to day 8 only" vs "Applying to 8 days — day 8 through day 15"
  — updating as you type, before you click anything.
- Applying more than one day to a single client now asks for
  confirmation first, same as it already did for "Apply to ALL".

**There's no version history**, so whatever was previously on days 9-15
for that client is gone if it differed from day 8's plan — you'll need
to re-enter the correct content for those days by hand if so. Sorry for
the trouble; the missing confirmation above is what should have caught
this before it happened.

**4. Program guide wasn't visible enough** — it existed (roster -> "..."
menu) but that's easy to miss. It's now also a full sidebar item:
**Program guide**, which lists every coached client with a button to
open their day-by-day editor directly, no dropdown-hunting required.

Same deploy steps as before: back up, upload, `npm run migrate`, restart.

## Update — 2026-09-27 (evening)

**No schema changes this time** — no `npm run migrate` needed, just
upload and restart.

**1. Referral link, not just a code.** Refer & earn now shows a full
link (`yourdomain.com/index.html?ref=CODE`) with Copy and, on devices
that support it, a native Share button. The landing page reads `?ref=`
from the URL, pre-fills it into the referral field, and jumps straight
to Create account — so whoever clicks the link doesn't have to find or
type the code themselves.

**2. 55-day protocol document loaded into Program Guide.** The uploaded
`55-Day_Step-by-Step_Fasting_Protocol.docx` turned out to be phase-level
goals for the six phases (matches what was already transcribed into
`utils/protocolDefaults.js` as day-by-day data) plus the same safety
notes already in the app — so rather than duplicate content, its phase
goals were added there (`PHASE_GOALS`) and combined with each day's
existing focus text. In the Program guide editor (roster -> "..." ->
Program guide, or the new sidebar Program guide page), there's now a
**"Fill from 55-day protocol"** button: it writes that combined text into
every day that doesn't have anything written yet, leaving anything the
coach has already customized alone — a checkbox lets you overwrite
everything instead if you want a clean reset. Meals, habits and the
eating window for already-assigned days are never touched by this, only
the guide text.

**3. Move a client's current day directly.** Assign Plan now shows
"Client is currently on day X of Y" with its own "Move client to this
day" control, separate from the Day field used to edit a day's plan
content. Moving a client from day 7 to day 10 no longer means editing
what day 7's plan says — it changes what their Today page shows,
immediately, without touching any assigned plan. (Under the hood this
recalculates `challengeStartDate` backwards from the requested day, in
the coach's own local date — so it isn't at the mercy of server
timezone, same reasoning as the fasting-window date logic elsewhere.)

Files touched: `utils/protocolDefaults.js` (PHASE_GOALS, guideTextFor),
`routes/admin.js` (set-day, program-guide/seed-defaults), `public/js/admin.js`,
`public/admin/dashboard.html`, `public/js/client.js`, `public/index.html`,
`public/css/dashboard.css`.

## Update — 2026-09-28

**No schema changes, no migrate needed.** Upload and restart.

**Second admin account, with phpMyAdmin approval.** The login page's
Coach/Admin panel had exactly one path — "First time? Create admin
account" — which is correct for the *first* admin, but self-disables the
moment one exists (as it should). The backend already had a second
route, `POST /api/auth/request-admin`, built for this exact case (create
a `pending_approval` account you then flip to `active` in phpMyAdmin),
but it was never connected to any button — the README described it, the
code just didn't have it wired up.

Fixed: a second link — "Need another admin account? Request one" — now
sits under the first one whenever Coach/Admin is selected, opens its own
modal, and on success tells you exactly what to do next (hPanel →
Databases → phpMyAdmin → Users table → change that row's `status` from
`pending_approval` to `active`), so the person submitting the request
doesn't need to go find the README to know what happens next.

Files touched: `public/index.html`, `README.md` (updated to describe
both paths accurately). Nothing else.
