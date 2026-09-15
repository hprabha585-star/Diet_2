let dashboardData = null;
let timerInterval = null;
let chartMetric = 'completionPercent';
let historyCache = null;

/* ------------------------------------------------------------------ */
/* Boot + sidebar                                                      */
/* ------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', async () => {
  const user = requireRoleOrRedirect('client');
  if (!user) return;
  document.getElementById('user-chip').textContent = user.name;

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showView(link.dataset.view);
      closeSidebar();
    });
  });

  // Deep-link support: /client/dashboard.html#history
  const hash = (window.location.hash || '').replace('#', '');
  await loadDashboard();
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

  if (view === 'history') loadHistory();
  if (view === 'leaderboard') loadLeaderboard();
  if (view === 'refer') loadReferral();
  if (view === 'protocol') loadProtocol();
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */
async function loadDashboard() {
  try {
    const data = await apiRequest('/client/dashboard');
    dashboardData = data;

    if (data.status !== 'active') {
      document.getElementById('inactive-banner').style.display = 'block';
      document.getElementById('inactive-msg').textContent =
        data.status === 'pending_payment'
          ? "Your account isn't active yet — submit your payment to get started."
          : `Your account status is "${data.status}".`;
      document.getElementById('checklist-container').innerHTML =
        '<div class="empty-state"><h3>No plan yet</h3><p>Your coach will assign day 1 once your payment is approved.</p></div>';
      return;
    }

    document.getElementById('stat-day').textContent = `${data.day} / ${data.challengeLengthDays}`;
    document.getElementById('side-mini-day').textContent = `Day ${data.day} / ${data.challengeLengthDays}`;
    document.getElementById('stat-streak').textContent = data.streakCurrent;
    document.getElementById('stat-best').textContent = data.streakBest;
    document.getElementById('stat-today').textContent =
      `${data.checklist ? data.checklist.completionPercent : 0}%`;

    renderPauseState(data.fastingPause);
    renderChecklist(data.checklist);
    renderWater(data.checklist, data.regimen);
    renderTimer(data.fastingState, data.regimen);
    renderChart(data.chart || []);

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(tickTimer, 1000);
  } catch (err) {
    document.getElementById('checklist-container').innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

function tickTimer() {
  const fs = dashboardData && dashboardData.fastingState;
  if (!fs || fs.state === 'paused') return;
  fs.secondsRemaining -= 1;
  if (fs.secondsRemaining <= 0) { loadDashboard(); return; }
  const s = fs.secondsRemaining;
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  document.getElementById('timer-time').textContent = `${hh}:${mm}:${ss}`;
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

function hourLabel(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

function renderTimer(fastingState, regimen) {
  const arc = document.getElementById('timer-arc');
  const CIRC = 2 * Math.PI * 62;
  const line = document.getElementById('protocol-line');

  if (!fastingState) {
    document.getElementById('timer-state').textContent = 'No plan yet';
    document.getElementById('timer-time').textContent = '--:--:--';
    document.getElementById('timer-desc').textContent =
      "Your fasting window will appear here once your coach assigns today's plan.";
    line.textContent = '';
    arc.setAttribute('stroke-dasharray', `0 ${CIRC}`);
    return;
  }

  if (regimen) {
    const type = PROTOCOL_LABELS[regimen.protocolType] || 'Eating window';
    const window = regimen.isFullDayFast
      ? 'No eating window today — water and electrolytes only.'
      : `Eating window ${hourLabel(regimen.fastingWindow.startHour)} – ${hourLabel(regimen.fastingWindow.endHour)}`;
    line.innerHTML = `<strong>${esc(type)}</strong> · ${esc(window)}${regimen.focus ? ` · ${esc(regimen.focus)}` : ''}`;
  }

  if (fastingState.state === 'paused') {
    document.getElementById('timer-state').textContent = 'Paused';
    document.getElementById('timer-time').textContent = '❚❚';
    document.getElementById('timer-desc').textContent =
      'Your fast is paused. Eat and hydrate normally, and resume when you feel ready.';
    arc.setAttribute('stroke-dasharray', `0 ${CIRC}`);
    return;
  }

  document.getElementById('timer-state').textContent =
    fastingState.state === 'fasting' ? 'Fasting' : 'Eating window';
  document.getElementById('timer-time').textContent = fastingState.countdown;
  document.getElementById('timer-desc').textContent = fastingState.state === 'fasting'
    ? `Stay the course — your eating window opens in ${fastingState.countdown}.`
    : `You're in your eating window for another ${fastingState.countdown}.`;

  const frac = Math.max(0, Math.min(1, fastingState.secondsRemaining / 86400));
  arc.setAttribute('stroke-dasharray', `${CIRC * (1 - frac)} ${CIRC}`);
}

/* ------------------------------------------------------------------ */
/* Bar chart (replaces the old points card)                            */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* Checklist — toggle / add / edit / delete                            */
/* ------------------------------------------------------------------ */
function renderChecklist(checklist) {
  const container = document.getElementById('checklist-container');
  if (!checklist || !checklist.items || checklist.items.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>Nothing assigned yet</h3><p>Check back once your coach has set today\'s plan, or add your own habit above.</p></div>';
    return;
  }
  container.innerHTML = checklist.items.map(item => `
    <div class="checklist-item ${item.done ? 'done' : ''}">
      <input type="checkbox" ${item.done ? 'checked' : ''} onchange="toggleItem('${esc(item.key)}', this.checked)">
      <label>${esc(item.label)}${item.custom ? '<span class="tag">yours</span>' : ''}</label>
      <div class="row-actions">
        <button class="icon-btn" title="Edit" onclick="openItemModal('${esc(item.key)}', '${esc(item.label).replace(/'/g, "\\'")}')">Edit</button>
        <button class="icon-btn danger" title="Delete" onclick="deleteItem('${esc(item.key)}')">Delete</button>
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
    const data = await apiRequest(`/client/checklist/items/${encodeURIComponent(itemKey)}`, {
      method: 'PATCH', body: { done }
    });
    afterChecklistUpdate(data);
  } catch (err) { alert(err.message); }
}

function openItemModal(key = '', label = '') {
  document.getElementById('item-key').value = key;
  document.getElementById('item-label').value = label;
  document.getElementById('item-modal-title').textContent = key ? 'Edit habit' : 'Add a habit';
  document.getElementById('item-error').style.display = 'none';
  document.getElementById('item-modal').classList.add('open');
  setTimeout(() => document.getElementById('item-label').focus(), 50);
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

/* ------------------------------------------------------------------ */
/* Water — add / edit / delete                                         */
/* ------------------------------------------------------------------ */
function renderWater(checklist, regimen) {
  const target = (regimen && regimen.waterTargetMl) || 3000;
  const current = checklist ? checklist.waterMl : 0;
  const pct = Math.min(100, Math.round((current / target) * 100));
  document.getElementById('water-fill').style.width = `${pct}%`;
  document.getElementById('water-label').textContent = `${current} / ${target} ml`;

  const list = document.getElementById('water-entries');
  const entries = (checklist && checklist.waterEntries) || [];
  if (!entries.length) {
    list.innerHTML = '<p class="hint">No water logged yet.</p>';
    return;
  }
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

/* ------------------------------------------------------------------ */
/* Pause / resume fasting                                              */
/* ------------------------------------------------------------------ */
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
    const reason = select === 'other'
      ? document.getElementById('pause-reason').value.trim()
      : select;
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
    historyCache = data;

    // BMI inputs
    if (data.heightCm) document.getElementById('bmi-height').value = data.heightCm;
    if (data.goalWeightKg) document.getElementById('bmi-goal').value = data.goalWeightKg;
    const latest = data.weightLogs.length ? data.weightLogs[data.weightLogs.length - 1].weightKg : '';
    if (latest) document.getElementById('bmi-weight').value = latest;
    if (data.heightCm && latest) calculateBmi(true);

    // Weight table (newest first) with edit/delete
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
  } catch (err) {
    console.error(err);
  }
}

async function logWeight() {
  const msg = document.getElementById('weight-msg');
  try {
    const weightKg = parseFloat(document.getElementById('weight-input').value);
    if (!weightKg) return;
    await apiRequest('/client/weight', { method: 'POST', body: { weightKg } });
    msg.textContent = 'Weight saved.';
    msg.style.display = 'block';
    document.getElementById('weight-input').value = '';
    loadHistory();
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

function calculateBmi(silent) {
  const errEl = document.getElementById('bmi-error');
  const msg = document.getElementById('bmi-msg');
  errEl.style.display = 'none';
  if (!silent) msg.style.display = 'none';

  const h = parseFloat(document.getElementById('bmi-height').value);
  const w = parseFloat(document.getElementById('bmi-weight').value);
  if (!h || !w) {
    if (!silent) { errEl.textContent = 'Enter both height and weight.'; errEl.style.display = 'block'; }
    return;
  }
  const m = h / 100;
  const bmi = Math.round((w / (m * m)) * 10) / 10;
  const cat = bmiCategory(bmi);

  document.getElementById('bmi-value').textContent = bmi;
  document.getElementById('bmi-category').textContent = cat.label;
  const marker = document.getElementById('bmi-marker');
  marker.style.left = `${cat.pos}%`;
  marker.style.display = 'block';

  const goal = parseFloat(document.getElementById('bmi-goal').value);
  const note = document.getElementById('bmi-goal-note');
  if (goal) {
    const goalBmi = Math.round((goal / (m * m)) * 10) / 10;
    const diff = Math.round((w - goal) * 10) / 10;
    note.textContent = diff > 0
      ? `${diff} kg to your goal — that would put you at a BMI of ${goalBmi}.`
      : `You're at or past your goal weight (goal BMI ${goalBmi}).`;
  } else {
    note.textContent = 'BMI is a rough screen, not a diagnosis — talk to your coach or doctor about what it means for you.';
  }
}

async function saveBmiProfile() {
  const errEl = document.getElementById('bmi-error');
  const msg = document.getElementById('bmi-msg');
  errEl.style.display = 'none';
  msg.style.display = 'none';
  try {
    const heightCm = parseFloat(document.getElementById('bmi-height').value);
    const goalWeightKg = parseFloat(document.getElementById('bmi-goal').value) || undefined;
    if (!heightCm) throw new Error('Enter your height first');
    await apiRequest('/client/profile', { method: 'POST', body: { heightCm, goalWeightKg } });
    msg.textContent = 'Saved — your coach can see this too.';
    msg.style.display = 'block';
    calculateBmi(true);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

/* ------------------------------------------------------------------ */
/* Protocol (read-only)                                                */
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

/* ------------------------------------------------------------------ */
/* Leaderboard / referral / payment                                    */
/* ------------------------------------------------------------------ */
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
      successEl.textContent = 'Submitted! Your coach will review it shortly.';
      successEl.style.display = 'block';
      document.getElementById('pay-utr').value = '';
      fileInput.value = '';
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
