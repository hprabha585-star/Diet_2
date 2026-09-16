let dashboardData = null;
let timerInterval = null;
let chartMetric = 'completionPercent';
let isLocked = true;
let plansCache = [];
let chatPoll = null;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hourLabel(h) {
  const hh = Math.floor(((h % 24) + 24) % 24);
  const mm = Math.round((h - Math.floor(h)) * 60);
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

function hoursLabel(h) {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return mins ? `${whole} h ${mins} min` : `${whole} hours`;
}

const PROTOCOL_LABELS = {
  eating_window: 'Standard eating window',
  refeed: 'Refeed day',
  fast_24: '24-hour fast',
  fast_36: '36-hour fast',
  fast_48: '48-hour fast',
  break_fast: 'Breaking an extended fast',
  stabilization: 'Stabilization / exit routine'
};

/* ------------------------------------------------------------------ */
/* Boot + navigation                                                   */
/* ------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', async () => {
  const user = requireRoleOrRedirect('client');
  if (!user) return;
  document.getElementById('user-chip').textContent = user.name;

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (isLocked && link.dataset.locked === '1') {
        showView('payment');
        closeSidebar();
        return;
      }
      showView(link.dataset.view);
      closeSidebar();
    });
  });

  const input = document.getElementById('chat-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
  }

  await loadDashboard();

  const hash = (window.location.hash || '').replace('#', '');
  if (hash && document.getElementById(`view-${hash}`)) showView(hash);
  else if (isLocked) showView('payment');
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
  const link = document.querySelector(`.nav-link[data-view="${view}"]`);
  const section = document.getElementById(`view-${view}`);
  if (!section || !link) return;
  if (isLocked && link.dataset.locked === '1') return showView('payment');

  document.querySelectorAll('section[id^="view-"]').forEach(s => s.style.display = 'none');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  section.style.display = 'block';
  link.classList.add('active');
  const labelEl = link.querySelector('span:nth-child(2)');
  document.getElementById('page-title').textContent = (labelEl ? labelEl.textContent : link.textContent).trim();
  window.location.hash = view;
  window.scrollTo({ top: 0 });

  if (chatPoll) { clearInterval(chatPoll); chatPoll = null; }

  if (view === 'history') loadHistory();
  if (view === 'leaderboard') loadLeaderboard();
  if (view === 'refer') loadReferral();
  if (view === 'protocol') loadProtocol();
  if (view === 'payment') loadPaymentView();
  if (view === 'alerts') loadAlerts();
  if (view === 'contact') loadContact();
  if (view === 'chat') {
    loadMessages();
    chatPoll = setInterval(() => loadMessages(true), 15000);
  }
}

function applyLockState(locked) {
  isLocked = locked;
  document.querySelectorAll('.nav-link').forEach(l => {
    if (l.dataset.locked === '1') l.classList.toggle('disabled', locked);
  });
  document.getElementById('inactive-banner').style.display = locked ? 'flex' : 'none';
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */
async function loadDashboard() {
  try {
    const data = await apiRequest('/client/dashboard');
    dashboardData = data;

    if (data.status !== 'active') {
      applyLockState(true);
      document.getElementById('inactive-msg').textContent =
        data.status === 'pending_payment'
          ? "Your account isn't active yet."
          : `Your account status is "${data.status}".`;
      renderPaymentStatus(data.payments || []);
      showView('payment');
      return;
    }

    applyLockState(false);
    document.getElementById('stat-day').textContent = `${data.day} / ${data.challengeLengthDays}`;
    document.getElementById('side-mini-day').textContent = `Day ${data.day} / ${data.challengeLengthDays}`;
    document.getElementById('stat-streak').textContent = data.streakCurrent;
    document.getElementById('stat-best').textContent = data.streakBest;
    document.getElementById('stat-today').textContent = `${data.checklist ? data.checklist.completionPercent : 0}%`;

    setBadge('badge-alerts', data.unreadAlerts);
    setBadge('badge-chat', data.unreadMessages);

    renderPauseState(data.fastingPause);
    renderChecklist(data.checklist);
    renderWater(data.checklist, data.regimen);
    renderWindows(data.regimen, data.fastingState);
    renderChart(data.chart || []);

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(tickTimer, 1000);
  } catch (err) {
    document.getElementById('checklist-container').innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

function setBadge(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  if (n > 0) { el.textContent = n > 9 ? '9+' : n; el.hidden = false; }
  else el.hidden = true;
}

/* ---------------- Fasting / eating window panels ---------------- */
function renderWindows(regimen, fastingState) {
  const fastPanel = document.getElementById('panel-fast');
  const eatPanel = document.getElementById('panel-eat');
  const line = document.getElementById('protocol-line');
  fastPanel.classList.remove('active');
  eatPanel.classList.remove('active');
  document.getElementById('fast-count').textContent = '';
  document.getElementById('eat-count').textContent = '';

  if (!regimen || !fastingState) {
    document.getElementById('fast-duration').textContent = '—';
    document.getElementById('fast-timeline').textContent = 'Waiting for your coach';
    document.getElementById('eat-duration').textContent = '—';
    document.getElementById('eat-timeline').textContent = 'Waiting for your coach';
    line.textContent = "Your fasting window appears here once your coach assigns today's plan.";
    return;
  }

  const start = regimen.fastingWindow.startHour;
  const end = regimen.fastingWindow.endHour;
  const eatingHours = regimen.isFullDayFast ? 0 : ((end - start) + 24) % 24 || 24;
  const fastingHours = 24 - eatingHours;

  if (regimen.isFullDayFast) {
    document.getElementById('fast-duration').textContent = '24 hours (full-day fast)';
    document.getElementById('fast-timeline').textContent = `Water and electrolytes only, until ${hourLabel(start)} tomorrow`;
    document.getElementById('eat-duration').textContent = 'None today';
    document.getElementById('eat-timeline').textContent = 'No eating window on a full-day fast';
    eatPanel.classList.add('muted-panel');
  } else {
    eatPanel.classList.remove('muted-panel');
    const now = new Date();
    const hours = now.getHours() + now.getMinutes() / 60;
    const beforeWindow = hours < start;
    document.getElementById('fast-duration').textContent = hoursLabel(fastingHours);
    document.getElementById('fast-timeline').textContent =
      `From ${hourLabel(end)} ${beforeWindow ? '(yesterday)' : '(today)'} to ${hourLabel(start)} ${beforeWindow ? '(today)' : '(tomorrow)'}`;
    document.getElementById('eat-duration').textContent = hoursLabel(eatingHours);
    document.getElementById('eat-timeline').textContent = `From ${hourLabel(start)} to ${hourLabel(end)} (today)`;
  }

  const type = PROTOCOL_LABELS[regimen.protocolType] || 'Eating window';
  line.innerHTML = `<strong>${esc(type)}</strong>${regimen.focus ? ` — ${esc(regimen.focus)}` : ''}`;

  if (fastingState.state === 'paused') {
    document.getElementById('fast-count').textContent = 'Paused — eat and hydrate normally.';
    fastPanel.classList.add('active');
    return;
  }
  const activePanel = fastingState.state === 'fasting' ? fastPanel : eatPanel;
  activePanel.classList.add('active');
  updateCountdownText(fastingState);
}

function updateCountdownText(fastingState) {
  const target = fastingState.state === 'fasting' ? 'fast-count' : 'eat-count';
  const other = fastingState.state === 'fasting' ? 'eat-count' : 'fast-count';
  document.getElementById(other).textContent = '';
  document.getElementById(target).innerHTML = fastingState.state === 'fasting'
    ? `Right now: fasting · eating window opens in <strong>${fastingState.countdown}</strong>`
    : `Right now: eating · window closes in <strong>${fastingState.countdown}</strong>`;
}

function tickTimer() {
  const fs = dashboardData && dashboardData.fastingState;
  if (!fs || fs.state === 'paused') return;
  fs.secondsRemaining -= 1;
  if (fs.secondsRemaining <= 0) { loadDashboard(); return; }
  const s = fs.secondsRemaining;
  fs.countdown = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  updateCountdownText(fs);
}

/* ---------------- Chart ---------------- */
function setChartMetric(metric, btn) {
  chartMetric = metric;
  document.querySelectorAll('.chart-toggle .chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('chart-sub').textContent = metric === 'waterMl'
    ? 'Water logged per day, in millilitres.'
    : 'Each bar is one challenge day. 80% or more counts towards your streak.';
  renderChart((dashboardData && dashboardData.chart) || []);
}

function renderChart(rows) {
  const wrap = document.getElementById('chart-wrap');
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state"><h3>No history yet</h3><p>Your first bar appears once you tick off today\'s checklist.</p></div>';
    return;
  }
  const isWater = chartMetric === 'waterMl';
  const max = isWater ? Math.max(3000, ...rows.map(r => r.waterMl || 0)) : 100;

  wrap.innerHTML = `
    <div class="bars">
      ${rows.map(r => {
        const v = isWater ? (r.waterMl || 0) : (r.completionPercent || 0);
        const pct = Math.max(2, Math.round((v / max) * 100));
        const good = isWater ? v >= 3000 : v >= 80;
        return `
          <div class="bar-col" title="Day ${r.day}: ${isWater ? v + ' ml' : v + '%'}">
            <div class="bar-value">${isWater ? Math.round(v / 100) / 10 + 'L' : v + '%'}</div>
            <div class="bar-track"><div class="bar-fill ${good ? 'good' : ''}" style="height:${pct}%"></div></div>
            <div class="bar-label">${r.day}</div>
          </div>`;
      }).join('')}
    </div>
    ${isWater ? '' : '<div class="chart-goal"><span>80% streak line</span></div>'}
  `;
}

/* ---------------- Checklist ---------------- */
function renderChecklist(checklist) {
  const container = document.getElementById('checklist-container');
  if (!checklist || !checklist.items || checklist.items.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>Nothing assigned yet</h3><p>Your coach hasn\'t set meals or habits for today. You can still add your own with “+ Add habit”.</p></div>';
    return;
  }
  container.innerHTML = checklist.items.map(item => `
    <div class="checklist-item ${item.done ? 'done' : ''}">
      <input type="checkbox" ${item.done ? 'checked' : ''} onchange="toggleItem('${esc(item.key)}', this.checked)">
      <label>${esc(item.label)}${item.custom ? '<span class="tag">yours</span>' : ''}</label>
      <div class="row-actions">
        <button class="icon-btn" onclick="openItemModal('${esc(item.key)}', '${esc(item.label)}')">Edit</button>
        <button class="icon-btn danger" onclick="deleteItem('${esc(item.key)}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function afterChecklistUpdate(data) {
  if (dashboardData) dashboardData.checklist = data.checklist;
  renderChecklist(data.checklist);
  document.getElementById('stat-streak').textContent = data.streakCurrent;
  document.getElementById('stat-best').textContent = data.streakBest;
  document.getElementById('stat-today').textContent = `${data.checklist.completionPercent}%`;
}

async function toggleItem(itemKey, done) {
  try {
    const data = await apiRequest(`/client/checklist/items/${encodeURIComponent(itemKey)}`, { method: 'PATCH', body: { done } });
    afterChecklistUpdate(data);
  } catch (err) { alert(err.message); }
}

function openItemModal(key = '', label = '') {
  document.getElementById('item-key').value = key;
  const input = document.getElementById('item-label');
  input.value = label ? new DOMParser().parseFromString(label, 'text/html').body.textContent : '';
  document.getElementById('item-modal-title').textContent = key ? 'Edit habit' : 'Add a habit';
  document.getElementById('item-error').style.display = 'none';
  document.getElementById('item-modal').classList.add('open');
  setTimeout(() => input.focus(), 50);
}
function closeItemModal() { document.getElementById('item-modal').classList.remove('open'); }

async function saveItem() {
  const errEl = document.getElementById('item-error');
  errEl.style.display = 'none';
  try {
    const key = document.getElementById('item-key').value;
    const label = document.getElementById('item-label').value.trim();
    if (!label) throw new Error('Give the habit a name');
    const data = key
      ? await apiRequest(`/client/checklist/items/${encodeURIComponent(key)}`, { method: 'PATCH', body: { label } })
      : await apiRequest('/client/checklist/items', { method: 'POST', body: { label } });
    afterChecklistUpdate(data);
    closeItemModal();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

async function deleteItem(key) {
  if (!confirm('Remove this item from today\'s checklist?')) return;
  try {
    const data = await apiRequest(`/client/checklist/items/${encodeURIComponent(key)}`, { method: 'DELETE' });
    afterChecklistUpdate(data);
  } catch (err) { alert(err.message); }
}

/* ---------------- Water ---------------- */
function renderWater(checklist, regimen) {
  const target = (regimen && regimen.waterTargetMl) || 3000;
  const current = checklist ? checklist.waterMl : 0;
  const pct = Math.min(100, Math.round((current / target) * 100));
  document.getElementById('water-fill').style.width = `${pct}%`;
  document.getElementById('water-label').textContent = `${current} / ${target} ml`;

  const list = document.getElementById('water-entries');
  const entries = (checklist && checklist.waterEntries) || [];
  if (!entries.length) { list.innerHTML = '<p class="hint">No water logged yet.</p>'; return; }
  list.innerHTML = entries.slice().reverse().map(e => `
    <div class="entry-row">
      <span class="entry-main">${e.ml} ml</span>
      <span class="entry-sub">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <div class="row-actions">
        <button class="icon-btn" onclick="openWaterModal('${e._id}', ${e.ml})">Edit</button>
        <button class="icon-btn danger" onclick="deleteWater('${e._id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

async function addWater(ml) {
  try {
    const data = await apiRequest('/client/water', { method: 'POST', body: { ml } });
    if (dashboardData) dashboardData.checklist = data.checklist;
    renderWater(data.checklist, dashboardData && dashboardData.regimen);
  } catch (err) { alert(err.message); }
}

function openWaterModal(entryId = '', ml = '') {
  document.getElementById('water-entry-id').value = entryId;
  document.getElementById('water-ml').value = ml;
  document.getElementById('water-modal-title').textContent = entryId ? 'Edit water entry' : 'Log water';
  document.getElementById('water-error').style.display = 'none';
  document.getElementById('water-modal').classList.add('open');
}
function closeWaterModal() { document.getElementById('water-modal').classList.remove('open'); }

async function saveWater() {
  const errEl = document.getElementById('water-error');
  errEl.style.display = 'none';
  try {
    const entryId = document.getElementById('water-entry-id').value;
    const ml = Number(document.getElementById('water-ml').value);
    if (!ml || ml <= 0) throw new Error('Enter an amount in millilitres');
    const data = entryId
      ? await apiRequest(`/client/water/${entryId}`, { method: 'PATCH', body: { ml } })
      : await apiRequest('/client/water', { method: 'POST', body: { ml } });
    if (dashboardData) dashboardData.checklist = data.checklist;
    renderWater(data.checklist, dashboardData && dashboardData.regimen);
    closeWaterModal();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

async function deleteWater(entryId) {
  if (!confirm('Delete this water entry?')) return;
  try {
    const data = await apiRequest(`/client/water/${entryId}`, { method: 'DELETE' });
    if (dashboardData) dashboardData.checklist = data.checklist;
    renderWater(data.checklist, dashboardData && dashboardData.regimen);
  } catch (err) { alert(err.message); }
}

/* ---------------- Pause / resume ---------------- */
function renderPauseState(pause) {
  const paused = !!(pause && pause.active);
  const banner = document.getElementById('pause-banner');
  banner.style.display = paused ? 'flex' : 'none';
  if (paused) {
    const since = pause.startedAt ? new Date(pause.startedAt).toLocaleString() : '';
    document.getElementById('pause-reason-text').textContent =
      `${pause.reason || 'No reason given'}${since ? ` · paused since ${since}` : ''}. Your challenge day is frozen until you resume.`;
  }
  const btn = document.getElementById('pause-btn');
  btn.textContent = paused ? 'Resume fasting' : 'Pause fasting';
  btn.onclick = paused ? resumeFasting : openPauseModal;
}

function openPauseModal() {
  document.getElementById('pause-error').style.display = 'none';
  document.getElementById('pause-other-field').style.display = 'none';
  document.getElementById('pause-reason').value = '';
  document.getElementById('pause-modal').classList.add('open');
}
function closePauseModal() { document.getElementById('pause-modal').classList.remove('open'); }

function onPauseReasonChange() {
  const v = document.getElementById('pause-reason-select').value;
  document.getElementById('pause-other-field').style.display = v === 'other' ? 'block' : 'none';
}

async function confirmPause() {
  const errEl = document.getElementById('pause-error');
  errEl.style.display = 'none';
  try {
    const select = document.getElementById('pause-reason-select').value;
    const reason = select === 'other' ? document.getElementById('pause-reason').value.trim() : select;
    if (!reason) throw new Error('Add a short note so your coach knows what happened');
    await apiRequest('/client/fasting/pause', { method: 'POST', body: { reason } });
    closePauseModal();
    await loadDashboard();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

async function resumeFasting() {
  if (!confirm('Resume fasting? Your challenge day picks up where it left off.')) return;
  try {
    await apiRequest('/client/fasting/resume', { method: 'POST' });
    await loadDashboard();
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* History, weight & BMI                                               */
/* ------------------------------------------------------------------ */
async function loadHistory() {
  try {
    const data = await apiRequest('/client/history');

    if (data.heightCm) document.getElementById('bmi-height').value = data.heightCm;
    if (data.age) document.getElementById('bmi-age').value = data.age;
    if (data.gender) document.getElementById('bmi-gender').value = data.gender;
    const latest = data.weightLogs.length ? data.weightLogs[data.weightLogs.length - 1].weightKg : '';
    if (latest) document.getElementById('bmi-weight').value = latest;
    if (data.heightCm && latest) calculateBmi(true);

    const wTbody = document.querySelector('#weight-table tbody');
    const logs = data.weightLogs.slice().reverse();
    wTbody.innerHTML = logs.map((wLog, i) => {
      const prev = logs[i + 1];
      const delta = prev ? Math.round((wLog.weightKg - prev.weightKg) * 10) / 10 : null;
      const deltaHtml = delta === null ? '—'
        : `<span class="${delta < 0 ? 'delta-down' : delta > 0 ? 'delta-up' : ''}">${delta > 0 ? '+' : ''}${delta} kg</span>`;
      return `
        <tr>
          <td>${new Date(wLog.date).toLocaleDateString()}</td>
          <td>${wLog.weightKg} kg</td>
          <td>${deltaHtml}</td>
          <td class="nowrap">
            ${wLog._id ? `
              <button class="icon-btn" onclick="openWeightModal('${wLog._id}', ${wLog.weightKg}, '${new Date(wLog.date).toISOString().slice(0, 10)}')">Edit</button>
              <button class="icon-btn danger" onclick="deleteWeight('${wLog._id}')">Delete</button>
            ` : '<span class="muted small">logged before update</span>'}
          </td>
        </tr>`;
    }).join('') || '<tr><td colspan="4" class="muted">No weight logged yet</td></tr>';

    const hTbody = document.querySelector('#history-table tbody');
    hTbody.innerHTML = data.checklistHistory.slice().reverse().map(h => `
      <tr>
        <td>Day ${h.day}</td>
        <td>${new Date(h.date).toLocaleDateString()}</td>
        <td>${h.completionPercent}%</td>
        <td>${h.waterMl || 0} ml</td>
      </tr>
    `).join('') || '<tr><td colspan="4" class="muted">No history yet</td></tr>';
  } catch (err) { console.error(err); }
}

async function logWeight() {
  const msg = document.getElementById('weight-msg');
  try {
    const weightKg = parseFloat(document.getElementById('weight-input').value);
    if (!weightKg) return;
    await apiRequest('/client/weight', { method: 'POST', body: { weightKg } });
    msg.textContent = 'Weight saved — your BMI has been updated.';
    msg.style.display = 'block';
    document.getElementById('weight-input').value = '';
    await loadHistory();
  } catch (err) { alert(err.message); }
}

function openWeightModal(logId, weightKg, dateIso) {
  document.getElementById('weight-log-id').value = logId;
  document.getElementById('weight-edit-kg').value = weightKg;
  document.getElementById('weight-edit-date').value = dateIso;
  document.getElementById('weight-edit-error').style.display = 'none';
  document.getElementById('weight-modal').classList.add('open');
}
function closeWeightModal() { document.getElementById('weight-modal').classList.remove('open'); }

async function saveWeightEdit() {
  const errEl = document.getElementById('weight-edit-error');
  errEl.style.display = 'none';
  try {
    const id = document.getElementById('weight-log-id').value;
    const weightKg = parseFloat(document.getElementById('weight-edit-kg').value);
    const date = document.getElementById('weight-edit-date').value;
    if (!weightKg || weightKg <= 0) throw new Error('Enter a valid weight');
    await apiRequest(`/client/weight/${id}`, { method: 'PATCH', body: { weightKg, date } });
    closeWeightModal();
    loadHistory();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

async function deleteWeight(id) {
  if (!confirm('Delete this weight entry?')) return;
  try {
    await apiRequest(`/client/weight/${id}`, { method: 'DELETE' });
    loadHistory();
  } catch (err) { alert(err.message); }
}

function bmiCategory(bmi) {
  if (bmi < 18.5) return { label: 'Underweight', pos: (bmi / 18.5) * 25 };
  if (bmi < 25) return { label: 'Healthy range', pos: 25 + ((bmi - 18.5) / 6.5) * 25 };
  if (bmi < 30) return { label: 'Overweight', pos: 50 + ((bmi - 25) / 5) * 25 };
  return { label: 'Obese range', pos: Math.min(99, 75 + ((bmi - 30) / 10) * 25) };
}

function bmiReadingNote(age, gender) {
  const notes = [];
  if (age && age < 18) {
    notes.push('Under 18, adult BMI bands don\'t apply — growth charts by age are the right reference. Check with a doctor before fasting.');
  } else if (age && age >= 65) {
    notes.push('Over 65, a slightly higher BMI (around 23–28) is often healthier, since some reserve protects against illness and falls.');
  }
  if (gender === 'female') {
    notes.push('Women carry more essential body fat than men at the same BMI, so waist measurement is a useful second check.');
  } else if (gender === 'male') {
    notes.push('Men carry more muscle at the same BMI, so a muscular build can read as "overweight" without excess fat.');
  }
  notes.push('BMI is a screening number, not a diagnosis — discuss anything surprising with your coach or doctor.');
  return notes.join(' ');
}

function calculateBmi(silent) {
  const errEl = document.getElementById('bmi-error');
  const msg = document.getElementById('bmi-msg');
  errEl.style.display = 'none';
  if (!silent) msg.style.display = 'none';

  const h = parseFloat(document.getElementById('bmi-height').value);
  const w = parseFloat(document.getElementById('bmi-weight').value);
  const age = parseInt(document.getElementById('bmi-age').value, 10) || null;
  const gender = document.getElementById('bmi-gender').value;

  if (!h || !w) {
    if (!silent) { errEl.textContent = 'Enter both height and weight.'; errEl.style.display = 'block'; }
    return;
  }
  const m = h / 100;
  const bmi = Math.round((w / (m * m)) * 10) / 10;
  const cat = bmiCategory(bmi);

  document.getElementById('bmi-value').textContent = bmi;
  document.getElementById('bmi-category').textContent =
    cat.label + (age ? ` · age ${age}` : '') + (gender ? ` · ${gender}` : '');
  const marker = document.getElementById('bmi-marker');
  marker.style.left = `${cat.pos}%`;
  marker.style.display = 'block';

  // Healthy weight band for this height
  const minKg = Math.round(18.5 * m * m * 10) / 10;
  const maxKg = Math.round(24.9 * m * m * 10) / 10;
  let range = `A healthy weight for ${h} cm is <strong>${minKg}–${maxKg} kg</strong>.`;
  if (w > maxKg) range += ` You're ${Math.round((w - maxKg) * 10) / 10} kg above that band.`;
  else if (w < minKg) range += ` You're ${Math.round((minKg - w) * 10) / 10} kg below that band.`;
  else range += ' You\'re inside that band right now.';
  document.getElementById('bmi-range').innerHTML = range;
  document.getElementById('bmi-note').textContent = bmiReadingNote(age, gender);
}

async function saveBmiProfile() {
  const errEl = document.getElementById('bmi-error');
  const msg = document.getElementById('bmi-msg');
  errEl.style.display = 'none';
  msg.style.display = 'none';
  try {
    const heightCm = parseFloat(document.getElementById('bmi-height').value);
    const age = document.getElementById('bmi-age').value;
    const gender = document.getElementById('bmi-gender').value;
    if (!heightCm) throw new Error('Enter your height first');
    await apiRequest('/client/profile', { method: 'POST', body: { heightCm, age, gender } });
    msg.textContent = 'Saved — your coach can see this too.';
    msg.style.display = 'block';
    calculateBmi(true);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */
async function loadAlerts() {
  const wrap = document.getElementById('alerts-list');
  try {
    const data = await apiRequest('/client/alerts');
    setBadge('badge-alerts', data.unread);
    if (!data.alerts.length) {
      wrap.innerHTML = '<div class="empty-state"><h3>No alerts yet</h3><p>Anything your coach announces shows up here.</p></div>';
      return;
    }
    wrap.innerHTML = data.alerts.map(a => `
      <div class="card alert-card level-${esc(a.level)} ${a.read ? '' : 'unread'}" onclick="markAlertRead('${a._id}', this)">
        <div class="alert-head">
          <strong>${esc(a.title)}</strong>
          <span class="alert-meta">${new Date(a.createdAt).toLocaleString()}${a.forEveryone ? ' · cohort' : ''}</span>
        </div>
        <p>${esc(a.body)}</p>
      </div>
    `).join('');
  } catch (err) {
    wrap.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

async function markAlertRead(id, el) {
  if (el) el.classList.remove('unread');
  try {
    await apiRequest(`/client/alerts/${id}/read`, { method: 'POST' });
    const data = await apiRequest('/client/alerts');
    setBadge('badge-alerts', data.unread);
  } catch (err) { /* non-critical */ }
}

async function markAllAlertsRead() {
  try {
    await apiRequest('/client/alerts/read-all', { method: 'POST' });
    loadAlerts();
  } catch (err) { alert(err.message); }
}

/* ------------------------------------------------------------------ */
/* Chat with the coach                                                 */
/* ------------------------------------------------------------------ */
async function loadMessages(quiet) {
  const log = document.getElementById('chat-log');
  try {
    const data = await apiRequest('/client/messages');
    setBadge('badge-chat', 0);
    if (!data.messages.length) {
      log.innerHTML = '<div class="empty-state"><h3>No messages yet</h3><p>Ask your coach anything — about your plan, a missed day, or how you\'re feeling.</p></div>';
      return;
    }
    log.innerHTML = data.messages.map(m => `
      <div class="bubble-row ${m.sender === 'client' ? 'mine' : 'theirs'}">
        <div class="bubble">
          <p>${esc(m.body)}</p>
          <span class="bubble-time">${new Date(m.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
    `).join('');
    log.scrollTop = log.scrollHeight;
  } catch (err) {
    if (!quiet) log.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const errEl = document.getElementById('chat-error');
  errEl.style.display = 'none';
  const body = input.value.trim();
  if (!body) return;
  try {
    await apiRequest('/client/messages', { method: 'POST', body: { body } });
    input.value = '';
    loadMessages();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

/* ------------------------------------------------------------------ */
/* Contact us                                                          */
/* ------------------------------------------------------------------ */
async function loadContact() {
  const wrap = document.getElementById('contact-card');
  try {
    const { contact } = await apiRequest('/client/contact');
    const rows = [
      ['Coach', contact.coachName],
      ['Phone', contact.phone],
      ['WhatsApp', contact.whatsapp],
      ['Email', contact.email],
      ['UPI ID', contact.upiId],
      ['Address', contact.address],
      ['Support hours', contact.supportHours]
    ].filter(r => r[1]);

    if (!rows.length) {
      wrap.innerHTML = '<div class="empty-state"><h3>No contact details yet</h3><p>Your coach hasn\'t added them. Use “Message coach” in the meantime.</p></div>';
      return;
    }

    wrap.innerHTML = `
      <div class="card contact-card">
        ${rows.map(([k, v]) => {
          let value = esc(v);
          if (k === 'Phone' || k === 'WhatsApp') value = `<a href="tel:${esc(v.replace(/\s/g, ''))}">${esc(v)}</a>`;
          if (k === 'Email') value = `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
          return `<div class="contact-row"><span>${k}</span><strong>${value}</strong></div>`;
        }).join('')}
        ${contact.note ? `<p class="hint" style="margin-top:14px;">${esc(contact.note)}</p>` : ''}
        <div class="contact-actions">
          ${contact.whatsapp ? `<a class="btn btn-primary btn-sm" href="https://wa.me/${esc(contact.whatsapp.replace(/[^0-9]/g, ''))}" target="_blank" rel="noopener">Chat on WhatsApp</a>` : ''}
          <button class="btn btn-outline btn-sm" onclick="showView('chat')">Message in app</button>
        </div>
      </div>`;
  } catch (err) {
    wrap.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Payment + plans                                                     */
/* ------------------------------------------------------------------ */
async function loadPaymentView() {
  try {
    const [{ plans }, { contact }, payData] = await Promise.all([
      apiRequest('/client/plans'),
      apiRequest('/client/contact'),
      apiRequest('/client/payments')
    ]);
    plansCache = plans;

    const cards = document.getElementById('plan-cards');
    cards.innerHTML = plans.map(p => `
      <div class="card plan-card" onclick="pickPlan('${esc(p.key)}')">
        <div class="plan-name">${esc(p.name)}</div>
        <div class="plan-price">₹${p.priceInr.toLocaleString('en-IN')}<span> / ${p.durationDays} days</span></div>
        ${p.tagline ? `<p class="hint">${esc(p.tagline)}</p>` : ''}
        <ul class="plan-features">${(p.features || []).map(f => `<li>${esc(f)}</li>`).join('')}</ul>
        <button class="btn btn-outline btn-sm" type="button">Choose this plan</button>
      </div>
    `).join('') || '<p class="hint">Your coach hasn\'t published any plans yet.</p>';

    const select = document.getElementById('pay-tier');
    select.innerHTML = plans.map(p => `<option value="${esc(p.key)}">${esc(p.name)} — ₹${p.priceInr.toLocaleString('en-IN')}</option>`).join('');

    if (contact.upiId) {
      document.getElementById('upi-pay-to').style.display = 'block';
      document.getElementById('pay-to-value').textContent = `${contact.upiId}${contact.coachName ? ` (${contact.coachName})` : ''}`;
    }
    renderPaymentStatus(payData.payments || []);
  } catch (err) {
    document.getElementById('plan-cards').innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

function pickPlan(key) {
  document.getElementById('pay-tier').value = key;
  document.getElementById('pay-utr').focus();
}

function renderPaymentStatus(payments) {
  const wrap = document.getElementById('payment-status');
  if (!wrap) return;
  if (!payments.length) {
    wrap.innerHTML = '<div class="card notice notice-warn"><div><strong>No payment submitted yet.</strong><p>Pick a plan, pay by UPI, then enter the UTR number below.</p></div></div>';
    return;
  }
  const latest = payments[0];
  const cls = latest.status === 'approved' ? 'notice-ok' : latest.status === 'rejected' ? 'notice-bad' : 'notice-warn';
  const text = latest.status === 'approved'
    ? 'Payment approved — your cohort is unlocked.'
    : latest.status === 'rejected'
      ? `Payment rejected${latest.adminNote ? `: ${latest.adminNote}` : ''}. Submit a fresh UTR below.`
      : 'Payment submitted. Your coach is reviewing it — this usually takes a few hours.';
  wrap.innerHTML = `
    <div class="card notice ${cls}">
      <div>
        <strong>${esc(text)}</strong>
        <p>${esc(latest.planName || latest.tier)} · ₹${latest.amountInr} · UTR ${esc(latest.utr)} · ${new Date(latest.createdAt).toLocaleString()}</p>
      </div>
    </div>`;
}

async function submitPayment() {
  const successEl = document.getElementById('pay-success');
  const errorEl = document.getElementById('pay-error');
  successEl.style.display = 'none';
  errorEl.style.display = 'none';

  const tier = document.getElementById('pay-tier').value;
  const utr = document.getElementById('pay-utr').value;
  const fileInput = document.getElementById('pay-screenshot');

  const submit = async (screenshotBase64) => {
    try {
      await apiRequest('/client/payments', { method: 'POST', body: { tier, utr, screenshotBase64 } });
      successEl.textContent = 'Submitted. Your coach will review it shortly.';
      successEl.style.display = 'block';
      document.getElementById('pay-utr').value = '';
      fileInput.value = '';
      loadPaymentView();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  };

  if (fileInput.files && fileInput.files[0]) {
    const reader = new FileReader();
    reader.onload = () => submit(reader.result);
    reader.readAsDataURL(fileInput.files[0]);
  } else {
    submit(undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Protocol / leaderboard / referral                                   */
/* ------------------------------------------------------------------ */
async function loadProtocol() {
  const wrap = document.getElementById('client-protocol');
  try {
    const data = await apiRequest('/client/protocol');
    if (!data.days.length) {
      wrap.innerHTML = '<p class="hint">Your coach hasn\'t published the protocol yet.</p>';
      return;
    }
    let lastPhase = '';
    wrap.innerHTML = `
      <div class="table-scroll"><table class="table">
        <thead><tr><th>Day</th><th>Type</th><th>Eating window</th><th>Fast</th><th>Focus</th></tr></thead>
        <tbody>
          ${data.days.map(d => {
            const header = d.phase !== lastPhase ? `<tr class="phase-row"><td colspan="5">${esc(d.phase)}</td></tr>` : '';
            lastPhase = d.phase;
            return header + `
              <tr class="${d.day === data.currentDay ? 'today-row' : ''}">
                <td><strong>Day ${d.day}</strong></td>
                <td>${esc(PROTOCOL_LABELS[d.protocolType] || d.protocolType)}</td>
                <td>${d.isFullDayFast ? '—' : `${hourLabel(d.startHour)} – ${hourLabel(d.endHour)}`}</td>
                <td>${d.fastingHours}h</td>
                <td class="muted">${esc(d.focus || d.label || '')}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table></div>`;
  } catch (err) {
    wrap.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

async function loadLeaderboard() {
  try {
    const data = await apiRequest('/client/leaderboard');
    const list = document.getElementById('leaderboard-list');
    list.innerHTML = data.leaderboard.map((c, i) => `
      <div class="leaderboard-row">
        <span class="rank">${i + 1}</span>
        <span class="name">${esc(c.name)}</span>
        <span class="pts">${c.points} pts · ${c.streakCurrent}🔥 streak</span>
      </div>
    `).join('') || '<p class="hint">No active clients yet.</p>';
  } catch (err) { console.error(err); }
}

async function loadReferral() {
  try {
    const data = await apiRequest('/client/referral');
    document.getElementById('referral-code').textContent = data.referralCode;
    document.getElementById('ref-count').textContent = data.referredCount;
    document.getElementById('ref-wallet').textContent = `₹${data.walletBalanceInr}`;

    const tbody = document.querySelector('#payout-table tbody');
    tbody.innerHTML = data.payouts.map(p => `
      <tr>
        <td>${new Date(p.requestedAt).toLocaleDateString()}</td>
        <td>₹${p.amountInr}</td>
        <td><span class="badge badge-${p.status === 'paid' ? 'active' : p.status === 'rejected' ? 'rejected' : 'pending'}">${p.status}</span></td>
      </tr>
    `).join('') || '<tr><td colspan="3" class="muted">No payout requests yet</td></tr>';
  } catch (err) { console.error(err); }
}

function copyReferral() {
  const code = document.getElementById('referral-code').textContent;
  navigator.clipboard.writeText(code);
  alert('Referral code copied!');
}

async function requestPayout() {
  const msg = document.getElementById('payout-msg');
  msg.style.display = 'none';
  try {
    const upiId = document.getElementById('upi-input').value;
    await apiRequest('/client/payout-request', { method: 'POST', body: { upiId } });
    loadReferral();
    document.getElementById('upi-input').value = '';
  } catch (err) {
    msg.textContent = err.message;
    msg.style.display = 'block';
  }
}
