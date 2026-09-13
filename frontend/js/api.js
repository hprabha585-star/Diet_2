const API_BASE = window.FASTCOACH_API_BASE;

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
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
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
