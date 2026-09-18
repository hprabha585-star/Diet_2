let roster = [];
let protocolDefaults = [];
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

  document.querySelectorAll('.nav-link').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); showView(a.dataset.view); });
  });

  await loadProtocolDefaults();
  await loadRoster();
  await loadPlans();
  loadPayments();
  loadLeaderboard();
  loadPayouts();
  loadReferrals();
  loadSettings();
  loadThreads();
  chatPoll = setInterval(() => { if (currentThreadClientId) loadThread(currentThreadClientId, true); loadThreads(); }, 15000);
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
  const data = await apiRequest('/admin/clients');
  roster = data.clients;
  renderRoster();
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
            <button onclick="openAdminPauseModal(${c.id}, ${c.fastingPause.active})">${c.fastingPause.active ? 'Resume fasting' : 'Pause fasting'}</button>
            <button onclick="openResetPasswordModal(${c.id})">Reset password</button>
          </div>
        </div>
      </div>
    </div>
  `).join('') : '<p class="hint">No clients yet.</p>';
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
  const data = await apiRequest('/admin/protocol-defaults');
  protocolDefaults = data.days;
  const preset = document.getElementById('assign-day-preset');
  preset.innerHTML = '<option value="">Pick a 55-day default to pre-fill…</option>' +
    protocolDefaults.map(d => `<option value="${d.day}">Day ${d.day} — ${esc(d.label || d.phase)}</option>`).join('');
}

function openAssignPlanModal(clientId, name, suggestedDay) {
  document.getElementById('assign-client-id').value = clientId;
  document.getElementById('assign-client-name').textContent = name;
  document.getElementById('assign-day').value = suggestedDay || 1;
  document.getElementById('assign-day-preset').value = '';
  document.getElementById('assign-fullfast').checked = false;
  document.getElementById('assign-start').value = 9;
  document.getElementById('assign-end').value = 17;
  document.getElementById('assign-focus').value = '';
  document.getElementById('assign-water').value = 3000;
  document.getElementById('assign-meals-rows').innerHTML = '';
  document.getElementById('assign-milestones-rows').innerHTML = '';
  document.getElementById('assign-error').style.display = 'none';
  toggleAssignFullFast();
  openModal('assign-plan-modal');
}

function fillDayDefaults() {
  const day = parseInt(document.getElementById('assign-day').value, 10);
  const preset = document.getElementById('assign-day-preset');
  preset.value = protocolDefaults.some(d => d.day === day) ? day : '';
  if (preset.value) applyPreset();
}

function applyPreset() {
  const day = parseInt(document.getElementById('assign-day-preset').value, 10);
  const d = protocolDefaults.find(x => x.day === day);
  if (!d) return;
  document.getElementById('assign-day').value = d.day;
  document.getElementById('assign-fullfast').checked = !!d.isFullDayFast;
  document.getElementById('assign-start').value = d.startHour ?? 9;
  document.getElementById('assign-end').value = d.endHour ?? 17;
  document.getElementById('assign-focus').value = d.focus || '';
  document.getElementById('assign-water').value = d.waterTargetMl || 3000;
  toggleAssignFullFast();
}

function toggleAssignFullFast() {
  document.getElementById('assign-window-fields').style.display = document.getElementById('assign-fullfast').checked ? 'none' : 'flex';
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
    if (!day) throw new Error('Pick a day between 1 and 55');

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
      day,
      isFullDayFast,
      startHour: parseFloat(document.getElementById('assign-start').value),
      endHour: parseFloat(document.getElementById('assign-end').value),
      protocolType: isFullDayFast ? 'fast_24' : 'eating_window',
      focus: document.getElementById('assign-focus').value,
      waterTargetMl: parseInt(document.getElementById('assign-water').value, 10) || 3000,
      meals, milestones
    };

    if (applyAll) {
      if (!confirm(`Apply day ${day} to every active coached client? This overwrites their plan for that day.`)) return;
      const res = await apiRequest('/admin/assign-plan/apply-all', { method: 'POST', body });
      alert(`Applied to ${res.applied} client(s).`);
    } else {
      const clientId = document.getElementById('assign-client-id').value;
      await apiRequest(`/admin/clients/${clientId}/assign-plan`, { method: 'POST', body });
      closeModal('assign-plan-modal');
    }
    await loadRoster();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
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
  const data = await apiRequest('/admin/leaderboard');
  document.getElementById('leaderboard-body').innerHTML = data.leaderboard.map((c, i) => `
    <tr><td>${i + 1}</td><td>${esc(c.name)}</td><td>${c.points}</td><td>${c.streakCurrent}</td><td>${c.streakBest}</td></tr>
  `).join('') || '<tr><td colspan="5" class="muted">No coached clients yet.</td></tr>';
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
  const data = await apiRequest(`/admin/payouts?status=${payoutTab}`);
  document.getElementById('payouts-body').innerHTML = data.payouts.length ? data.payouts.map(p => `
    <tr>
      <td>${esc(p.User.name)}</td><td>₹${p.amountInr}</td><td>${esc(p.upiId)}</td>
      <td>${new Date(p.requestedAt).toLocaleDateString()}</td>
      <td class="nowrap">${p.status === 'pending' ? `
        <button class="btn btn-primary btn-sm" onclick="approvePayout(${p.id})">Mark paid</button>
        <button class="btn btn-outline btn-sm" onclick="rejectPayout(${p.id})">Reject</button>` : `<span class="badge badge-${p.status === 'paid' ? 'active' : 'rejected'}">${p.status}</span>`}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="muted">No ${esc(payoutTab)} payouts.</td></tr>`;
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
  const data = await apiRequest('/admin/referrals');
  document.getElementById('referrals-body').innerHTML = data.overview.map(r => `
    <tr>
      <td>${esc(r.name)}<br><span class="hint">${esc(r.email)}</span></td>
      <td>${esc(r.referralCode)}</td>
      <td>${esc(r.referredByName || '—')}</td>
      <td>${r.referredCount}</td>
      <td>₹${r.walletBalanceInr}</td>
      <td><button class="btn btn-outline btn-sm" onclick="adjustWallet(${r.id})">Adjust</button></td>
    </tr>`).join('');
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
      features: document.getElementById('plan-features').value.split('\n').map(s => s.trim()).filter(Boolean)
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
async function loadThreads() {
  const data = await apiRequest('/admin/messages/threads');
  const totalUnread = data.threads.reduce((s, t) => s + t.unread, 0);
  const badge = document.getElementById('badge-chat');
  badge.hidden = totalUnread === 0;
  badge.textContent = totalUnread;
  document.getElementById('chat-threads').innerHTML = data.threads.map(t => `
    <div class="checklist-row" style="cursor:pointer;${currentThreadClientId === t.clientId ? 'border-color:var(--ink);' : ''}" onclick="loadThread(${t.clientId})">
      <div><strong>${esc(t.name)}</strong><br><span class="hint">${esc((t.lastMessage.body || '').slice(0, 40))}</span></div>
      ${t.unread ? `<span class="badge badge-pending">${t.unread}</span>` : ''}
    </div>`).join('') || '<p class="hint">No conversations yet.</p>';
}
async function loadThread(clientId, silent) {
  currentThreadClientId = clientId;
  const data = await apiRequest(`/admin/messages/${clientId}`);
  document.getElementById('chat-thread').innerHTML = data.messages.map(m => `
    <div style="align-self:${m.sender === 'admin' ? 'flex-end' : 'flex-start'};background:${m.sender === 'admin' ? 'var(--ink)' : 'var(--paper)'};color:${m.sender === 'admin' ? '#fff' : 'var(--ink)'};padding:8px 12px;border-radius:10px;max-width:80%;font-size:14px;">
      ${esc(m.body)}
    </div>`).join('');
  if (!silent) document.getElementById('chat-thread').scrollTop = 999999;
  if (!silent) loadThreads();
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
}
async function saveSettings() {
  const fields = ['coachName', 'phone', 'whatsapp', 'email', 'upiId', 'address', 'supportHours', 'note'];
  const body = {};
  fields.forEach(f => body[f] = document.getElementById(`set-${f}`).value);
  try { await apiRequest('/admin/settings', { method: 'PUT', body }); alert('Saved.'); }
  catch (err) { alert(err.message); }
}
