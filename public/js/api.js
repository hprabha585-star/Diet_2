// Same-origin now — Hostinger runs one Node process that serves this
// static frontend and the /api routes together, so there's no separate
// API base URL or CORS config to keep in sync.
const API_BASE = '/api';

function getToken() { return localStorage.getItem('fc_token'); }
function setSession(token, user) {
  localStorage.setItem('fc_token', token);
  localStorage.setItem('fc_user', JSON.stringify(user));
}
function getUser() {
  try { return JSON.parse(localStorage.getItem('fc_user')); } catch { return null; }
}
function clearSession() {
  localStorage.removeItem('fc_token');
  localStorage.removeItem('fc_user');
}

async function apiRequest(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    // Every backend route replies with { error, detail } on failure —
    // `detail` carries the real cause (a DB column that doesn't exist
    // yet, a validation message, etc.). Dropping it left every failure
    // in the app looking like a bare, undiagnosable "Could not X".
    const message = data.detail ? `${data.error || 'Request failed'}: ${data.detail}` : (data.error || `Request failed (${res.status})`);
    throw new Error(message);
  }
  return data;
}

// The Android app's WebView points at app-login.html (login-only, no
// marketing page) instead of index.html (the full marketing site).
// app-login.html sets this flag on load so logout / a session-expiry
// redirect sends an app install back to its own login screen instead of
// bouncing it to the marketing page it never saw in the first place.
function entryPage() {
  return localStorage.getItem('fc_app_mode') === '1' ? '/app-login.html' : '/index.html';
}

function requireRoleOrRedirect(role) {
  const user = getUser();
  const token = getToken();
  if (!token || !user || user.role !== role) {
    window.location.href = entryPage();
    return null;
  }
  return user;
}

function logout() {
  const dest = entryPage();
  clearSession();
  window.location.href = dest;
}

// A failed section used to stay stuck on its "Loading…" placeholder
// forever — the fetch failed, the error was logged to the console, and
// nothing told the person looking at the screen. These two render a
// visible "couldn't load, try again" message with a working Retry
// button instead, so a slow/failed request is obvious and recoverable
// rather than looking like the page is still thinking.
function errorBlock(message, retryFnCall) {
  return `<p class="hint error-text">Couldn't load ${esc(message)}.
    <button class="btn-ghost btn-sm" onclick="${retryFnCall}">Retry</button></p>`;
}
function errorRow(colspan, message, retryFnCall) {
  return `<tr><td colspan="${colspan}" class="muted">Couldn't load ${esc(message)}.
    <button class="btn-ghost btn-sm" onclick="${retryFnCall}">Retry</button></td></tr>`;
}

// Runs promise-returning functions with only `size` running at once.
// A dashboard with 10+ independent panels firing all at once looks fast
// in principle, but shared hosting usually caps MySQL at a handful of
// simultaneous connections — fire them all together and the extras just
// sit queued waiting for a free one, which looks exactly like "stuck
// loading" even though nothing is actually broken. Small batches keep
// most of the speed win without overrunning that limit.
async function runInBatches(fns, size = 4) {
  for (let i = 0; i < fns.length; i += size) {
    await Promise.all(fns.slice(i, i + size).map(fn => fn()));
  }
}

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function jsStr(str) { return String(str == null ? '' : str).replace(/'/g, "\\'"); }

/* ------------------------------------------------------------------ */
/* Local-time fasting/eating window math.                              */
/* The server only ever sends startHour/endHour/isFullDayFast — every  */
/* client computes state and the countdown in ITS OWN browser clock,   */
/* so the number is correct no matter what timezone the server runs    */
/* in or where the client is.                                          */
/* ------------------------------------------------------------------ */
function computeFastingState(window, pauseActive, pauseReason) {
  if (!window) return null;
  if (pauseActive) {
    return { state: 'paused', countdown: '--:--:--', secondsRemaining: 0, reason: pauseReason || '' };
  }
  const now = new Date();
  const hours = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  const { startHour, endHour, isFullDayFast } = window;

  if (isFullDayFast) {
    let diff = startHour - hours;
    if (diff <= 0) diff += 24;
    return { state: 'fasting', secondsRemaining: Math.round(diff * 3600) };
  }

  const inEatingWindow = startHour <= endHour
    ? hours >= startHour && hours < endHour
    : hours >= startHour || hours < endHour;

  const targetHour = inEatingWindow ? endHour : startHour;
  let diff = targetHour - hours;
  if (diff < 0) diff += 24;

  return { state: inEatingWindow ? 'eating' : 'fasting', secondsRemaining: Math.round(diff * 3600) };
}

// 24h float hour (e.g. 20.5) -> "8:30 PM", in the browser's own reading —
// this is a label, not a timezone conversion, so it just formats the
// number the way a clock face would show it.
function fmtHour12(hourFloat) {
  const t = ((hourFloat % 24) + 24) % 24;
  let hh = Math.floor(t);
  const mm = Math.round((t - hh) * 60);
  const period = hh >= 12 ? 'PM' : 'AM';
  let h12 = hh % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}

// Shared across every page (sign-in, client dashboard, tracker, admin):
// pulls the coach's site name + logo and applies them wherever ".brand"
// or ".nav-logo" appears. Public endpoint — works before login too, so
// the sign-in page itself is branded. Cosmetic only: never blocks or
// breaks the page if it fails.
async function applyBranding() {
  try {
    const s = await apiRequest('/site-settings', { auth: false });
    if (!s) return;
    const name = esc(s.siteName || 'FastCoach');
    document.title = document.title.replace(/FastCoach/g, s.siteName || 'FastCoach');
    document.querySelectorAll('.nav-logo, .brand').forEach(el => {
      el.innerHTML = s.logoBase64
        ? `<img src="${s.logoBase64}" class="site-logo-img" alt="${name}">${name}`
        : name;
    });
  } catch (err) { /* branding is cosmetic — never block the page over it */ }
}

function fmtCountdown(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
