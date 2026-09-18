let currentUser = null;
let dashboardData = null;
let timerInterval = null;
let addItemKind = 'meal';
let trackerRunning = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  currentUser = requireRoleOrRedirect('client');
  if (!currentUser) return;
  document.getElementById('user-chip').textContent = currentUser.name;

  document.querySelectorAll('.nav-link').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      showView(a.dataset.view);
    });
  });

  await loadDashboard();
  loadAlerts();
  loadContact();
  loadPaymentView();
  loadReferral();
}

function showView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(a => a.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelector(`.nav-link[data-view="${view}"]`).classList.add('active');
  document.getElementById('topbar-title').textContent = document.querySelector(`.nav-link[data-view="${view}"] span:nth-child(2)`).textContent;
  closeSidebar();
  if (view === 'chat') loadChat();
}

function openSidebar() { document.getElementById('sidebar').classList.add('open'); document.getElementById('sidebar-scrim').classList.add('show'); }
function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebar-scrim').classList.remove('show'); }

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

/* ------------------------------------------------------------------ */
/* Dashboard load                                                        */
/* ------------------------------------------------------------------ */
async function loadDashboard() {
  try {
    dashboardData = await apiRequest('/client/dashboard');
    document.getElementById('locked-notice').style.display = 'none';
  } catch (err) {
    if (err.message.includes('not active')) {
      document.getElementById('locked-notice').style.display = 'flex';
      document.getElementById('today-protocol').style.display = 'none';
      document.getElementById('today-tracker').style.display = 'none';
      return;
    }
    throw err;
  }

  document.getElementById('plan-mode-tag').textContent = dashboardData.planMode === 'tracker' ? 'Fasting Tracker' : 'Coached client';

  if (dashboardData.planMode === 'tracker') {
    document.getElementById('today-protocol').style.display = 'none';
    document.getElementById('today-tracker').style.display = 'block';
    renderTracker();
  } else {
    document.getElementById('today-tracker').style.display = 'none';
    document.getElementById('today-protocol').style.display = 'block';
    renderProtocolToday();
  }

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tick, 1000);
}

function renderProtocolToday() {
  document.getElementById('today-day').textContent = dashboardData.day;
  document.getElementById('today-total').textContent = dashboardData.challengeLengthDays;
  document.getElementById('today-focus').textContent = dashboardData.regimen ? dashboardData.regimen.focus || '' : 'No plan assigned yet for today — check back soon.';

  const paused = dashboardData.fastingPause.active;
  document.getElementById('pause-inactive').style.display = paused ? 'none' : 'block';
  document.getElementById('pause-active').style.display = paused ? 'block' : 'none';
  if (paused) document.getElementById('pause-reason-text').textContent = dashboardData.fastingPause.reason || '';

  renderChecklist();
  renderWater();
}

function renderChecklist() {
  const { meals, habits } = dashboardData.checklist;
  document.getElementById('meals-list').innerHTML = meals.map(renderChecklistRow).join('') || '<p class="hint">No meals assigned yet.</p>';
  document.getElementById('habits-list').innerHTML = habits.map(renderChecklistRow).join('') || '<p class="hint">No habits assigned yet.</p>';
}

function renderChecklistRow(item) {
  // Coach-assigned items: tick/untick only. Custom items: editable + deletable, never scored.
  return `
    <div class="checklist-row ${item.done ? 'done' : ''}">
      <label class="chk-label">
        <input type="checkbox" ${item.done ? 'checked' : ''} onchange="toggleItem(${item.id}, this.checked)">
        <span>${esc(item.label)}</span>
        ${item.custom ? '<span class="tag-custom">Your own · no points</span>' : ''}
      </label>
      ${item.custom ? `
        <div class="row-actions">
          <button class="btn-ghost btn-sm" onclick="renameItem(${item.id}, '${jsStr(item.label)}')">Edit</button>
          <button class="btn-ghost btn-sm" onclick="deleteItem(${item.id})">Delete</button>
        </div>` : ''}
    </div>`;
}

function renderWater() {
  const { waterMl, waterEntries } = dashboardData.checklist;
  document.getElementById('water-total').textContent = waterMl;
  document.getElementById('water-entries').innerHTML = (waterEntries || []).map(e => `
    <div class="row-between" style="padding:8px 0;border-top:1px solid var(--line);">
      <span class="small">${e.ml} ml — ${new Date(e.at).toLocaleTimeString()}</span>
      <button class="btn-ghost btn-sm" onclick="deleteWater(${e.id})">Remove</button>
    </div>`).join('');
}

async function toggleItem(itemId, done) {
  try {
    const res = await apiRequest('/client/checklist', { method: 'POST', body: { itemId, done } });
    if (res.awardedPoints) { /* streak/points updated server-side */ }
    await loadDashboard();
  } catch (err) { alert(err.message); }
}

function openAddItem(kind) {
  addItemKind = kind;
  document.getElementById('add-item-title').textContent = kind === 'meal' ? 'Add your own meal' : 'Add habit';
  document.getElementById('add-item-label').value = '';
  document.getElementById('add-item-error').style.display = 'none';
  openModal('add-item-modal');
}

async function submitAddItem() {
  const errEl = document.getElementById('add-item-error');
  try {
    const label = document.getElementById('add-item-label').value.trim();
    if (!label) throw new Error('Enter a label');
    await apiRequest('/client/checklist/items', { method: 'POST', body: { label, kind: addItemKind } });
    closeModal('add-item-modal');
    await loadDashboard();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

async function renameItem(id, currentLabel) {
  const label = prompt('Rename item', currentLabel);
  if (!label) return;
  try {
    await apiRequest(`/client/checklist/items/${id}`, { method: 'PATCH', body: { label } });
    await loadDashboard();
  } catch (err) { alert(err.message); }
}

async function deleteItem(id) {
  if (!confirm('Remove this item?')) return;
  try {
    await apiRequest(`/client/checklist/items/${id}`, { method: 'DELETE' });
    await loadDashboard();
  } catch (err) { alert(err.message); }
}

async function logWater(ml) {
  try { await apiRequest('/client/water', { method: 'POST', body: { ml } }); await loadDashboard(); }
  catch (err) { alert(err.message); }
}
function logWaterCustom() {
  const ml = parseInt(prompt('How many ml?'), 10);
  if (ml > 0) logWater(ml);
}
async function deleteWater(entryId) {
  try { await apiRequest(`/client/water/${entryId}`, { method: 'DELETE' }); await loadDashboard(); }
  catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Fasting pause / resume                                                */
/* ------------------------------------------------------------------ */
function openPauseModal() { document.getElementById('pause-reason-input').value = ''; openModal('pause-modal'); }
async function pauseFasting() {
  try {
    const reason = document.getElementById('pause-reason-input').value;
    await apiRequest('/client/fasting/pause', { method: 'POST', body: { reason } });
    closeModal('pause-modal');
    await loadDashboard();
  } catch (err) { alert(err.message); }
}
async function resumeFasting() {
  try { await apiRequest('/client/fasting/resume', { method: 'POST' }); await loadDashboard(); }
  catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Local-time tick: recompute countdown every second in THIS browser's  */
/* own clock — never trust server time for the display.                */
/* ------------------------------------------------------------------ */
function tick() {
  if (dashboardData && dashboardData.planMode === 'protocol' && dashboardData.regimen) {
    const fs = computeFastingState(dashboardData.regimen, dashboardData.fastingPause.active, dashboardData.fastingPause.reason);
    const fastEl = document.getElementById('fast-state');
    const eatEl = document.getElementById('eat-state');
    if (fs.state === 'paused') {
      fastEl.textContent = 'Paused'; eatEl.textContent = 'Paused';
      document.getElementById('fast-countdown').textContent = '--:--:--';
      document.getElementById('eat-countdown').textContent = '--:--:--';
      return;
    }
    if (fs.state === 'fasting') {
      fastEl.textContent = 'Active now'; eatEl.textContent = 'Opens soon';
      document.getElementById('fast-countdown').textContent = fmtCountdown(fs.secondsRemaining);
      document.getElementById('eat-countdown').textContent = fmtCountdown(fs.secondsRemaining);
    } else {
      fastEl.textContent = 'Starts soon'; eatEl.textContent = 'Active now';
      document.getElementById('fast-countdown').textContent = fmtCountdown(fs.secondsRemaining);
      document.getElementById('eat-countdown').textContent = fmtCountdown(fs.secondsRemaining);
    }
  }
  if (dashboardData && dashboardData.planMode === 'tracker' && trackerRunning) {
    const elapsed = (Date.now() - new Date(trackerRunning.startAt).getTime()) / 1000;
    document.getElementById('tracker-timer').textContent = fmtCountdown(elapsed);
  }
}

/* ------------------------------------------------------------------ */
/* Fasting Tracker (self-guided, no coach)                              */
/* ------------------------------------------------------------------ */
function renderTracker() {
  trackerRunning = dashboardData.running || null;
  document.getElementById('tracker-idle-form').style.display = trackerRunning ? 'none' : 'flex';
  document.getElementById('tracker-running-actions').style.display = trackerRunning ? 'block' : 'none';
  document.getElementById('tracker-target').textContent = trackerRunning ? `Target: ${trackerRunning.targetHours}h` : '';
  renderTrackerHistory(dashboardData.recentSessions || []);
}

function renderTrackerHistory(sessions) {
  document.getElementById('tracker-history').innerHTML = sessions.length ? sessions.map(s => {
    const hours = s.endAt ? ((new Date(s.endAt) - new Date(s.startAt)) / 3600000).toFixed(1) : '—';
    return `<div class="tracker-history-row">
      <span>${new Date(s.startAt).toLocaleDateString()} · target ${s.targetHours}h</span>
      <span class="tracker-status-${s.status}">${s.status === 'running' ? 'Running' : `${hours}h — ${s.status}`}</span>
    </div>`;
  }).join('') : '<p class="hint">No fasts logged yet.</p>';
}

async function startTrackerFast() {
  try {
    const targetHours = parseFloat(document.getElementById('tracker-target-input').value);
    await apiRequest('/client/tracker/start', { method: 'POST', body: { targetHours } });
    await loadDashboard();
  } catch (err) { alert(err.message); }
}
async function stopTrackerFast() {
  try {
    await apiRequest('/client/tracker/stop', { method: 'POST' });
    await loadDashboard();
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* History & weight                                                      */
/* ------------------------------------------------------------------ */
async function loadHistoryPage() {
  try {
    const data = await apiRequest('/client/history');
    document.getElementById('weight-list').innerHTML = (data.weightLogs || []).slice().reverse().map(w => `
      <div class="row-between" style="padding:10px 0;border-top:1px solid var(--line);">
        <span>${w.weightKg} kg — ${new Date(w.date).toLocaleDateString()}</span>
        <button class="btn-ghost btn-sm" onclick="deleteWeight(${w.id})">Delete</button>
      </div>`).join('') || '<p class="hint">No entries yet.</p>';
    renderBmi(data.bmi, data.healthyWeightRange);
  } catch (err) { /* ignore if not active yet */ }
}
document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.nav-link[data-view="history"]').addEventListener('click', loadHistoryPage);
});

function renderBmi(bmi, range) {
  const el = document.getElementById('bmi-result');
  if (!bmi) { el.innerHTML = '<p class="hint">Log a weight and your height to see BMI.</p>'; return; }
  const band = bmi < 18.5 ? 'Underweight' : bmi < 25 ? 'Healthy range' : bmi < 30 ? 'Overweight' : 'Obese';
  el.innerHTML = `
    <div class="stat-grid two">
      <div class="card stat-card"><div class="val">${bmi}</div><div class="lbl">BMI — ${band}</div></div>
      <div class="card stat-card"><div class="val">${range ? `${range.minKg}–${range.maxKg} kg` : '—'}</div><div class="lbl">Healthy range for your height</div></div>
    </div>`;
}

async function logWeight() {
  try {
    const weightKg = parseFloat(document.getElementById('weight-input').value);
    if (!weightKg) return;
    await apiRequest('/client/weight', { method: 'POST', body: { weightKg } });
    document.getElementById('weight-input').value = '';
    await loadHistoryPage();
  } catch (err) { alert(err.message); }
}
async function deleteWeight(id) {
  if (!confirm('Delete this entry?')) return;
  try { await apiRequest(`/client/weight/${id}`, { method: 'DELETE' }); await loadHistoryPage(); }
  catch (err) { alert(err.message); }
}
async function saveProfile() {
  try {
    const body = {
      heightCm: parseFloat(document.getElementById('height-input').value) || undefined,
      age: parseInt(document.getElementById('age-input').value, 10) || undefined,
      gender: document.getElementById('gender-input').value || undefined
    };
    await apiRequest('/client/profile', { method: 'POST', body });
    await loadHistoryPage();
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Alerts                                                                */
/* ------------------------------------------------------------------ */
async function loadAlerts() {
  try {
    const data = await apiRequest('/client/alerts');
    const badge = document.getElementById('badge-alerts');
    badge.hidden = data.unread === 0;
    badge.textContent = data.unread;
    document.getElementById('alerts-list').innerHTML = data.alerts.length ? data.alerts.map(a => `
      <div class="card" style="margin-bottom:10px;">
        <div class="row-between"><strong>${esc(a.title)}</strong><span class="badge badge-${a.level === 'urgent' ? 'rejected' : a.level === 'important' ? 'pending' : 'active'}">${esc(a.level)}</span></div>
        <p style="margin-top:6px;font-size:14px;">${esc(a.body)}</p>
        <p class="hint" style="margin-top:6px;">${new Date(a.createdAt).toLocaleString()}</p>
      </div>`).join('') : '<p class="hint">No alerts yet.</p>';
  } catch (err) { /* not active yet */ }
}

/* ------------------------------------------------------------------ */
/* Chat                                                                  */
/* ------------------------------------------------------------------ */
async function loadChat() {
  const data = await apiRequest('/client/messages');
  document.getElementById('chat-thread').innerHTML = data.messages.map(m => `
    <div style="align-self:${m.sender === 'client' ? 'flex-end' : 'flex-start'};background:${m.sender === 'client' ? 'var(--ink)' : 'var(--paper)'};color:${m.sender === 'client' ? '#fff' : 'var(--ink)'};padding:8px 12px;border-radius:10px;max-width:80%;font-size:14px;">
      ${esc(m.body)}
    </div>`).join('');
  document.getElementById('chat-thread').scrollTop = 999999;
}
async function sendMessage() {
  const input = document.getElementById('chat-input');
  if (!input.value.trim()) return;
  try {
    await apiRequest('/client/messages', { method: 'POST', body: { body: input.value } });
    input.value = '';
    await loadChat();
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Referral                                                              */
/* ------------------------------------------------------------------ */
async function loadReferral() {
  try {
    const data = await apiRequest('/client/referral');
    document.getElementById('referral-card').innerHTML = `
      <h3>Your code: ${esc(data.referralCode)}</h3>
      <div class="stat-grid two" style="margin-top:16px;">
        <div class="card stat-card"><div class="val">₹${data.walletBalanceInr}</div><div class="lbl">Wallet balance</div></div>
        <div class="card stat-card"><div class="val">${data.referredCount}</div><div class="lbl">People referred</div></div>
      </div>
      <div class="field" style="margin-top:20px;max-width:220px;"><label>Request payout (₹)</label><input type="number" id="payout-amount"></div>
      <div class="field" style="max-width:280px;"><label>UPI ID</label><input type="text" id="payout-upi"></div>
      <button class="btn btn-primary btn-sm" onclick="requestPayout()">Request payout</button>`;
  } catch (err) { /* not active yet */ }
}
async function requestPayout() {
  try {
    const amountInr = parseInt(document.getElementById('payout-amount').value, 10);
    const upiId = document.getElementById('payout-upi').value;
    await apiRequest('/client/payout-request', { method: 'POST', body: { amountInr, upiId } });
    alert('Payout requested.');
    await loadReferral();
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Contact us                                                            */
/* ------------------------------------------------------------------ */
async function loadContact() {
  const data = await apiRequest('/client/contact', { auth: true });
  const s = data.settings;
  document.getElementById('contact-card').innerHTML = `
    <p><strong>${esc(s.coachName || 'Your coach')}</strong></p>
    <p style="margin-top:10px;">${s.phone ? `<a href="tel:${esc(s.phone)}" class="btn btn-outline btn-sm">Call ${esc(s.phone)}</a>` : ''}
    ${s.whatsapp ? `<a href="https://wa.me/${esc(s.whatsapp.replace(/\D/g, ''))}" class="btn btn-primary btn-sm" style="margin-left:8px;">WhatsApp</a>` : ''}</p>
    <p style="margin-top:14px;font-size:14px;">${esc(s.email || '')}</p>
    <p style="margin-top:6px;font-size:14px;">${esc(s.address || '')}</p>
    <p style="margin-top:6px;font-size:14px;">Support hours: ${esc(s.supportHours || '')}</p>
    <p style="margin-top:10px;font-size:14px;">${esc(s.note || '')}</p>`;
}

/* ------------------------------------------------------------------ */
/* Payment                                                               */
/* ------------------------------------------------------------------ */
async function loadPaymentView() {
  const [plansData, statusData] = await Promise.all([
    apiRequest('/client/plans', { auth: true }),
    apiRequest('/client/payment-status')
  ]);
  const last = statusData.lastPayment;
  const statusHtml = last ? `<div class="card" style="margin-bottom:16px;">
      <span class="badge badge-${last.status === 'approved' ? 'active' : last.status === 'rejected' ? 'rejected' : 'pending'}">${esc(last.status)}</span>
      <span class="small muted" style="margin-left:8px;">${esc(last.planName)} — ₹${last.amountInr} — UTR ${esc(last.utr)}</span>
    </div>` : '';

  document.getElementById('payment-card').innerHTML = `
    ${statusHtml}
    <div class="field"><label>Plan</label>
      <select id="pay-plan">${plansData.plans.map(p => `<option value="${p.key}">${esc(p.name)} — ₹${p.priceInr} (${p.mode === 'tracker' ? 'self-guided' : 'coached'})</option>`).join('')}</select>
    </div>
    <div class="field"><label>UTR / UPI reference number</label><input type="text" id="pay-utr"></div>
    <div class="error-text" id="pay-error" style="display:none;"></div>
    <button class="btn btn-primary btn-sm" onclick="submitPayment()">Submit payment</button>`;
}
async function submitPayment() {
  const errEl = document.getElementById('pay-error');
  try {
    const tier = document.getElementById('pay-plan').value;
    const utr = document.getElementById('pay-utr').value.trim();
    if (!utr) throw new Error('Enter your UTR reference number');
    await apiRequest('/client/payments', { method: 'POST', body: { tier, utr } });
    await loadPaymentView();
    alert('Payment submitted. Your coach will review it shortly.');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}
