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

// Shown while the free-tier database is powered off and starting back up
// (the server asks Aiven to power it on and replies 503). Page loads (GET
// requests) wait and retry automatically for up to ~4 minutes; saves are
// never retried silently, so nothing gets submitted twice.
function showDbWakingBanner(show) {
  let el = document.getElementById('db-waking-banner');
  if (!show) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'db-waking-banner';
    el.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:9999;' +
      'background:#16211D;color:#F2F1E9;padding:12px 18px;border-radius:8px;font:500 14px Inter,Arial,sans-serif;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:90vw;text-align:center;';
    el.textContent = 'Starting up the database — this takes a couple of minutes after a quiet period. Retrying automatically…';
    document.body.appendChild(el);
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiRequest(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  let res, data = {};
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${API_BASE}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined
    });
    data = {};
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); }
      catch {
        // The server sent a web page (or PHP source) instead of JSON — the
        // API isn't being reached. Say so plainly instead of a cryptic
        // "cannot read properties of undefined" later on.
        throw new Error(`Server problem: /api${path} returned a web page instead of data (HTTP ${res.status}). Open /api/health on this site to check.`);
      }
    }
    if (res.status === 503 && method === 'GET' && attempt < 12) {
      showDbWakingBanner(true);
      await sleep(20000);
      continue;
    }
    break;
  }
  showDbWakingBanner(false);
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
let SITE_SETTINGS = null;
async function applyBranding() {
  try {
    const s = await apiRequest('/site-settings', { auth: false });
    if (!s) return;
    SITE_SETTINGS = s;
    document.querySelectorAll('[data-site-contact]').forEach(el => { el.innerHTML = renderContactLinks(s); });
    document.querySelectorAll('[data-site-tagline]').forEach(el => {
      el.textContent = s.tagline || '';
      el.style.display = s.tagline ? '' : 'none';
    });
    document.querySelectorAll('[data-site-logo-big]').forEach(el => {
      el.innerHTML = s.logoBase64
        ? `<img src="${s.logoBase64}" alt="${esc(s.siteName || 'FastCoach')}">`
        : `<span class="brand-mark-letter">${esc((s.siteName || 'F').trim().charAt(0).toUpperCase())}</span>`;
    });
    document.querySelectorAll('[data-site-name]').forEach(el => { el.textContent = s.siteName || 'FastCoach'; });
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


/* ------------------------------------------------------------------ */
/* Public contact links (phone, WhatsApp, email, Instagram, YouTube).   */
/* Filled in by the coach under Contact details + Site settings.        */
/* ------------------------------------------------------------------ */
const CONTACT_ICONS = {
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.15l-.3-.18-3 .78.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.25-.12-1.46-.72-1.69-.8s-.39-.12-.55.12-.63.8-.78.96-.29.18-.53.06a6.7 6.7 0 0 1-3.34-2.92c-.25-.43.25-.4.72-1.34a.45.45 0 0 0-.02-.43c-.06-.12-.55-1.33-.76-1.82s-.4-.41-.55-.42h-.47a.9.9 0 0 0-.65.3 2.74 2.74 0 0 0-.86 2.04 4.76 4.76 0 0 0 1 2.53 10.9 10.9 0 0 0 4.17 3.68c1.55.67 2.16.73 2.93.61a2.5 2.5 0 0 0 1.65-1.16 2 2 0 0 0 .14-1.16c-.06-.1-.22-.16-.47-.28z"/></svg>',
  email: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2.4V17h16V7.4l-8 5.3zM5.2 7 12 11.5 18.8 7z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.3a4.7 4.7 0 1 0 0 9.4 4.7 4.7 0 0 0 0-9.4zm0 7.7a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm6-7.9a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0zM21.9 8.2a5.4 5.4 0 0 0-1.5-3.9 5.5 5.5 0 0 0-3.9-1.5C15 2.7 9 2.7 7.5 2.8a5.5 5.5 0 0 0-3.9 1.5A5.4 5.4 0 0 0 2.1 8.2C2 9.7 2 15.4 2.1 16.9a5.4 5.4 0 0 0 1.5 3.9 5.5 5.5 0 0 0 3.9 1.5c1.5.1 7.5.1 9 0a5.4 5.4 0 0 0 3.9-1.5 5.5 5.5 0 0 0 1.5-3.9c.1-1.5.1-7.2 0-8.7zm-2.3 11a3 3 0 0 1-1.7 1.7c-1.2.5-4 .4-5.9.4s-4.7.1-5.9-.4a3 3 0 0 1-1.7-1.7c-.5-1.2-.4-4-.4-5.2s-.1-4 .4-5.2a3 3 0 0 1 1.7-1.7C7.3 4.6 10.1 4.7 12 4.7s4.7-.1 5.9.4a3 3 0 0 1 1.7 1.7c.5 1.2.4 4 .4 5.2s.1 4-.4 5.2z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8zM9.7 15V9l5.8 3z"/></svg>'
};

function normalizeUrl(u) {
  u = (u || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return 'https://' + u.replace(/^\/+/, '');
}
function instagramUrl(v) {
  v = (v || '').trim();
  if (!v) return '';
  if (/instagram\.com/i.test(v)) return normalizeUrl(v);
  return 'https://instagram.com/' + v.replace(/^@/, '');
}
function youtubeUrl(v) {
  v = (v || '').trim();
  if (!v) return '';
  if (/youtube\.com|youtu\.be/i.test(v)) return normalizeUrl(v);
  return 'https://youtube.com/' + (v.startsWith('@') ? v : '@' + v);
}
function digitsOnly(v) { return (v || '').replace(/[^\d+]/g, ''); }
function whatsappUrl(v) {
  let d = (v || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d; // Indian mobile without country code
  return d ? 'https://wa.me/' + d : '';
}

/** Contact list as HTML. Only shows the items the coach actually filled in. */
function renderContactLinks(s) {
  if (!s) return '';
  const items = [];
  if (s.phone) items.push(`<a class="contact-link" href="tel:${esc(digitsOnly(s.phone))}">${CONTACT_ICONS.phone}<span>${esc(s.phone)}</span></a>`);
  if (s.whatsapp) items.push(`<a class="contact-link" href="${esc(whatsappUrl(s.whatsapp))}" target="_blank" rel="noopener">${CONTACT_ICONS.whatsapp}<span>WhatsApp</span></a>`);
  if (s.email) items.push(`<a class="contact-link" href="mailto:${esc(s.email)}">${CONTACT_ICONS.email}<span>${esc(s.email)}</span></a>`);
  if (s.instagramUrl) items.push(`<a class="contact-link" href="${esc(instagramUrl(s.instagramUrl))}" target="_blank" rel="noopener">${CONTACT_ICONS.instagram}<span>Instagram</span></a>`);
  if (s.youtubeUrl) items.push(`<a class="contact-link" href="${esc(youtubeUrl(s.youtubeUrl))}" target="_blank" rel="noopener">${CONTACT_ICONS.youtube}<span>YouTube</span></a>`);
  const extra = [s.address, s.supportHours].filter(Boolean).map(x => `<div class="contact-extra">${esc(x)}</div>`).join('');
  if (!items.length && !extra) return '';
  return `<div class="contact-links">${items.join('')}</div>${extra}`;
}
