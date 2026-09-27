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
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function requireRoleOrRedirect(role) {
  const user = getUser();
  const token = getToken();
  if (!token || !user || user.role !== role) {
    window.location.href = '/index.html';
    return null;
  }
  return user;
}

function logout() {
  clearSession();
  window.location.href = '/index.html';
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

function fmtCountdown(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
