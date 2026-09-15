let currentPayStatus = 'pending';
let currentPayoutStatus = 'pending';
let protocolDays = [];
let protocolPhase = 'all';

const PROTOCOL_LABELS = {
  eating_window: 'Eating window',
  refeed: 'Refeed day',
  fast_24: '24-hour fast',
  fast_36: '36-hour fast',
  fast_48: '48-hour fast',
  break_fast: 'Break extended fast',
  stabilization: 'Stabilization'
};

document.addEventListener('DOMContentLoaded', async () => {
  const user = requireRoleOrRedirect('admin');
  if (!user) return;
  document.getElementById('user-chip').textContent = user.name;

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showView(link.dataset.view);
      closeSidebar();
    });
  });
  document.querySelectorAll('.pay-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.pay-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentPayStatus = tab.dataset.status;
      loadPayments();
    });
  });
  document.querySelectorAll('.payout-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.payout-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentPayoutStatus = tab.dataset.status;
      loadPayouts();
    });
  });

  await loadRoster();
  const hash = (window.location.hash || '').replace('#', '');
  if (hash && document.getElementById(`view-${hash}`)) showView(hash);
});

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-scrim').classList.add('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-scrim').classList.remove('show');
}

function showView(view) {
  document.querySelectorAll('section[id^="view-"]').forEach(s => s.style.display = 'none');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const section = document.getElementById(`view-${view}`);
  const link = document.querySelector(`.nav-link[data-view="${view}"]`);
  if (!section || !link) return;
  section.style.display = 'block';
  link.classList.add('active');
  const labelEl = link.querySelector('span:last-child');
  document.getElementById('page-title').textContent = (labelEl ? labelEl.textContent : link.textContent).trim();
  window.location.hash = view;

  if (view === 'roster') loadRoster();
  if (view === 'payments') loadPayments();
  if (view === 'leaderboard') loadLeaderboard();
  if (view === 'payouts') loadPayouts();
  if (view === 'protocol') loadProtocol();
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function jsStr(s) { return esc(s).replace(/'/g, "\\'"); }

function statusBadge(status) {
  const cls = status === 'active' || status === 'paid' ? 'active' : status === 'rejected' ? 'rejected' : 'pending';
  return `<span class="badge badge-${cls}">${esc(String(status).replace('_', ' '))}</span>`;
}

function hourLabel(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

/* ------------------------------------------------------------------ */
/* Roster                                                              */
/* ------------------------------------------------------------------ */
async function loadRoster() {
  const tbody = document.getElementById('roster-body');
  try {
    const data = await apiRequest('/admin/clients');
    tbody.innerHTML = data.clients.map(c => `
      <tr>
        <td><strong>${esc(c.name)}</strong><br><span class="muted small">${esc(c.email)}</span></td>
        <td>${c.status === 'active' ? `${c.day} / ${c.challengeLengthDays}` : '—'}</td>
        <td>${statusBadge(c.status)}${c.paused ? '<br><span class="badge badge-pending">paused</span>' : ''}</td>
        <td>${c.paused
              ? `<span class="muted">Paused — ${esc(c.pauseReason || 'no reason')}</span>`
              : c.fastingState
                ? `${esc(c.fastingState.state)} · ${c.fastingState.countdown}`
                : (c.status === 'active' ? 'No plan today' : '—')}</td>
        <td>${c.waterMl} ml</td>
        <td>${c.completionPercent}%</td>
        <td>${c.bmi || '—'}</td>
        <td class="nowrap">
          ${c.status === 'active' ? `
            <button class="btn btn-outline btn-sm" onclick="openRegimenModal('${c._id}','${jsStr(c.name)}',${c.day})">Assign plan</button>
            <button class="btn btn-outline btn-sm" onclick="openApplyModal('${c._id}','${jsStr(c.name)}',${c.day})">Apply protocol day</button>
            <button class="btn btn-ghost btn-sm" onclick="togglePause('${c._id}', ${c.paused ? 'false' : 'true'})">${c.paused ? 'Resume' : 'Pause'}</button>
          ` : ''}
          ${c.status === 'pending_payment' ? `<button class="btn btn-dark btn-sm" onclick="activateClient('${c._id}')">Activate</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="openResetPwModal('${c._id}','${jsStr(c.name)}')">Reset password</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="8" class="muted">No clients yet.</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="error-text">${esc(err.message)}</td></tr>`;
  }
}

async function activateClient(id) {
  if (!confirm('Activate this client without a logged payment?')) return;
  try {
    await apiRequest(`/admin/clients/${id}/activate`, { method: 'POST' });
    loadRoster();
  } catch (err) { alert(err.message); }
}

async function togglePause(id, active) {
  const makeActive = active === true || active === 'true';
  let reason = '';
  if (makeActive) {
    reason = prompt('Why are you pausing this client? (illness, travel, medical advice…)') || '';
    if (!reason.trim()) return;
  } else if (!confirm('Resume this client\'s fasting schedule?')) {
    return;
  }
  try {
    await apiRequest(`/admin/clients/${id}/pause`, { method: 'POST', body: { active: makeActive, reason } });
    loadRoster();
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* 55-day protocol                                                     */
/* ------------------------------------------------------------------ */
async function loadProtocol() {
  const tbody = document.getElementById('protocol-body');
  try {
    const data = await apiRequest('/admin/protocol');
    protocolDays = data.days || [];
    document.getElementById('safety-list').innerHTML =
      (data.safetyNotes || []).map(n => `<li>${esc(n)}</li>`).join('');

    if (!protocolDays.length) {
      document.getElementById('phase-tabs').innerHTML = '';
      tbody.innerHTML = '<tr><td colspan="7" class="muted">Protocol not loaded yet — click “Load defaults” to import the 55-day plan.</td></tr>';
      return;
    }
    renderPhaseTabs();
    renderProtocolTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="error-text">${esc(err.message)}</td></tr>`;
  }
}

function renderPhaseTabs() {
  const phases = [...new Set(protocolDays.map(d => d.phase))];
  document.getElementById('phase-tabs').innerHTML =
    [`<button class="${protocolPhase === 'all' ? 'active' : ''}" onclick="setPhase('all')">All 55 days</button>`]
      .concat(phases.map(p => {
        const short = p.split('—')[0].trim();
        return `<button class="${protocolPhase === p ? 'active' : ''}" onclick="setPhase('${jsStr(p)}')" title="${esc(p)}">${esc(short)}</button>`;
      })).join('');
}

function setPhase(p) {
  protocolPhase = p;
  renderPhaseTabs();
  renderProtocolTable();
}

function renderProtocolTable() {
  const rows = protocolPhase === 'all' ? protocolDays : protocolDays.filter(d => d.phase === protocolPhase);
  let lastPhase = '';
  document.getElementById('protocol-body').innerHTML = rows.map(d => {
    const header = (protocolPhase === 'all' && d.phase !== lastPhase)
      ? `<tr class="phase-row"><td colspan="7">${esc(d.phase)}</td></tr>` : '';
    lastPhase = d.phase;
    return header + `
      <tr>
        <td><strong>Day ${d.day}</strong></td>
        <td>${esc(PROTOCOL_LABELS[d.protocolType] || d.protocolType)}${d.label ? `<br><span class="muted small">${esc(d.label)}</span>` : ''}</td>
        <td>${d.isFullDayFast ? '<span class="muted">No eating window</span>' : `${hourLabel(d.startHour)} – ${hourLabel(d.endHour)}`}</td>
        <td>${d.eatingHours}h / ${d.fastingHours}h</td>
        <td class="muted">${esc(d.focus || '')}</td>
        <td>${d.waterTargetMl} ml</td>
        <td class="nowrap">
          <button class="btn btn-outline btn-sm" onclick="openProtocolModal(${d.day})">Edit</button>
          <button class="icon-btn danger" onclick="deleteProtocolDay(${d.day})">Delete</button>
        </td>
      </tr>`;
  }).join('');
}

async function seedProtocol(force) {
  if (force && !confirm('Reset all 55 days back to the original protocol? Your edits will be lost.')) return;
  try {
    await apiRequest('/admin/protocol/seed', { method: 'POST', body: { force: !!force } });
    loadProtocol();
  } catch (err) { alert(err.message); }
}

function openProtocolModal(day) {
  const d = protocolDays.find(x => x.day === day) || { day, phase: 'Custom', protocolType: 'eating_window', startHour: 9, endHour: 17, waterTargetMl: 3000 };
  document.getElementById('pd-day').value = d.day;
  document.getElementById('pd-day-title').textContent = `Day ${d.day}`;
  document.getElementById('pd-phase').value = d.phase || '';
  document.getElementById('pd-type').value = d.protocolType || 'eating_window';
  document.getElementById('pd-label').value = d.label || '';
  document.getElementById('pd-fullfast').checked = !!d.isFullDayFast;
  document.getElementById('pd-start').value = d.startHour != null ? d.startHour : 9;
  document.getElementById('pd-end').value = d.endHour != null ? d.endHour : 17;
  document.getElementById('pd-focus').value = d.focus || '';
  document.getElementById('pd-water').value = d.waterTargetMl || 3000;
  document.getElementById('pd-error').style.display = 'none';
  document.getElementById('pd-success').style.display = 'none';
  toggleFullFast();
  document.getElementById('protocol-modal').classList.add('open');
}
function closeProtocolModal() { document.getElementById('protocol-modal').classList.remove('open'); }

function toggleFullFast() {
  const on = document.getElementById('pd-fullfast').checked;
  document.getElementById('pd-window-fields').style.display = on ? 'none' : 'flex';
}

function protocolPayload() {
  const fullFast = document.getElementById('pd-fullfast').checked;
  return {
    phase: document.getElementById('pd-phase').value,
    protocolType: document.getElementById('pd-type').value,
    label: document.getElementById('pd-label').value,
    isFullDayFast: fullFast,
    startHour: parseFloat(document.getElementById('pd-start').value),
    endHour: parseFloat(document.getElementById('pd-end').value),
    focus: document.getElementById('pd-focus').value,
    waterTargetMl: parseInt(document.getElementById('pd-water').value, 10) || 3000
  };
}

async function saveProtocolDay(keepOpen) {
  const errEl = document.getElementById('pd-error');
  const okEl = document.getElementById('pd-success');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  try {
    const day = parseInt(document.getElementById('pd-day').value, 10);
    const body = protocolPayload();
    if (!body.isFullDayFast && (isNaN(body.startHour) || isNaN(body.endHour))) {
      throw new Error('Set an eating window, or tick “full-day fast”.');
    }
    await apiRequest(`/admin/protocol/${day}`, { method: 'PUT', body });
    await loadProtocol();
    if (!keepOpen) closeProtocolModal();
    return day;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
    throw err;
  }
}

async function applyDayToCohort() {
  const okEl = document.getElementById('pd-success');
  try {
    const day = await saveProtocolDay(true);
    if (!confirm(`Push day ${day} to every active client? This overwrites their plan for that day.`)) return;
    const res = await apiRequest('/admin/protocol/apply-all', { method: 'POST', body: { day } });
    okEl.textContent = `Applied to ${res.applied} active client${res.applied === 1 ? '' : 's'}.`;
    okEl.style.display = 'block';
  } catch (err) { /* error already surfaced */ }
}

async function deleteProtocolDay(day) {
  if (!confirm(`Delete day ${day} from the protocol?`)) return;
  try {
    await apiRequest(`/admin/protocol/${day}`, { method: 'DELETE' });
    loadProtocol();
  } catch (err) { alert(err.message); }
}

/* Apply one protocol day to one client */
function openApplyModal(clientId, name, suggestedDay) {
  document.getElementById('apply-client-id').value = clientId;
  document.getElementById('apply-client-name').textContent = name;
  document.getElementById('apply-day').value = suggestedDay || 1;
  document.getElementById('apply-error').style.display = 'none';
  document.getElementById('apply-success').style.display = 'none';
  document.getElementById('apply-modal').classList.add('open');
}
function closeApplyModal() { document.getElementById('apply-modal').classList.remove('open'); }

async function submitApplyProtocol() {
  const errEl = document.getElementById('apply-error');
  const okEl = document.getElementById('apply-success');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  try {
    const clientId = document.getElementById('apply-client-id').value;
    const day = parseInt(document.getElementById('apply-day').value, 10);
    if (!day) throw new Error('Pick a day between 1 and 55');
    await apiRequest(`/admin/clients/${clientId}/apply-protocol`, { method: 'POST', body: { day } });
    okEl.textContent = `Day ${day} applied. Add meals with “Assign plan” if you want to personalise it.`;
    okEl.style.display = 'block';
    loadRoster();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

/* ------------------------------------------------------------------ */
/* Add client / reset password                                         */
/* ------------------------------------------------------------------ */
function openAddClientModal() {
  ['ac-name', 'ac-email', 'ac-phone', 'ac-password'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('ac-tier').value = 'none';
  document.getElementById('ac-activate').checked = false;
  document.getElementById('ac-error').style.display = 'none';
  document.getElementById('ac-success').style.display = 'none';
  document.getElementById('add-client-modal').classList.add('open');
}
function closeAddClientModal() { document.getElementById('add-client-modal').classList.remove('open'); }

async function submitAddClient() {
  const errEl = document.getElementById('ac-error');
  const okEl = document.getElementById('ac-success');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
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
    okEl.textContent = 'Client created — share the email and password with them so they can sign in.';
    okEl.style.display = 'block';
    loadRoster();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

function openResetPwModal(clientId, name) {
  document.getElementById('rp-client-id').value = clientId;
  document.getElementById('rp-client-name').textContent = name;
  document.getElementById('rp-password').value = '';
  document.getElementById('rp-error').style.display = 'none';
  document.getElementById('rp-success').style.display = 'none';
  document.getElementById('reset-pw-modal').classList.add('open');
}
function closeResetPwModal() { document.getElementById('reset-pw-modal').classList.remove('open'); }

async function submitResetPassword() {
  const errEl = document.getElementById('rp-error');
  const okEl = document.getElementById('rp-success');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  try {
    const clientId = document.getElementById('rp-client-id').value;
    const newPassword = document.getElementById('rp-password').value;
    await apiRequest(`/admin/clients/${clientId}/reset-password`, { method: 'POST', body: { newPassword } });
    okEl.textContent = 'Password updated — share it with the client.';
    okEl.style.display = 'block';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

/* ------------------------------------------------------------------ */
/* Payments / leaderboard / payouts                                    */
/* ------------------------------------------------------------------ */
async function loadPayments() {
  const tbody = document.getElementById('payments-body');
  try {
    const data = await apiRequest(`/admin/payments?status=${currentPayStatus}`);
    tbody.innerHTML = data.payments.map(p => `
      <tr>
        <td><strong>${esc(p.user ? p.user.name : 'Unknown')}</strong><br><span class="muted small">${esc(p.user ? p.user.email : '')}</span></td>
        <td style="text-transform:capitalize;">${esc(p.tier)}</td>
        <td>₹${p.amountInr}</td>
        <td>${esc(p.utr)}</td>
        <td>${new Date(p.createdAt).toLocaleString()}</td>
        <td class="nowrap">
          ${p.status === 'pending' ? `
            <button class="btn btn-dark btn-sm" onclick="approvePayment('${p._id}')">Approve</button>
            <button class="btn btn-outline btn-sm" onclick="rejectPayment('${p._id}')">Reject</button>
          ` : statusBadge(p.status)}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="6" class="muted">No ${currentPayStatus} payments.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="error-text">${esc(err.message)}</td></tr>`;
  }
}

async function approvePayment(id) {
  try { await apiRequest(`/admin/payments/${id}/approve`, { method: 'POST' }); loadPayments(); }
  catch (err) { alert(err.message); }
}
async function rejectPayment(id) {
  const note = prompt('Reason for rejection (optional):') || '';
  try { await apiRequest(`/admin/payments/${id}/reject`, { method: 'POST', body: { note } }); loadPayments(); }
  catch (err) { alert(err.message); }
}

async function loadLeaderboard() {
  try {
    const data = await apiRequest('/admin/leaderboard');
    const list = document.getElementById('leaderboard-list');
    list.innerHTML = data.leaderboard.map((c, i) => `
      <div class="leaderboard-row">
        <span class="rank">${i + 1}</span>
        <span class="name">${esc(c.name)} <span class="muted small" style="text-transform:capitalize;">(${esc(c.tier)})</span></span>
        <span class="pts">${c.points} pts · ${c.streakCurrent}🔥 streak (best ${c.streakBest})</span>
      </div>
    `).join('') || '<p class="hint">No active clients yet.</p>';
  } catch (err) { console.error(err); }
}

async function loadPayouts() {
  const tbody = document.getElementById('payouts-body');
  try {
    const data = await apiRequest(`/admin/payouts?status=${currentPayoutStatus}`);
    tbody.innerHTML = data.payouts.map(p => `
      <tr>
        <td>${esc(p.user ? p.user.name : 'Unknown')}</td>
        <td>₹${p.amountInr}</td>
        <td>${esc(p.upiId)}</td>
        <td>${new Date(p.requestedAt).toLocaleDateString()}</td>
        <td class="nowrap">
          ${p.status === 'pending' ? `
            <button class="btn btn-dark btn-sm" onclick="approvePayout('${p._id}')">Mark paid</button>
            <button class="btn btn-outline btn-sm" onclick="rejectPayout('${p._id}')">Reject</button>
          ` : statusBadge(p.status)}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="5" class="muted">No ${currentPayoutStatus} payouts.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="error-text">${esc(err.message)}</td></tr>`;
  }
}
async function approvePayout(id) {
  try { await apiRequest(`/admin/payouts/${id}/approve`, { method: 'POST' }); loadPayouts(); }
  catch (err) { alert(err.message); }
}
async function rejectPayout(id) {
  try { await apiRequest(`/admin/payouts/${id}/reject`, { method: 'POST' }); loadPayouts(); }
  catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Regimen builder                                                     */
/* ------------------------------------------------------------------ */
function openRegimenModal(clientId, name, suggestedDay) {
  document.getElementById('regimen-client-id').value = clientId;
  document.getElementById('regimen-client-name').textContent = name;
  document.getElementById('regimen-day').value = suggestedDay || 1;
  document.getElementById('regimen-fullfast').checked = false;
  document.getElementById('regimen-start').value = 9;
  document.getElementById('regimen-end').value = 17;
  document.getElementById('regimen-water').value = 3000;
  document.getElementById('regimen-focus').value = '';
  document.getElementById('meal-rows').innerHTML = '';
  document.getElementById('milestone-rows').innerHTML = '';
  document.getElementById('regimen-error').style.display = 'none';
  addMealRow('morning_detox', 'Warm lemon water');
  addMealRow('breakfast', '');
  addMealRow('lunch', '');
  addMealRow('dinner', '');
  addMilestoneRow('workout', 'Complete workout');
  addMilestoneRow('protein_target', 'Hit protein target');
  document.getElementById('regimen-modal').classList.add('open');
}
function closeRegimenModal() { document.getElementById('regimen-modal').classList.remove('open'); }

function addMealRow(type = 'breakfast', name = '', calories = '') {
  const row = document.createElement('div');
  row.className = 'meal-row';
  row.innerHTML = `
    <select class="meal-type">
      <option value="morning_detox" ${type === 'morning_detox' ? 'selected' : ''}>Morning detox</option>
      <option value="breakfast" ${type === 'breakfast' ? 'selected' : ''}>Breakfast</option>
      <option value="lunch" ${type === 'lunch' ? 'selected' : ''}>Lunch</option>
      <option value="snack" ${type === 'snack' ? 'selected' : ''}>Snack</option>
      <option value="dinner" ${type === 'dinner' ? 'selected' : ''}>Dinner</option>
    </select>
    <input type="text" class="meal-name" placeholder="e.g. 3 egg whites + oats" value="${esc(name)}">
    <input type="number" class="meal-cal" placeholder="kcal" value="${esc(calories)}">
    <button class="remove-row-btn" onclick="this.parentElement.remove()">Remove</button>
  `;
  document.getElementById('meal-rows').appendChild(row);
}

function addMilestoneRow(key = '', label = '') {
  const row = document.createElement('div');
  row.className = 'meal-row';
  row.style.gridTemplateColumns = '1fr 1.6fr auto';
  row.innerHTML = `
    <input type="text" class="milestone-key" placeholder="key e.g. water_target" value="${esc(key)}">
    <input type="text" class="milestone-label" placeholder="Label shown to client" value="${esc(label)}">
    <button class="remove-row-btn" onclick="this.parentElement.remove()">Remove</button>
  `;
  document.getElementById('milestone-rows').appendChild(row);
}

async function saveRegimen() {
  const errEl = document.getElementById('regimen-error');
  errEl.style.display = 'none';
  try {
    const clientId = document.getElementById('regimen-client-id').value;
    const day = parseInt(document.getElementById('regimen-day').value, 10);
    const isFullDayFast = document.getElementById('regimen-fullfast').checked;
    const startHour = parseFloat(document.getElementById('regimen-start').value);
    const endHour = parseFloat(document.getElementById('regimen-end').value);
    const waterTargetMl = parseInt(document.getElementById('regimen-water').value, 10);
    const focus = document.getElementById('regimen-focus').value;

    const meals = Array.from(document.querySelectorAll('#meal-rows .meal-row')).map(row => ({
      type: row.querySelector('.meal-type').value,
      name: row.querySelector('.meal-name').value,
      calories: row.querySelector('.meal-cal').value ? Number(row.querySelector('.meal-cal').value) : undefined
    })).filter(m => m.name.trim().length > 0);

    const milestones = Array.from(document.querySelectorAll('#milestone-rows .meal-row')).map(row => ({
      key: row.querySelector('.milestone-key').value,
      label: row.querySelector('.milestone-label').value
    })).filter(m => m.key.trim() && m.label.trim());

    if (!day || (!isFullDayFast && (isNaN(startHour) || isNaN(endHour)))) {
      throw new Error('Day and eating window are required');
    }

    await apiRequest(`/admin/clients/${clientId}/regimen`, {
      method: 'POST',
      body: {
        day,
        fastingWindow: isFullDayFast ? { startHour: 9, endHour: 9 } : { startHour, endHour },
        isFullDayFast,
        protocolType: isFullDayFast ? 'fast_24' : 'eating_window',
        focus,
        meals, milestones, waterTargetMl
      }
    });
    closeRegimenModal();
    loadRoster();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}
