let roster = [];
let protocolDefaults = [];
let mealPresets = [];
let plansCache = [];
let paymentTab = 'pending';
let payoutTab = 'pending';
let currentThreadClientId = null;
let chatPoll = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const user = requireRoleOrRedirect('admin');
  if (!user) return;
  document.getElementById('user-chip').textContent = user.name;
  applyBranding();

  document.querySelectorAll('.nav-link').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); showView(a.dataset.view); });
  });

  // Every section loads independently AND concurrently. Two separate
  // problems used to make the console painful: (1) these were sequential
  // `await`s with no try/catch, so one failing endpoint stopped every
  // later one from even being attempted; (2) even after that was fixed to
  // not block, they still ran one after another — ten-plus round trips
  // end to end — which is what made the console feel slow to load.
  // Firing them all at once cuts load time to roughly the slowest single
  // request instead of the sum of all of them.
  await Promise.all([
    safeLoad(loadProtocolDefaults, 'the 55-day protocol'),
    safeLoad(loadMealPresets, 'meal presets'),
    safeLoad(loadRoster, 'the client roster'),
    safeLoad(loadPlans, 'plans'),
    safeLoad(loadPayments, 'payments'),
    safeLoad(loadLeaderboard, 'the leaderboard'),
    safeLoad(loadPayouts, 'payouts'),
    safeLoad(loadReferrals, 'referrals'),
    safeLoad(loadSettings, 'settings'),
    safeLoad(loadSiteSettings, 'site settings'),
    safeLoad(loadThreads, 'messages')
  ]);
  chatPoll = setInterval(() => { if (currentThreadClientId) loadThread(currentThreadClientId, true); loadThreads(); }, 15000);
}

// Runs a loader, logging (not throwing) on failure so one broken section
// never blanks out the rest of the console.
async function safeLoad(fn, label) {
  try {
    await fn();
  } catch (err) {
    console.error(`Could not load ${label}:`, err);
  }
}

function showView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(a => a.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelector(`.nav-link[data-view="${view}"]`).classList.add('active');
  document.getElementById('topbar-title').textContent = document.querySelector(`.nav-link[data-view="${view}"] span:nth-child(2)`).textContent;
  closeSidebar();
}
function openSidebar() { document.getElementById('sidebar').classList.add('open'); document.getElementById('sidebar-scrim').classList.add('show'); }
function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebar-scrim').classList.remove('show'); }
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

/* ------------------------------------------------------------------ */
/* Roster — clean cards, one menu instead of five buttons               */
/* ------------------------------------------------------------------ */
async function loadRoster() {
  try {
    const data = await apiRequest('/admin/clients');
    roster = data.clients;
    renderRoster();
    renderProgramGuidePicker();
    populateChatClientPicker();
  } catch (err) {
    document.getElementById('roster-list').innerHTML = errorBlock('the client roster', 'loadRoster()');
    throw err;
  }
}

function renderRoster() {
  const q = (document.getElementById('roster-search').value || '').toLowerCase();
  const list = roster.filter(c => !q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
  document.getElementById('roster-list').innerHTML = list.length ? list.map(c => `
    <div class="roster-card">
      <div class="roster-main">
        <div class="roster-avatar">${esc(c.name.slice(0, 1).toUpperCase())}</div>
        <div style="min-width:0;">
          <div class="roster-name">${esc(c.name)} ${c.planMode === 'tracker' ? '<span class="badge badge-active" style="margin-left:6px;">Tracker</span>' : ''}</div>
          <div class="roster-meta">${esc(c.email)} · <span class="badge badge-${c.status === 'active' ? 'active' : c.status === 'pending_payment' ? 'pending' : 'rejected'}">${esc(c.status)}</span>${c.fastingPause.active ? ' · Paused' : ''}</div>
        </div>
      </div>
      <div class="roster-stats">
        ${c.planMode === 'protocol' ? `
          <div class="roster-stat"><div class="num">${c.day}</div><div class="lbl">Day</div></div>
          <div class="roster-stat"><div class="num">${c.completionPercent ?? 0}%</div><div class="lbl">Today</div></div>
        ` : ''}
        <div class="roster-stat"><div class="num">${c.points}</div><div class="lbl">Points</div></div>
        <div class="roster-menu" id="menu-${c.id}">
          <button class="roster-menu-btn" onclick="toggleRosterMenu(${c.id})">⋯</button>
          <div class="roster-menu-list">
            ${c.status === 'pending_payment' ? `<button onclick="activateClient(${c.id})">Activate now</button>` : ''}
            ${c.planMode === 'protocol' ? `<button onclick="openAssignPlanModal(${c.id}, '${jsStr(c.name)}', ${c.day || 1})">Assign plan</button>` : ''}
            ${c.planMode === 'protocol' ? `<button onclick="openProgramGuideModal(${c.id}, '${jsStr(c.name)}')">Program guide</button>` : ''}
            <button onclick="openAdminPauseModal(${c.id}, ${c.fastingPause.active})">${c.fastingPause.active ? 'Resume fasting' : 'Pause fasting'}</button>
            <button onclick="openClientDetail(${c.id})">View details &amp; BMI</button>
            <button onclick="openResetPasswordModal(${c.id})">Reset password</button>
          </div>
        </div>
      </div>
    </div>
  `).join('') : '<p class="hint">No clients yet.</p>';
}

/* ------------------------------------------------------------------ */
/* Program guide — client picker (the sidebar page). Only coached-      */
/* protocol clients have a day-by-day regimen to write a guide for;      */
/* Fasting Tracker clients have no coach-assigned days.                  */
/* ------------------------------------------------------------------ */
function renderProgramGuidePicker() {
  const listEl = document.getElementById('guide-client-list');
  if (!listEl) return; // view not in the DOM yet on first paint — fine, loadRoster() re-renders it
  const q = (document.getElementById('guide-client-search').value || '').toLowerCase();
  const list = roster.filter(c => c.planMode === 'protocol' && (!q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)));
  listEl.innerHTML = list.length ? list.map(c => `
    <div class="roster-card">
      <div class="roster-main">
        <div class="roster-avatar">${esc(c.name.slice(0, 1).toUpperCase())}</div>
        <div style="min-width:0;">
          <div class="roster-name">${esc(c.name)}</div>
          <div class="roster-meta">${esc(c.email)} · ${c.tier ? esc(c.tier) : 'no plan'} · day ${c.day || '—'}</div>
        </div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="openProgramGuideModal(${c.id}, '${jsStr(c.name)}')">Open program guide</button>
    </div>
  `).join('') : '<p class="hint">No coached clients yet — Fasting Tracker clients don\'t have a day-by-day guide.</p>';
}

function toggleRosterMenu(id) {
  document.querySelectorAll('.roster-menu').forEach(m => { if (m.id !== `menu-${id}`) m.classList.remove('open'); });
  document.getElementById(`menu-${id}`).classList.toggle('open');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.roster-menu')) document.querySelectorAll('.roster-menu').forEach(m => m.classList.remove('open'));
});

async function activateClient(id) {
  try { await apiRequest(`/admin/clients/${id}/activate`, { method: 'POST' }); await loadRoster(); }
  catch (err) { alert(err.message); }
}

/* ---- Add client ---- */
function openAddClientModal() {
  document.getElementById('ac-name').value = '';
  document.getElementById('ac-email').value = '';
  document.getElementById('ac-phone').value = '';
  document.getElementById('ac-password').value = '';
  document.getElementById('ac-activate').checked = false;
  document.getElementById('ac-error').style.display = 'none';
  document.getElementById('ac-tier').innerHTML = plansCache.map(p => `<option value="${p.key}">${esc(p.name)}</option>`).join('');
  openModal('add-client-modal');
}
async function submitAddClient() {
  const errEl = document.getElementById('ac-error');
  try {
    const body = {
      name: document.getElementById('ac-name').value,
      email: document.getElementById('ac-email').value,
      phone: document.getElementById('ac-phone').value,
      password: document.getElementById('ac-password').value,
      tier: document.getElementById('ac-tier').value,
      activateNow: document.getElementById('ac-activate').checked
    };
    await apiRequest('/admin/clients', { method: 'POST', body });
    closeModal('add-client-modal');
    await loadRoster();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

/* ---- Reset password ---- */
function openResetPasswordModal(id) {
  document.getElementById('rp-client-id').value = id;
  document.getElementById('rp-password').value = '';
  document.getElementById('rp-error').style.display = 'none';
  openModal('reset-pw-modal');
}
async function submitResetPassword() {
  const errEl = document.getElementById('rp-error');
  try {
    const id = document.getElementById('rp-client-id').value;
    const password = document.getElementById('rp-password').value;
    await apiRequest(`/admin/clients/${id}/reset-password`, { method: 'POST', body: { password } });
    closeModal('reset-pw-modal');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

/* ---- Pause / resume (coach-initiated) ---- */
function openAdminPauseModal(id, currentlyPaused) {
  document.getElementById('ap-client-id').value = id;
  document.getElementById('ap-currently-paused').value = currentlyPaused ? '1' : '0';
  document.getElementById('ap-reason').value = '';
  document.getElementById('ap-reason-field').style.display = currentlyPaused ? 'none' : 'block';
  openModal('admin-pause-modal');
}
async function submitAdminPause() {
  try {
    const id = document.getElementById('ap-client-id').value;
    const wasPaused = document.getElementById('ap-currently-paused').value === '1';
    const reason = document.getElementById('ap-reason').value;
    await apiRequest(`/admin/clients/${id}/pause`, { method: 'POST', body: { pause: !wasPaused, reason } });
    closeModal('admin-pause-modal');
    await loadRoster();
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Assign plan — replaces the old "55-day protocol" tab entirely.       */
/* Static defaults just pre-fill the form; applying always writes the   */
/* client's actual Regimen (meals + milestones included), so there is   */
/* no separate template that can drift out of sync with what clients    */
/* actually see.                                                        */
/* ------------------------------------------------------------------ */
async function loadProtocolDefaults() {
  try {
    const data = await apiRequest('/admin/protocol-defaults');
    protocolDefaults = data.days;
    const preset = document.getElementById('assign-day-preset');
    preset.innerHTML = '<option value="">Pick a 55-day default to pre-fill…</option>' +
      protocolDefaults.map(d => `<option value="${d.day}">Day ${d.day} — ${esc(d.label || d.phase)}</option>`).join('');
    renderProtocol55Page(data);
  } catch (err) {
    const listEl = document.getElementById('protocol55-list');
    if (listEl) listEl.innerHTML = errorBlock('the 55-day protocol', 'loadProtocolDefaults()');
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 55-day protocol — the coach's baseline document, browsable as its    */
/* own page instead of buried inside Assign Plan's day-preset dropdown  */
/* or Program guide's "Fill from 55-day protocol" button.               */
/* ------------------------------------------------------------------ */
let protocol55Cache = { days: [], phaseGoals: {}, safetyNotes: [] };

function renderProtocol55Page(data) {
  protocol55Cache = data;
  const listEl = document.getElementById('protocol55-list');
  if (!listEl) return;

  let lastPhase = null;
  listEl.innerHTML = data.days.map(d => {
    const phaseHeader = d.phase !== lastPhase ? (() => {
      lastPhase = d.phase;
      const goal = (data.phaseGoals && data.phaseGoals[d.phase]) || '';
      const phaseKey = jsStr(d.phase);
      return `<div class="protocol-phase-head">
        <div class="protocol-phase-head-row">
          <h3>${esc(d.phase)}</h3>
          <button class="btn-ghost btn-sm" onclick="editPhaseGoal('${phaseKey}')">✎ Edit goal</button>
        </div>
        <p class="hint" id="phase-goal-text-${slugify(d.phase)}">${esc(goal)}</p>
        <div class="phase-goal-edit" id="phase-goal-edit-${slugify(d.phase)}" style="display:none;">
          <textarea rows="2">${esc(goal)}</textarea>
          <div style="display:flex;gap:8px;margin-top:6px;">
            <button class="btn btn-primary btn-sm" onclick="savePhaseGoal('${phaseKey}')">Save</button>
            <button class="btn-ghost btn-sm" onclick="cancelPhaseGoal('${phaseKey}')">Cancel</button>
          </div>
        </div>
      </div>`;
    })() : '';

    const windowText = d.isFullDayFast
      ? 'Full-day fast — water and electrolytes only'
      : `Eating window ${fmtHour12(d.startHour)} – ${fmtHour12(d.endHour)} (${d.eatingHours}h eating / ${d.fastingHours}h fasting)`;

    return `${phaseHeader}
      <div class="card protocol-day-card" id="protocol-day-${d.day}">
        <div class="protocol-day-head">
          <span class="protocol-day-num">Day ${d.day}</span>
          ${d.label ? `<span class="badge badge-active">${esc(d.label)}</span>` : ''}
          <button class="btn-ghost btn-sm" style="margin-left:auto;" onclick="editProtocolDay(${d.day})">✎ Edit</button>
        </div>
        <div class="protocol-day-view">
          <div class="protocol-day-window">${esc(windowText)} · water target ${d.waterTargetMl}ml</div>
          <p class="protocol-day-focus">${esc(d.focus)}</p>
        </div>
        <div class="protocol-day-form" style="display:none;"></div>
      </div>`;
  }).join('');

  renderSafetyNotes(data.safetyNotes || []);
}

function renderSafetyNotes(notes) {
  document.getElementById('protocol55-safety').innerHTML = `
    <div class="row-between"><h3>Safety guidelines</h3>
      <button class="btn-ghost btn-sm" onclick="editSafetyNotes()">✎ Edit</button></div>
    <ul class="safety-list" id="safety-notes-view">${notes.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
    <div id="safety-notes-edit" style="display:none;">
      <textarea id="safety-notes-textarea" rows="6" placeholder="One guideline per line">${notes.map(esc).join('\n')}</textarea>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn btn-primary btn-sm" onclick="saveSafetyNotes()">Save</button>
        <button class="btn-ghost btn-sm" onclick="document.getElementById('safety-notes-view').style.display='block';document.getElementById('safety-notes-edit').style.display='none';">Cancel</button>
      </div>
    </div>`;
}

function slugify(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

/* ---- Edit a single day ---- */
function editProtocolDay(day) {
  const card = document.getElementById(`protocol-day-${day}`);
  const d = protocol55Cache.days.find(x => x.day === day);
  if (!card || !d) return;
  card.querySelector('.protocol-day-view').style.display = 'none';
  const form = card.querySelector('.protocol-day-form');
  form.style.display = 'block';
  form.innerHTML = `
    <div class="field"><label>Label (optional)</label><input type="text" id="pd-label-${day}" value="${esc(d.label || '')}"></div>
    <label class="check-line"><input type="checkbox" id="pd-fullfast-${day}" ${d.isFullDayFast ? 'checked' : ''}
      onchange="document.getElementById('pd-window-${day}').style.display = this.checked ? 'none' : 'flex';"> Full-day fast (no eating window)</label>
    <div class="custom-row" id="pd-window-${day}" style="display:${d.isFullDayFast ? 'none' : 'flex'};">
      <div class="field"><label>Eating window start (24h)</label><input type="number" id="pd-start-${day}" step="0.5" value="${d.startHour}"></div>
      <div class="field"><label>Eating window end (24h)</label><input type="number" id="pd-end-${day}" step="0.5" value="${d.endHour}"></div>
    </div>
    <div class="field"><label>Water target (ml)</label><input type="number" id="pd-water-${day}" value="${d.waterTargetMl}"></div>
    <div class="field"><label>Focus / notes for the day</label><textarea id="pd-focus-${day}" rows="3">${esc(d.focus || '')}</textarea></div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-primary btn-sm" onclick="saveProtocolDay(${day})">Save</button>
      <button class="btn-ghost btn-sm" onclick="cancelProtocolDay(${day})">Cancel</button>
    </div>`;
}
function cancelProtocolDay(day) {
  const card = document.getElementById(`protocol-day-${day}`);
  if (!card) return;
  card.querySelector('.protocol-day-view').style.display = 'block';
  card.querySelector('.protocol-day-form').style.display = 'none';
}
async function saveProtocolDay(day) {
  try {
    const isFullDayFast = document.getElementById(`pd-fullfast-${day}`).checked;
    const body = {
      label: document.getElementById(`pd-label-${day}`).value,
      isFullDayFast,
      waterTargetMl: document.getElementById(`pd-water-${day}`).value,
      focus: document.getElementById(`pd-focus-${day}`).value
    };
    if (!isFullDayFast) {
      body.startHour = document.getElementById(`pd-start-${day}`).value;
      body.endHour = document.getElementById(`pd-end-${day}`).value;
    }
    const res = await apiRequest(`/admin/protocol-defaults/${day}`, { method: 'PATCH', body });
    const idx = protocol55Cache.days.findIndex(x => x.day === day);
    if (idx > -1) protocol55Cache.days[idx] = res.day;
    renderProtocol55Page(protocol55Cache);
    // Day presets elsewhere (Assign Plan's dropdown) read this same cache.
    protocolDefaults = protocol55Cache.days;
  } catch (err) { alert(err.message); }
}

/* ---- Edit a phase goal ---- */
function editPhaseGoal(phase) {
  const key = slugify(phase);
  document.getElementById(`phase-goal-text-${key}`).style.display = 'none';
  document.getElementById(`phase-goal-edit-${key}`).style.display = 'block';
}
function cancelPhaseGoal(phase) {
  const key = slugify(phase);
  document.getElementById(`phase-goal-text-${key}`).style.display = 'block';
  document.getElementById(`phase-goal-edit-${key}`).style.display = 'none';
}
async function savePhaseGoal(phase) {
  const key = slugify(phase);
  const value = document.querySelector(`#phase-goal-edit-${key} textarea`).value;
  try {
    const phaseGoals = { ...(protocol55Cache.phaseGoals || {}), [phase]: value };
    await apiRequest('/admin/protocol-defaults/phase-info', { method: 'PUT', body: { phaseGoals } });
    protocol55Cache.phaseGoals = phaseGoals;
    renderProtocol55Page(protocol55Cache);
  } catch (err) { alert(err.message); }
}

/* ---- Edit safety notes ---- */
function editSafetyNotes() {
  document.getElementById('safety-notes-view').style.display = 'none';
  document.getElementById('safety-notes-edit').style.display = 'block';
}
async function saveSafetyNotes() {
  try {
    const notes = document.getElementById('safety-notes-textarea').value.split('\n').map(s => s.trim()).filter(Boolean);
    await apiRequest('/admin/protocol-defaults/phase-info', { method: 'PUT', body: { safetyNotes: notes } });
    protocol55Cache.safetyNotes = notes;
    renderSafetyNotes(notes);
  } catch (err) { alert(err.message); }
}

let assignedDaysCache = [];

async function openAssignPlanModal(clientId, name, suggestedDay) {
  document.getElementById('assign-client-id').value = clientId;
  document.getElementById('assign-client-name').textContent = name;
  document.getElementById('assign-day').value = suggestedDay || 1;
  document.getElementById('assign-days-count').value = 1;
  document.getElementById('assign-day-preset').value = '';
  document.getElementById('assign-error').style.display = 'none';
  openModal('assign-plan-modal');
  updateRangePreview();
  await loadAssignedDays(clientId);
  // Load whatever is ALREADY assigned for this day instead of opening a
  // blank form — that was the bug: re-opening Assign plan hid the plan
  // the coach had just saved.
  await loadAssignedDay();
}

async function loadAssignedDays(clientId) {
  try {
    const data = await apiRequest(`/admin/clients/${clientId}/assigned-days`);
    assignedDaysCache = data.days || [];
    const el = document.getElementById('assigned-days-strip');
    if (el) {
      el.innerHTML = assignedDaysCache.length
        ? `<span class="hint">Already assigned:</span>` + assignedDaysCache.map(d =>
            `<button class="day-chip ${d.day === data.currentDay ? 'current' : ''}"
                     title="${esc(d.focus || '')}"
                     onclick="jumpToDay(${d.day})">${d.day}</button>`).join('')
        : '<span class="hint">No days assigned to this client yet.</span>';
    }

    // The client's ACTUAL current day (what their Today page shows) is a
    // different thing from which day's plan you're editing in the form
    // below — this control changes that, independent of assigning content.
    const moveEl = document.getElementById('move-day-row');
    if (moveEl) {
      moveEl.innerHTML = `
        <span class="hint">Client is currently on <b>day ${data.currentDay || 0} of ${data.challengeLengthDays}</b>.</span>
        <input type="number" id="move-day-input" min="1" style="width:80px;" placeholder="Day">
        <button class="btn-outline btn-sm" onclick="moveClientToDay(${clientId})">Move client to this day</button>
      `;
    }
  } catch (err) { /* non-fatal */ }
}

async function moveClientToDay(clientId) {
  const input = document.getElementById('move-day-input');
  const day = parseInt(input.value, 10);
  if (!day || day < 1) return alert('Enter a day number of 1 or higher.');
  if (!confirm(`Move this client from their current day to day ${day}? This changes what their Today page shows right away — it does not touch any assigned plans.`)) return;
  try {
    await apiRequest(`/admin/clients/${clientId}/set-day`, {
      method: 'POST',
      body: { day, today: todayLocalDate() }
    });
    input.value = '';
    await loadAssignedDays(clientId);
    await loadRoster();
    alert(`Client moved to day ${day}.`);
  } catch (err) { alert(err.message); }
}

// The admin's own local calendar date — never derived from server time,
// same reasoning as everywhere else timezone-sensitive in this app.
function todayLocalDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function jumpToDay(day) {
  document.getElementById('assign-day').value = day;
  loadAssignedDay();
}

/**
 * Pull the client's saved plan for the day now in the day box and fill
 * the form with it. Falls back to the static 55-day default only when
 * nothing has been assigned yet — so the coach always sees the real,
 * current state first and the reference data second.
 */
async function loadAssignedDay() {
  const clientId = document.getElementById('assign-client-id').value;
  const day = parseInt(document.getElementById('assign-day').value, 10);
  const statusEl = document.getElementById('assign-status');
  if (!clientId || !day) return;

  let data = { assigned: false, regimen: null };
  try {
    data = await apiRequest(`/admin/clients/${clientId}/regimen/${day}`);
  } catch (err) { /* treat as unassigned */ }

  document.getElementById('assign-meals-rows').innerHTML = '';
  document.getElementById('assign-milestones-rows').innerHTML = '';

  if (data.assigned && data.regimen) {
    const r = data.regimen;
    document.getElementById('assign-fullfast').checked = !!r.isFullDayFast;
    document.getElementById('assign-start').value = r.startHour;
    document.getElementById('assign-end').value = r.endHour;
    document.getElementById('assign-focus').value = r.focus || '';
    document.getElementById('assign-water').value = r.waterTargetMl || 3000;
    (r.meals || []).forEach(m => addMealRow(m.type, m.name, m.calories ?? ''));
    (r.milestones || []).forEach(m => addMilestoneRow(m.label));
    if (statusEl) {
      statusEl.className = 'assign-status assigned';
      statusEl.innerHTML = `<b>Currently assigned.</b> Last saved ${new Date(r.updatedAt).toLocaleString()}.
        Edit below and apply again to overwrite, or
        <button class="btn-ghost btn-sm" onclick="loadDayDefaultsInto(${day})">load the 55-day default instead</button>.`;
    }
  } else {
    const d = protocolDefaults.find(x => x.day === day);
    if (d) {
      applyPresetObject(d);
      if (statusEl) {
        statusEl.className = 'assign-status unassigned';
        statusEl.innerHTML = `<b>Not assigned yet.</b> Pre-filled from the 55-day default for day ${day}.`;
      }
    } else {
      document.getElementById('assign-fullfast').checked = false;
      document.getElementById('assign-start').value = 9;
      document.getElementById('assign-end').value = 17;
      document.getElementById('assign-focus').value = '';
      document.getElementById('assign-water').value = 3000;
      if (statusEl) {
        statusEl.className = 'assign-status custom';
        statusEl.innerHTML = `<b>Custom day ${day}.</b> There's no 55-day default for this day —
          build it from scratch. Assigning a day beyond the client's current
          length extends their programme automatically.`;
      }
    }
  }
  document.getElementById('assign-day-preset').value =
    protocolDefaults.some(x => x.day === day) ? day : '';
  toggleAssignFullFast();
}

function loadDayDefaultsInto(day) {
  const d = protocolDefaults.find(x => x.day === day);
  if (!d) return alert('There is no 55-day default for that day.');
  document.getElementById('assign-meals-rows').innerHTML = '';
  document.getElementById('assign-milestones-rows').innerHTML = '';
  applyPresetObject(d);
  const statusEl = document.getElementById('assign-status');
  statusEl.className = 'assign-status unassigned';
  statusEl.innerHTML = `<b>Loaded the 55-day default for day ${day}.</b> Nothing is saved until you apply.`;
}

function fillDayDefaults() {
  // Day box changed — reload what that day actually holds.
  loadAssignedDay();
  updateRangePreview();
}

// Live, impossible-to-miss preview of exactly which days "Apply" will
// touch. This is what was missing when a coach typed "8" into Days to
// allocate meaning to reinforce day 8, and it silently overwrote days
// 8 through 15 instead of just day 8.
function updateRangePreview() {
  const el = document.getElementById('range-preview');
  if (!el) return;
  const day = parseInt(document.getElementById('assign-day').value, 10) || 0;
  const count = Math.max(1, parseInt(document.getElementById('assign-days-count').value, 10) || 1);
  if (!day) { el.innerHTML = 'Applying to day <b>—</b> only.'; return; }
  el.innerHTML = count <= 1
    ? `Applying to <b>day ${day} only</b>.`
    : `<span class="range-warning">Applying to <b>${count} days — day ${day} through day ${day + count - 1}</b>. Leave this at 1 to affect only day ${day}.</span>`;
}

function applyPreset() {
  const day = parseInt(document.getElementById('assign-day-preset').value, 10);
  if (!day) return;
  document.getElementById('assign-day').value = day;
  loadAssignedDay();
}

function applyPresetObject(d) {
  document.getElementById('assign-fullfast').checked = !!d.isFullDayFast;
  document.getElementById('assign-start').value = d.startHour ?? 9;
  document.getElementById('assign-end').value = d.endHour ?? 17;
  document.getElementById('assign-focus').value = d.focus || '';
  document.getElementById('assign-water').value = d.waterTargetMl || 3000;
  toggleAssignFullFast();
}

function toggleAssignFullFast() {
  document.getElementById('assign-window-fields').style.display =
    document.getElementById('assign-fullfast').checked ? 'none' : 'flex';
}

// Quick-add library: purely a convenience for the coach — picking one just
// pre-fills a normal, fully-editable meal row.
async function loadMealPresets() {
  const data = await apiRequest('/admin/meal-presets');
  mealPresets = data.presets;
  const select = document.getElementById('meal-preset-select');
  select.innerHTML = '<option value="">Quick-add a commonly used meal…</option>' +
    mealPresets.map((m, i) => `<option value="${i}">${esc(m.name)} (${m.type.replace('_', ' ')}${m.calories ? `, ${m.calories} kcal` : ''})</option>`).join('');
}
function addPresetMealRow() {
  const idx = document.getElementById('meal-preset-select').value;
  if (idx === '') return;
  const m = mealPresets[idx];
  addMealRow(m.type, m.name, m.calories);
  document.getElementById('meal-preset-select').value = '';
}

function addMealRow(type = 'breakfast', name = '', calories = '') {
  const row = document.createElement('div');
  row.className = 'meal-row';
  row.innerHTML = `
    <select class="meal-type">
      <option value="morning_detox">Morning detox</option><option value="breakfast">Breakfast</option>
      <option value="lunch">Lunch</option><option value="snack">Snack</option><option value="dinner">Dinner</option>
    </select>
    <input type="text" class="meal-name" placeholder="Meal name" value="${esc(name)}">
    <input type="number" class="meal-cal" placeholder="kcal" value="${esc(calories)}">
    <button class="row-remove" onclick="this.closest('.meal-row').remove()">×</button>`;
  row.querySelector('.meal-type').value = type;
  document.getElementById('assign-meals-rows').appendChild(row);
}
function addMilestoneRow(label = '') {
  const row = document.createElement('div');
  row.className = 'milestone-row';
  row.innerHTML = `<input type="text" class="milestone-label" placeholder="Habit — e.g. Hit protein target" value="${esc(label)}">
    <button class="row-remove" onclick="this.closest('.milestone-row').remove()">×</button>`;
  document.getElementById('assign-milestones-rows').appendChild(row);
}

async function submitAssignPlan(applyAll) {
  const errEl = document.getElementById('assign-error');
  errEl.style.display = 'none';
  try {
    const isFullDayFast = document.getElementById('assign-fullfast').checked;
    const day = parseInt(document.getElementById('assign-day').value, 10);
    if (!day || day < 1) throw new Error('Enter a day number of 1 or higher.');
    const days = Math.max(1, parseInt(document.getElementById('assign-days-count').value, 10) || 1);

    const meals = [...document.querySelectorAll('#assign-meals-rows .meal-row')].map(r => ({
      type: r.querySelector('.meal-type').value,
      name: r.querySelector('.meal-name').value,
      calories: parseInt(r.querySelector('.meal-cal').value, 10) || undefined
    })).filter(m => m.name);
    const milestones = [...document.querySelectorAll('#assign-milestones-rows .milestone-row')].map(r => ({
      itemKey: `habit_${Math.random().toString(36).slice(2, 8)}`,
      label: r.querySelector('.milestone-label').value
    })).filter(m => m.label);

    const body = {
      day, days,
      isFullDayFast,
      startHour: parseFloat(document.getElementById('assign-start').value),
      endHour: parseFloat(document.getElementById('assign-end').value),
      protocolType: isFullDayFast ? 'fast_24' : 'eating_window',
      focus: document.getElementById('assign-focus').value,
      waterTargetMl: parseInt(document.getElementById('assign-water').value, 10) || 3000,
      meals, milestones
    };

    const rangeLabel = days > 1 ? `days ${day}–${day + days - 1}` : `day ${day}`;

    if (applyAll) {
      if (!confirm(`Apply ${rangeLabel} to every active coached client? This overwrites their plan for ${days > 1 ? 'those days' : 'that day'}.`)) return;
      const res = await apiRequest('/admin/assign-plan/apply-all', { method: 'POST', body });
      alert(`Applied ${rangeLabel} to ${res.applied} client(s).`);
    } else {
      // A single confirmation, but only when it can actually do damage:
      // more than one day means it overwrites whatever was already
      // assigned across the whole range, not just the day in the "Day"
      // box. This step was missing — the exact gap that let a coach's
      // "8" in Days to allocate silently overwrite 8 days instead of 1.
      if (days > 1 && !confirm(`This overwrites this client's plan for ${rangeLabel} (${days} days), not just day ${day}. Continue?`)) return;
      const clientId = document.getElementById('assign-client-id').value;
      const res = await apiRequest(`/admin/clients/${clientId}/assign-plan`, { method: 'POST', body });
      await loadAssignedDays(clientId);
      const statusEl = document.getElementById('assign-status');
      statusEl.className = 'assign-status assigned';
      statusEl.innerHTML = `<b>Saved.</b> ${days > 1 ? `Days ${res.days[0]}–${res.days[res.days.length - 1]} are` : `Day ${day} is`} now assigned — re-opening this window will show it.`;
    }
    await loadRoster();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

/* ------------------------------------------------------------------ */
/* Default day template — a reusable window+meals+habits set so a       */
/* normal day doesn't have to be retyped from scratch every time.       */
/* ------------------------------------------------------------------ */
async function saveAsDefaultDay() {
  try {
    const isFullDayFast = document.getElementById('assign-fullfast').checked;
    const meals = [...document.querySelectorAll('#assign-meals-rows .meal-row')].map(r => ({
      type: r.querySelector('.meal-type').value,
      name: r.querySelector('.meal-name').value,
      calories: parseInt(r.querySelector('.meal-cal').value, 10) || undefined
    })).filter(m => m.name);
    const milestones = [...document.querySelectorAll('#assign-milestones-rows .milestone-row')].map(r => ({
      label: r.querySelector('.milestone-label').value
    })).filter(m => m.label);

    if (!meals.length && !milestones.length) {
      return alert('Add at least one meal or habit below before saving it as your default day.');
    }

    await apiRequest('/admin/default-day-template', {
      method: 'PUT',
      body: {
        isFullDayFast,
        startHour: parseFloat(document.getElementById('assign-start').value),
        endHour: parseFloat(document.getElementById('assign-end').value),
        focus: document.getElementById('assign-focus').value,
        waterTargetMl: parseInt(document.getElementById('assign-water').value, 10) || 3000,
        meals, milestones
      }
    });
    alert('Saved as your default day. Use "Load my default day" on any day from now on.');
  } catch (err) { alert(err.message); }
}

async function loadDefaultDayIntoForm() {
  try {
    const data = await apiRequest('/admin/default-day-template');
    if (!data.template) return alert('You haven\'t saved a default day yet — build one below, then "Save this as my default day".');
    const t = data.template;
    document.getElementById('assign-meals-rows').innerHTML = '';
    document.getElementById('assign-milestones-rows').innerHTML = '';
    document.getElementById('assign-fullfast').checked = !!t.isFullDayFast;
    document.getElementById('assign-start').value = t.startHour ?? 9;
    document.getElementById('assign-end').value = t.endHour ?? 17;
    document.getElementById('assign-focus').value = t.focus || '';
    document.getElementById('assign-water').value = t.waterTargetMl || 3000;
    (t.meals || []).forEach(m => addMealRow(m.type, m.name, m.calories ?? ''));
    (t.milestones || []).forEach(m => addMilestoneRow(m.label));
    toggleAssignFullFast();
    const statusEl = document.getElementById('assign-status');
    statusEl.className = 'assign-status unassigned';
    statusEl.innerHTML = `<b>Loaded your default day</b> (saved ${new Date(t.savedAt).toLocaleDateString()}). Nothing is saved until you apply.`;
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Program guide — per-day text the client reads, edited independently  */
/* of full meal assignment (quick day-info touch-ups).                  */
/* ------------------------------------------------------------------ */
async function openProgramGuideModal(clientId, name) {
  document.getElementById('guide-client-name').textContent = name;
  document.getElementById('guide-client-id').value = clientId;
  document.getElementById('guide-seed-overwrite').checked = false;
  openModal('program-guide-modal');
  loadProgramGuideEditor(clientId);
}

async function loadProgramGuideEditor(clientId) {
  const el = document.getElementById('program-guide-editor');
  el.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const data = await apiRequest(`/admin/clients/${clientId}/program-guide`);
    el.innerHTML = data.days.map(d => `
      <div class="guide-editor-row ${d.day === data.currentDay ? 'current-day' : ''}">
        <div class="guide-editor-day">Day ${d.day}${d.day === data.currentDay ? ' <span class="badge badge-active">Today</span>' : ''}</div>
        <textarea placeholder="What's this day about?"
          onblur="saveDayFocus(${clientId}, ${d.day}, this.value)">${esc(d.focus || '')}</textarea>
      </div>`).join('');
  } catch (err) {
    el.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

// Fills every day's guide text from the coach's 55-day protocol document
// (utils/protocolDefaults.js). By default only days with nothing written
// yet get filled — an already-customized day is left alone unless the
// coach explicitly asks to overwrite.
async function seedProgramGuide(clientId) {
  const overwrite = document.getElementById('guide-seed-overwrite').checked;
  if (overwrite && !confirm('This replaces the text on EVERY day (1–55) with the 55-day protocol wording, including days you\'ve already written something custom for. Continue?')) return;
  try {
    const res = await apiRequest(`/admin/clients/${clientId}/program-guide/seed-defaults`, {
      method: 'POST', body: { overwrite }
    });
    await loadProgramGuideEditor(clientId);
    alert(overwrite
      ? `Filled all ${res.total} days from the 55-day protocol.`
      : `Filled ${res.seeded - res.skipped} empty day(s) from the 55-day protocol — ${res.skipped} day(s) with existing text were left as-is.`);
  } catch (err) { alert(err.message); }
}

async function saveDayFocus(clientId, day, focus) {
  try {
    await apiRequest(`/admin/clients/${clientId}/regimen/${day}/focus`, { method: 'PATCH', body: { focus } });
  } catch (err) { alert(`Could not save day ${day}: ${err.message}`); }
}

/* ------------------------------------------------------------------ */
/* Payments                                                              */
/* ------------------------------------------------------------------ */
function setPaymentTab(status) {
  paymentTab = status;
  document.querySelectorAll('.pay-tab').forEach(b => b.classList.toggle('active', b.dataset.status === status));
  loadPayments();
}
async function loadPayments() {
  try {
  const data = await apiRequest(`/admin/payments?status=${paymentTab}`);
  document.getElementById('payments-body').innerHTML = data.payments.length ? data.payments.map(p => `
    <tr>
      <td>${esc(p.User.name)}<br><span class="hint">${esc(p.User.email)}</span></td>
      <td>${esc(p.planName)}</td>
      <td>₹${p.amountInr}</td>
      <td>${esc(p.utr)}</td>
      <td>${new Date(p.createdAt).toLocaleDateString()}</td>
      <td class="nowrap">
        ${p.status === 'pending' ? `
          <button class="btn btn-primary btn-sm" onclick="approvePayment(${p.id})">Approve</button>
          <button class="btn btn-outline btn-sm" onclick="rejectPayment(${p.id})">Reject</button>` : `<span class="badge badge-${p.status === 'approved' ? 'active' : 'rejected'}">${p.status}</span>`}
      </td>
    </tr>`).join('') : `<tr><td colspan="6" class="muted">No ${esc(paymentTab)} payments.</td></tr>`;
  } catch (err) {
    document.getElementById('payments-body').innerHTML = errorRow(6, 'payments', 'loadPayments()');
    throw err;
  }
}
async function approvePayment(id) {
  try { await apiRequest(`/admin/payments/${id}/approve`, { method: 'POST' }); await loadPayments(); await loadRoster(); }
  catch (err) { alert(err.message); }
}
async function rejectPayment(id) {
  const note = prompt('Reason for rejection (optional)') || '';
  try { await apiRequest(`/admin/payments/${id}/reject`, { method: 'POST', body: { note } }); await loadPayments(); }
  catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Leaderboard                                                           */
/* ------------------------------------------------------------------ */
async function loadLeaderboard() {
  try {
    const data = await apiRequest('/admin/leaderboard');
    document.getElementById('leaderboard-body').innerHTML = data.leaderboard.map((c, i) => `
      <tr><td>${i + 1}</td><td>${esc(c.name)}</td><td>${c.points}</td><td>${c.streakCurrent}</td><td>${c.streakBest}</td></tr>
    `).join('') || '<tr><td colspan="5" class="muted">No coached clients yet.</td></tr>';
  } catch (err) {
    document.getElementById('leaderboard-body').innerHTML = errorRow(5, 'the leaderboard', 'loadLeaderboard()');
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Payouts                                                               */
/* ------------------------------------------------------------------ */
function setPayoutTab(status) {
  payoutTab = status;
  document.querySelectorAll('.payout-tab').forEach(b => b.classList.toggle('active', b.dataset.status === status));
  loadPayouts();
}
async function loadPayouts() {
  try {
  const data = await apiRequest(`/admin/payouts?status=${payoutTab}`);
  document.getElementById('payouts-body').innerHTML = data.payouts.length ? data.payouts.map(p => `
    <tr>
      <td>${esc(p.User.name)}</td><td>₹${p.amountInr}</td><td>${esc(p.upiId)}</td>
      <td>${new Date(p.requestedAt).toLocaleDateString()}</td>
      <td class="nowrap">${p.status === 'pending' ? `
        <button class="btn btn-primary btn-sm" onclick="approvePayout(${p.id})">Mark paid</button>
        <button class="btn btn-outline btn-sm" onclick="rejectPayout(${p.id})">Reject</button>` : `<span class="badge badge-${p.status === 'paid' ? 'active' : 'rejected'}">${p.status}</span>`}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="muted">No ${esc(payoutTab)} payouts.</td></tr>`;
  } catch (err) {
    document.getElementById('payouts-body').innerHTML = errorRow(5, 'payouts', 'loadPayouts()');
    throw err;
  }
}
async function approvePayout(id) {
  try { await apiRequest(`/admin/payouts/${id}/approve`, { method: 'POST' }); await loadPayouts(); }
  catch (err) { alert(err.message); }
}
async function rejectPayout(id) {
  try { await apiRequest(`/admin/payouts/${id}/reject`, { method: 'POST' }); await loadPayouts(); }
  catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Referral overview                                                     */
/* ------------------------------------------------------------------ */
async function loadReferrals() {
  try {
    const data = await apiRequest('/admin/referrals');
    document.getElementById('referrals-body').innerHTML = data.overview.length ? data.overview.map(r => `
      <tr>
        <td>${esc(r.name)}<br><span class="hint">${esc(r.email)}</span></td>
        <td>${esc(r.referralCode)}</td>
        <td>${esc(r.referredByName || '—')}</td>
        <td>${r.referredCount}</td>
        <td>₹${r.walletBalanceInr}</td>
        <td><button class="btn btn-outline btn-sm" onclick="adjustWallet(${r.id})">Adjust</button></td>
      </tr>`).join('') : '<tr><td colspan="6" class="muted">No clients yet.</td></tr>';
  } catch (err) {
    document.getElementById('referrals-body').innerHTML = errorRow(6, 'referrals', 'loadReferrals()');
    throw err;
  }
}
async function adjustWallet(id) {
  const deltaInr = parseInt(prompt('Adjustment amount (₹, use a negative number to deduct)'), 10);
  if (!deltaInr) return;
  try { await apiRequest(`/admin/referrals/${id}/adjust-wallet`, { method: 'POST', body: { deltaInr } }); await loadReferrals(); }
  catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Plans & pricing — coach creates BOTH coached-protocol and Fasting     */
/* Tracker plans here; both show up on the landing page and payment page.*/
/* ------------------------------------------------------------------ */
async function loadPlans() {
  try {
  const data = await apiRequest('/admin/plans');
  plansCache = data.plans;
  document.getElementById('plans-list').innerHTML = plansCache.map(p => `
    <div class="roster-card">
      <div class="roster-main">
        <div style="min-width:0;">
          <div class="roster-name">${esc(p.name)} <span class="badge badge-${p.mode === 'tracker' ? 'pending' : 'active'}">${p.mode === 'tracker' ? 'Fasting Tracker' : 'Coached'}</span></div>
          <div class="roster-meta">₹${p.priceInr} · ${p.durationDays} days · ${esc(p.tagline || '')}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-outline btn-sm" onclick='openPlanModal(${JSON.stringify(p).replace(/'/g, "&#39;")})'>Edit</button>
        <button class="btn-ghost btn-sm" onclick="deletePlan(${p.id})">Delete</button>
      </div>
    </div>`).join('');
  } catch (err) {
    document.getElementById('plans-list').innerHTML = errorBlock('plans', 'loadPlans()');
    throw err;
  }
}
function openPlanModal(plan) {
  document.getElementById('plan-modal-title').textContent = plan ? 'Edit plan' : 'New plan';
  document.getElementById('plan-id').value = plan ? plan.id : '';
  document.getElementById('plan-key').value = plan ? plan.key : '';
  document.getElementById('plan-key').disabled = !!plan;
  document.getElementById('plan-name').value = plan ? plan.name : '';
  document.getElementById('plan-mode').value = plan ? plan.mode : 'protocol';
  document.getElementById('plan-price').value = plan ? plan.priceInr : '';
  document.getElementById('plan-duration').value = plan ? plan.durationDays : 55;
  document.getElementById('plan-tagline').value = plan ? plan.tagline || '' : '';
  document.getElementById('plan-features').value = plan ? (plan.features || []).join('\n') : '';
  document.getElementById('plan-brochure').value = plan ? plan.brochure || '' : '';
  document.getElementById('plan-error').style.display = 'none';
  openModal('plan-modal');
}
async function submitPlan() {
  const errEl = document.getElementById('plan-error');
  try {
    const id = document.getElementById('plan-id').value;
    const body = {
      key: document.getElementById('plan-key').value,
      name: document.getElementById('plan-name').value,
      mode: document.getElementById('plan-mode').value,
      priceInr: parseInt(document.getElementById('plan-price').value, 10),
      durationDays: parseInt(document.getElementById('plan-duration').value, 10),
      tagline: document.getElementById('plan-tagline').value,
      features: document.getElementById('plan-features').value.split('\n').map(s => s.trim()).filter(Boolean),
      brochure: document.getElementById('plan-brochure').value
    };
    if (id) await apiRequest(`/admin/plans/${id}`, { method: 'PUT', body });
    else await apiRequest('/admin/plans', { method: 'POST', body });
    closeModal('plan-modal');
    await loadPlans();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}
async function deletePlan(id) {
  if (!confirm('Delete this plan?')) return;
  try { await apiRequest(`/admin/plans/${id}`, { method: 'DELETE' }); await loadPlans(); }
  catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Alerts                                                                */
/* ------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.nav-link[data-view="alerts"]').addEventListener('click', async () => {
    const select = document.getElementById('alert-target');
    select.innerHTML = '<option value="">Whole cohort</option>' + roster.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    const data = await apiRequest('/admin/alerts');
    document.getElementById('sent-alerts').innerHTML = data.alerts.slice(0, 20).map(a => `
      <div class="card" style="margin-bottom:8px;"><strong>${esc(a.title)}</strong> <span class="badge badge-${a.level === 'urgent' ? 'rejected' : 'pending'}">${a.level}</span>
      <p style="margin-top:6px;font-size:14px;">${esc(a.body)}</p></div>`).join('');
  });
});
async function sendAlert() {
  try {
    const userId = document.getElementById('alert-target').value || null;
    const title = document.getElementById('alert-title').value;
    const body = document.getElementById('alert-body').value;
    const level = document.getElementById('alert-level').value;
    if (!title || !body) throw new Error('Title and message are required');
    await apiRequest('/admin/alerts', { method: 'POST', body: { userId, title, body, level } });
    document.getElementById('alert-title').value = '';
    document.getElementById('alert-body').value = '';
    alert('Alert sent.');
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Chat                                                                  */
/* ------------------------------------------------------------------ */
let threadsCache = [];

async function loadThreads() {
  try {
    const data = await apiRequest('/admin/messages/threads');
    threadsCache = data.threads;
    const totalUnread = data.threads.reduce((s, t) => s + t.unread, 0);
    const badge = document.getElementById('badge-chat');
    badge.hidden = totalUnread === 0;
    badge.textContent = totalUnread;
    document.getElementById('chat-threads').innerHTML = data.threads.map(t => `
      <div class="checklist-row" style="cursor:pointer;${currentThreadClientId === t.clientId ? 'border-color:var(--ink);' : ''}" onclick="loadThread(${t.clientId})">
        <div><strong>${esc(t.name)}</strong><br><span class="hint">${esc((t.lastMessage.body || '').slice(0, 40))}</span></div>
        ${t.unread ? `<span class="badge badge-pending">${t.unread}</span>` : ''}
      </div>`).join('') || '<p class="hint">No conversations yet. Use "Message a client" above to start one.</p>';
    populateChatClientPicker();
  } catch (err) {
    document.getElementById('chat-threads').innerHTML = errorBlock('conversations', 'loadThreads()');
    throw err;
  }
}

// The client list above only ever showed people who had ALREADY messaged
// the coach — there was no way to start a conversation with someone who
// hadn't. This dropdown lists every client in the roster (existing
// threads get their unread count shown too), and picking one opens —
// or starts — that conversation.
function populateChatClientPicker() {
  const select = document.getElementById('chat-new-client');
  if (!select || !roster.length) return;
  const unreadByClient = {};
  threadsCache.forEach(t => { unreadByClient[t.clientId] = t.unread; });
  const current = select.value;
  select.innerHTML = '<option value="">Pick a client to start or open a conversation…</option>' +
    roster.map(c => `<option value="${c.id}">${esc(c.name)}${unreadByClient[c.id] ? ` (${unreadByClient[c.id]} unread)` : ''}</option>`).join('');
  select.value = current;
}
function startNewThread(clientId) {
  if (!clientId) return;
  loadThread(parseInt(clientId, 10));
}
async function loadThread(clientId, silent) {
  currentThreadClientId = clientId;
  const select = document.getElementById('chat-new-client');
  if (select) select.value = clientId;
  document.getElementById('chat-thread-empty').style.display = 'none';
  document.getElementById('chat-composer-row').style.display = 'flex';
  try {
    const data = await apiRequest(`/admin/messages/${clientId}`);
    document.getElementById('chat-thread').innerHTML = data.messages.length ? data.messages.map(m => `
      <div style="align-self:${m.sender === 'admin' ? 'flex-end' : 'flex-start'};background:${m.sender === 'admin' ? 'var(--ink)' : 'var(--paper)'};color:${m.sender === 'admin' ? '#fff' : 'var(--ink)'};padding:8px 12px;border-radius:10px;max-width:80%;font-size:14px;">
        ${esc(m.body)}
      </div>`).join('') : '<p class="hint">No messages yet — say hello below.</p>';
    if (!silent) document.getElementById('chat-thread').scrollTop = 999999;
    if (!silent) loadThreads();
  } catch (err) {
    document.getElementById('chat-thread').innerHTML = errorBlock('this conversation', `loadThread(${clientId})`);
  }
}
async function sendAdminMessage() {
  const input = document.getElementById('chat-input');
  if (!currentThreadClientId || !input.value.trim()) return;
  try {
    await apiRequest(`/admin/messages/${currentThreadClientId}`, { method: 'POST', body: { body: input.value } });
    input.value = '';
    await loadThread(currentThreadClientId);
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Contact / settings                                                    */
/* ------------------------------------------------------------------ */
async function loadSettings() {
  try {
  const data = await apiRequest('/admin/settings');
  const s = data.settings;
  document.getElementById('settings-card').innerHTML = `
    <div class="field"><label>Coach name</label><input type="text" id="set-coachName" value="${esc(s.coachName)}"></div>
    <div class="field"><label>Phone</label><input type="text" id="set-phone" value="${esc(s.phone)}"></div>
    <div class="field"><label>WhatsApp</label><input type="text" id="set-whatsapp" value="${esc(s.whatsapp)}"></div>
    <div class="field"><label>Email</label><input type="text" id="set-email" value="${esc(s.email)}"></div>
    <div class="field"><label>UPI ID</label><input type="text" id="set-upiId" value="${esc(s.upiId)}"></div>
    <div class="field"><label>Address</label><input type="text" id="set-address" value="${esc(s.address)}"></div>
    <div class="field"><label>Support hours</label><input type="text" id="set-supportHours" value="${esc(s.supportHours)}"></div>
    <div class="field"><label>Note</label><textarea id="set-note" rows="3">${esc(s.note)}</textarea></div>
    <button class="btn btn-primary btn-sm" onclick="saveSettings()">Save</button>`;
  } catch (err) {
    document.getElementById('settings-card').innerHTML = errorBlock('settings', 'loadSettings()');
    throw err;
  }
}
async function saveSettings() {
  const fields = ['coachName', 'phone', 'whatsapp', 'email', 'upiId', 'address', 'supportHours', 'note'];
  const body = {};
  fields.forEach(f => body[f] = document.getElementById(`set-${f}`).value);
  try { await apiRequest('/admin/settings', { method: 'PUT', body }); alert('Saved.'); }
  catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Site settings — website name + logo (applies everywhere, including   */
/* the sign-in page, via the public /api/site-settings + applyBranding) */
/* ------------------------------------------------------------------ */
let pendingLogoBase64 = undefined; // undefined = unchanged, null = remove, string = new logo

async function loadSiteSettings() {
  const el = document.getElementById('site-settings-card');
  if (!el) return;
  pendingLogoBase64 = undefined;
  try {
    const s = await apiRequest('/site-settings', { auth: false });
    el.innerHTML = `
      <div class="field" style="max-width:360px;"><label>Website name</label>
        <input type="text" id="site-name-input" value="${esc(s.siteName || 'FastCoach')}" placeholder="FastCoach">
      </div>
      <div class="field"><label>Logo</label>
        <div class="logo-row">
          <div class="logo-preview" id="logo-preview">
            ${s.logoBase64 ? `<img src="${s.logoBase64}" alt="Current logo">` : '<span class="hint">No logo set — using text only</span>'}
          </div>
          <div>
            <input type="file" id="logo-file-input" accept="image/png,image/jpeg,image/svg+xml,image/webp" onchange="handleLogoFile(this)">
            <div class="hint" style="margin-top:6px;">PNG, JPG, SVG or WebP. Shown at a small size in the nav/sidebar, so keep it simple.</div>
            ${s.logoBase64 ? `<button class="btn-ghost btn-sm" style="margin-top:6px;" onclick="removeLogo()">Remove logo</button>` : ''}
          </div>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="saveSiteSettings()">Save site settings</button>`;
  } catch (err) {
    el.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

function handleLogoFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 1.5 * 1024 * 1024) { alert('Please use an image under 1.5MB.'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    pendingLogoBase64 = reader.result; // data: URI, stored as-is
    document.getElementById('logo-preview').innerHTML = `<img src="${reader.result}" alt="New logo preview">`;
  };
  reader.readAsDataURL(file);
}

function removeLogo() {
  pendingLogoBase64 = null;
  document.getElementById('logo-preview').innerHTML = '<span class="hint">No logo set — using text only</span>';
}

async function saveSiteSettings() {
  try {
    const body = { siteName: document.getElementById('site-name-input').value };
    if (pendingLogoBase64 !== undefined) body.logoBase64 = pendingLogoBase64;
    await apiRequest('/admin/branding', { method: 'PUT', body });
    await applyBranding(); // refresh this page's own sidebar immediately
    await loadSiteSettings();
    alert('Saved. The new name/logo will show everywhere, including the sign-in page.');
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Client detail — including the body metrics the client saved from     */
/* their BMI calculator. The coach could not see any of this before.    */
/* ------------------------------------------------------------------ */
async function openClientDetail(id) {
  openModal('client-detail-modal');
  const el = document.getElementById('client-detail-body');
  el.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const d = await apiRequest(`/admin/clients/${id}`);
    const c = d.client, b = d.body || {};
    const bmiBand = b.bmi === null || b.bmi === undefined ? null
      : b.bmi < 18.5 ? 'Underweight' : b.bmi < 25 ? 'Normal' : b.bmi < 30 ? 'Overweight' : 'Obese';

    document.getElementById('client-detail-name').textContent = c.name;
    el.innerHTML = `
      <div class="detail-grid">
        <div class="detail-cell"><span>Status</span><b>${esc(c.status)}</b></div>
        <div class="detail-cell"><span>Plan</span><b>${esc(c.tier || '—')} · ${esc(c.planMode)}</b></div>
        <div class="detail-cell"><span>Day</span><b>${c.challengeStartDate ? `${d.checklistLogs.length ? '' : ''}${c.challengeLengthDays} day programme` : 'Not started'}</b></div>
        <div class="detail-cell"><span>Points</span><b>${c.points} · streak ${c.streakCurrent}</b></div>
      </div>

      <h4 class="detail-head">Body metrics</h4>
      ${b.heightCm || b.currentWeightKg ? `
        <div class="detail-grid">
          <div class="detail-cell"><span>Height</span><b>${b.heightCm ? b.heightCm + ' cm' : '—'}</b></div>
          <div class="detail-cell"><span>Age / gender</span><b>${b.age || '—'} ${b.gender ? '· ' + esc(b.gender) : ''}</b></div>
          <div class="detail-cell"><span>Current weight</span><b>${b.currentWeightKg ? b.currentWeightKg + ' kg' : '—'}</b></div>
          <div class="detail-cell"><span>Since start</span><b>${b.changeKg === null ? '—' : `${b.changeKg > 0 ? '+' : ''}${b.changeKg} kg`}</b></div>
          <div class="detail-cell"><span>BMI</span><b>${b.bmi ?? '—'} ${bmiBand ? `<span class="badge badge-${bmiBand === 'Normal' ? 'active' : 'pending'}">${bmiBand}</span>` : ''}</b></div>
          <div class="detail-cell"><span>Healthy range</span><b>${b.healthyWeightRange ? `${b.healthyWeightRange.minKg}–${b.healthyWeightRange.maxKg} kg` : '—'}</b></div>
        </div>` : '<p class="hint">This client has not saved a height or weight yet — they enter it from History &amp; weight → BMI calculator.</p>'}

      <h4 class="detail-head">Weight log</h4>
      ${d.weightLogs.length ? `<div class="detail-log">${d.weightLogs.slice().reverse().slice(0, 12).map(w =>
        `<div class="confirm-row"><span>${new Date(w.date).toLocaleDateString()}</span><b>${w.weightKg} kg</b></div>`).join('')}</div>`
        : '<p class="hint">No weight entries yet.</p>'}

      <h4 class="detail-head">Assigned days</h4>
      ${d.regimens.length ? `<div class="chip-row">${d.regimens.map(r =>
        `<span class="day-chip static" title="${esc(r.focus || '')}">${r.day}</span>`).join('')}</div>`
        : '<p class="hint">No plan days assigned yet.</p>'}`;
  } catch (err) {
    el.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}
