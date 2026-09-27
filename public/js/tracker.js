/* ============================================================
   Fasting Tracker — front end.
   Every calendar-day request carries the BROWSER's local date, so a
   fast started at 11pm IST is filed under today for the client even if
   the server is running in UTC.
   ============================================================ */
let content = null;          // static stages/education/tips/tasks
let state = null;            // live fasting state
let profile = null;
let schedulesCache = [];
let statsRange = 'week';
let calMonth = null;
let tickTimer = null;
let reminderTimer = null;
let firedReminders = {};

/* ---------------- small helpers ---------------- */
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const q = (path, params = {}) => {
  const usp = new URLSearchParams({ date: todayLocal(), ...params });
  return `${path}?${usp.toString()}`;
};
function fmtHm(hours) {
  const total = Math.max(0, Math.round((hours || 0) * 60));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}
function fmtHms(hours) {
  const s = Math.max(0, Math.round((hours || 0) * 3600));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
const fmtClock = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const toLocalInput = (d) => {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
};
const hourToTimeInput = (h) => {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};
const timeInputToHour = (v) => {
  const [h, m] = (v || '20:00').split(':').map(Number);
  return h + (m || 0) / 60;
};
const ml2unit = (ml, unit) => unit === 'oz' ? `${Math.round(ml / 29.5735)} oz` : unit === 'l' ? `${(ml / 1000).toFixed(2)} L` : `${ml} ml`;

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openSidebar() { document.getElementById('sidebar').classList.add('open'); document.getElementById('sidebar-scrim').classList.add('show'); }
function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebar-scrim').classList.remove('show'); }

/* ---------------- boot ---------------- */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  const user = requireRoleOrRedirect('client');
  if (!user) return;
  document.getElementById('user-chip').textContent = user.name;

  document.querySelectorAll('.nav-link[data-view]').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); showView(a.dataset.view); });
  });

  try {
    content = await apiRequest(q('/tracker/content'));
  } catch (err) {
    document.getElementById('locked-notice').style.display = 'flex';
    document.getElementById('locked-reason').textContent = err.message;
    return;
  }
  document.getElementById('tracker-app').style.display = 'block';

  await refreshState();
  loadToday();
  startTicking();
  if (location.hash) showView(location.hash.slice(1));
}

function showView(view) {
  const link = document.querySelector(`.nav-link[data-view="${view}"]`);
  if (!link) return;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(a => a.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  link.classList.add('active');
  document.getElementById('topbar-title').textContent = link.querySelector('span:nth-child(2)').textContent;
  closeSidebar();
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const loaders = {
    today: loadToday, fast: renderFastPage, schedule: loadSchedulePage, history: loadHistory,
    stats: loadStats, calendar: loadCalendar, nutrition: loadNutrition, water: loadWater,
    stages: renderStages, learn: renderLearn, tasks: loadTasks, settings: renderSettings
  };
  if (loaders[view]) loaders[view]();
}

async function refreshState() {
  state = await apiRequest(q('/tracker/state'));
  profile = state.profile;
  return state;
}

/* ============================================================
   TODAY
   ============================================================ */
async function loadToday() {
  const data = await apiRequest(q('/tracker/dashboard'));
  state = data.state; profile = state.profile;

  const stats = await apiRequest(q('/tracker/stats', { range: 'all' }));
  const chip = document.getElementById('streak-chip');
  chip.hidden = false;
  chip.textContent = `🔥 ${stats.currentStreak} day streak`;

  // Tip of the day (dismissible)
  const tipEl = document.getElementById('today-tip');
  const dismissed = profile.dismissedTips || [];
  if (data.tipOfDay && !dismissed.includes(data.tipOfDay)) {
    tipEl.hidden = false;
    tipEl.innerHTML = `<span>💡 ${esc(data.tipOfDay)}</span>
      <button class="btn-ghost btn-sm" onclick="dismissTip('${jsStr(data.tipOfDay)}')">Dismiss</button>`;
  } else tipEl.hidden = true;

  renderFastHero(document.getElementById('today-fast-hero'));

  document.getElementById('tile-streak').innerHTML = `
    <div class="tile-num">${stats.currentStreak}</div>
    <div class="tile-lbl">Day streak</div>
    <div class="tile-sub">Longest ${stats.longestStreak} · ${stats.daysThisWeek} this week</div>`;

  const g = state.dailyGoal;
  document.getElementById('tile-goal').innerHTML = `
    <div class="tile-num">${g.percent}%</div>
    <div class="tile-lbl">Today's goal</div>
    <div class="prog-track slim" style="margin-top:8px;"><div class="prog-fill" style="width:${g.percent}%;"></div></div>
    <div class="tile-sub">${fmtHm(g.completedHours)} of ${g.targetHours}h</div>`;

  const water = data.water;
  const waterPct = Math.min(100, Math.round((water.ml / water.goalMl) * 100));
  const nut = data.nutrition;
  const nutPct = Math.min(100, Math.round((nut.calories / nut.goal) * 100));

  document.getElementById('today-tiles').innerHTML = `
    <div class="card mini-tile" onclick="showView('nutrition')">
      <div class="mini-head">Nutrition</div>
      <div class="mini-val">${nut.calories} <span>/ ${nut.goal} kcal</span></div>
      <div class="prog-track slim"><div class="prog-fill" style="width:${nutPct}%;"></div></div>
      <div class="tile-sub">${nut.mealCount} meal${nut.mealCount === 1 ? '' : 's'} logged</div>
    </div>
    <div class="card mini-tile" onclick="showView('water')">
      <div class="mini-head">Water</div>
      <div class="mini-val">${ml2unit(water.ml, water.unit)} <span>/ ${ml2unit(water.goalMl, water.unit)}</span></div>
      <div class="prog-track slim"><div class="prog-fill journey" style="width:${waterPct}%;"></div></div>
      <div class="tile-sub">${waterPct}% of today's goal</div>
    </div>
    <div class="card mini-tile" onclick="showView('tasks')">
      <div class="mini-head">Daily tasks</div>
      <div class="mini-val">${data.tasks.completed} <span>/ ${data.tasks.total} done</span></div>
      <div class="prog-track slim"><div class="prog-fill" style="width:${Math.round((data.tasks.completed / data.tasks.total) * 100)}%;"></div></div>
      <div class="tile-sub">Small things worth doing</div>
    </div>
    ${data.weight ? `
    <div class="card mini-tile">
      <div class="mini-head">Weight</div>
      <div class="mini-val">${data.weight.currentKg} <span>kg</span></div>
      <div class="tile-sub">${data.weight.changeKg === null ? 'First entry' :
        `${data.weight.changeKg > 0 ? '+' : ''}${data.weight.changeKg} kg since last entry`}</div>
    </div>` : ''}`;

  const weekly = await apiRequest(q('/tracker/weekly'));
  document.getElementById('today-weekly').innerHTML = weeklyChartHtml(weekly);

  const tasks = await apiRequest(q('/tracker/tasks'));
  document.getElementById('today-tasks').innerHTML = tasks.tasks.map(taskRow).join('');
}

async function dismissTip(tip) {
  const dismissed = [...(profile.dismissedTips || []), tip];
  await apiRequest('/tracker/profile', { method: 'PUT', body: { dismissedTips: dismissed } });
  profile.dismissedTips = dismissed;
  document.getElementById('today-tip').hidden = true;
}

function weeklyChartHtml(w) {
  const max = Math.max(w.goalHours, ...w.days.map(d => d.hours), 1);
  return `
    <div class="week-bars">
      ${w.days.map(d => `
        <div class="week-col">
          <div class="week-val">${d.hours ? d.hours + 'h' : ''}</div>
          <div class="week-track">
            <div class="week-fill ${d.hours >= w.goalHours ? 'hit' : ''} ${d.restDay ? 'rest' : ''}"
                 style="height:${Math.round((d.hours / max) * 100)}%;"></div>
          </div>
          <div class="week-lbl">${new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })}</div>
        </div>`).join('')}
    </div>
    <div class="week-foot">
      <span>Weekly target <b>${w.weeklyTargetHours}h</b></span>
      <span>Completed <b>${w.completedHours}h</b></span>
      <span>Average <b>${w.averageHours ? fmtHm(w.averageHours) : '—'}</b></span>
      <span>Fasts <b>${w.completedFasts}</b></span>
    </div>`;
}

/* ============================================================
   CURRENT FAST
   ============================================================ */
function ringSvg(percent, centreHtml, klass = '') {
  const c = 603; // 2πr, r = 96
  const offset = c - (c * Math.min(100, Math.max(0, percent))) / 100;
  return `
    <div class="ring-wrap ${klass}">
      <svg width="240" height="240" viewBox="0 0 220 220">
        <circle cx="110" cy="110" r="96" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="13"/>
        <circle cx="110" cy="110" r="96" fill="none" stroke="var(--ember)" stroke-width="13"
                stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}"
                style="transform:rotate(-90deg);transform-origin:110px 110px;transition:stroke-dashoffset 1s linear;"/>
      </svg>
      <div class="ring-label">${centreHtml}</div>
    </div>`;
}

function renderFastHero(el) {
  if (!el) return;
  if (state.fast) {
    const f = state.fast;
    const done = f.reachedTarget;
    el.className = 'card fast-hero ' + (done ? 'is-done' : 'is-running');
    el.innerHTML = `
      <div class="fast-hero-top">
        <span class="sched-pill">${esc(f.scheduleKey)}</span>
        <span class="stage-pill">${esc(f.stage.name)}</span>
      </div>
      ${ringSvg(f.percent, `
        <div class="state">${done ? 'Target reached' : 'Fasting'}</div>
        <div class="time" id="live-countdown">${done ? fmtHm(f.elapsedHours) : fmtHms(f.remainingHours)}</div>
        <div class="sub" id="live-percent">${f.percent}% complete</div>`)}
      <div class="fast-times">
        <div><span>Started</span><b>${fmtClock(f.startAt)}</b></div>
        <div><span>Ends</span><b>${fmtClock(f.expectedEndAt)}</b></div>
        <div><span>Elapsed</span><b id="live-elapsed">${fmtHm(f.elapsedHours)}</b></div>
      </div>
      <div class="fast-actions">
        ${done ? `<button class="btn btn-primary" onclick="openEndFast()">Complete fast</button>` :
                 `<button class="btn btn-primary" onclick="openEndFast()">End fast</button>`}
        <button class="btn btn-outline btn-sm" onclick="editStartTime()">Edit start time</button>
        <button class="btn-ghost btn-sm" onclick="cancelFast()">Cancel</button>
      </div>`;
  } else if (state.eating) {
    const e = state.eating;
    el.className = 'card fast-hero is-eating';
    el.innerHTML = `
      <div class="fast-hero-top"><span class="sched-pill eating">Eating window</span></div>
      ${ringSvg(e.percent, `
        <div class="state">Eating window</div>
        <div class="time">${fmtHm(e.remainingHours)}</div>
        <div class="sub">remaining</div>`, 'green')}
      <div class="fast-times">
        <div><span>Started</span><b>${fmtClock(e.startAt)}</b></div>
        <div><span>Ends</span><b>${fmtClock(e.endsAt)}</b></div>
      </div>
      <div class="fast-actions">
        <button class="btn btn-primary" onclick="openStartFast()">Start next fast</button>
      </div>`;
  } else {
    el.className = 'card fast-hero is-idle';
    el.innerHTML = `
      ${ringSvg(0, `<div class="state">No active fast</div><div class="time">00:00:00</div><div class="sub">ready when you are</div>`)}
      <p class="empty-line">No fast is currently active.</p>
      <div class="fast-actions"><button class="btn btn-primary" onclick="openStartFast()">Start fast</button></div>`;
  }
}

function renderFastPage() {
  renderFastHero(document.getElementById('fast-panel'));
  const panel = document.getElementById('fast-stage-panel');
  const hours = state.fast ? state.fast.elapsedHours : 0;
  panel.innerHTML = `
    <div class="stage-track">
      ${content.stages.slice(0, 5).map(s => {
        const active = hours >= s.from && hours < s.to;
        const past = hours >= s.to;
        return `<div class="stage-node ${active ? 'active' : ''} ${past ? 'past' : ''}">
          <div class="stage-dot"></div>
          <div class="stage-hours">${s.from}h</div>
          <div class="stage-name">${esc(s.name)}</div>
        </div>`;
      }).join('')}
    </div>
    <p class="hint" style="margin-top:14px;">
      ${state.fast ? esc(state.fast.stage.detail) : 'Start a fast to see where you are on the timeline.'}
    </p>`;
}

/* ---- start ---- */
async function openStartFast() {
  if (state.fast) {
    if (confirm('You already have an active fast.\n\nOK = view progress, Cancel = stay here.')) showView('fast');
    return;
  }
  const data = await apiRequest(q('/tracker/schedules'));
  schedulesCache = data.schedules;
  const sel = document.getElementById('start-schedule');
  sel.innerHTML = schedulesCache.map(s =>
    `<option value="${s.key}">${esc(s.label)} — ${s.fastHours}h fast / ${s.eatHours}h eating</option>`).join('');
  sel.value = profile.scheduleKey;
  sel.onchange = syncStartFields;
  document.getElementById('start-at').value = toLocalInput(new Date());
  syncStartFields();
  document.getElementById('start-error').style.display = 'none';
  openModal('start-fast-modal');
}

function syncStartFields() {
  const key = document.getElementById('start-schedule').value;
  const s = schedulesCache.find(x => x.key === key);
  if (s && key !== 'custom') {
    document.getElementById('start-target').value = s.fastHours;
    document.getElementById('start-eating').value = s.eatHours;
  } else if (key === 'custom') {
    document.getElementById('start-target').value = profile.fastHours;
    document.getElementById('start-eating').value = profile.eatHours;
  }
  updateStartPreview();
  document.getElementById('start-at').oninput = updateStartPreview;
  document.getElementById('start-target').oninput = updateStartPreview;
  document.getElementById('start-eating').oninput = updateStartPreview;
}

function updateStartPreview() {
  const startAt = new Date(document.getElementById('start-at').value);
  const target = parseFloat(document.getElementById('start-target').value) || 0;
  const eat = parseFloat(document.getElementById('start-eating').value) || 0;
  if (isNaN(startAt) || !target) return;
  const end = new Date(startAt.getTime() + target * 3600000);
  const eatEnd = new Date(end.getTime() + eat * 3600000);
  document.getElementById('start-confirm-block').innerHTML = `
    <div class="confirm-row"><span>Schedule</span><b>${esc(document.getElementById('start-schedule').value)}</b></div>
    <div class="confirm-row"><span>Starts</span><b>${startAt.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</b></div>
    <div class="confirm-row"><span>Fast completes</span><b>${end.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</b></div>
    <div class="confirm-row"><span>Eating window ends</span><b>${eatEnd.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</b></div>`;
}

async function confirmStartFast() {
  const errEl = document.getElementById('start-error');
  errEl.style.display = 'none';
  try {
    const startAt = new Date(document.getElementById('start-at').value);
    const body = {
      scheduleKey: document.getElementById('start-schedule').value,
      targetHours: parseFloat(document.getElementById('start-target').value),
      eatingHours: parseFloat(document.getElementById('start-eating').value),
      startAt: startAt.toISOString(),
      date: todayLocal()
    };
    const res = await apiRequest('/tracker/start', { method: 'POST', body });
    state = res.state; profile = state.profile;
    firedReminders = {};
    closeModal('start-fast-modal');
    showView('fast');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

async function editStartTime() {
  if (!state.fast) return;
  const val = prompt('When did this fast actually start? (YYYY-MM-DD HH:MM)',
    toLocalInput(state.fast.startAt).replace('T', ' '));
  if (!val) return;
  const d = new Date(val.replace(' ', 'T'));
  if (isNaN(d)) return alert('Could not read that time.');
  try {
    const res = await apiRequest(`/tracker/session/${state.fast.id}`, {
      method: 'PATCH', body: { startAt: d.toISOString(), date: todayLocal() }
    });
    state = res.state;
    renderFastPage();
  } catch (err) { alert(err.message); }
}

/* ---- end ---- */
function openEndFast() {
  const f = state.fast;
  if (!f) return;
  document.getElementById('end-summary').innerHTML = `
    <div class="confirm-row"><span>Target</span><b>${f.targetHours} hours</b></div>
    <div class="confirm-row"><span>Actual so far</span><b>${fmtHm(f.elapsedHours)}</b></div>
    <div class="confirm-row"><span>Progress</span><b>${f.percent}%</b></div>
    <div class="confirm-row"><span>Status if ended now</span>
      <b class="${f.reachedTarget ? 'ok' : 'warn'}">${f.reachedTarget ? 'Completed' : 'Ended early'}</b></div>`;
  document.getElementById('end-note').value = '';
  openModal('end-fast-modal');
}

async function confirmEndFast() {
  try {
    const res = await apiRequest('/tracker/end', {
      method: 'POST',
      body: {
        note: document.getElementById('end-note').value,
        startEatingWindow: document.getElementById('end-start-eating').checked,
        date: todayLocal()
      }
    });
    state = res.state; profile = state.profile;
    closeModal('end-fast-modal');
    const s = res.summary;
    showToast(s.status === 'completed'
      ? `Fast completed — ${fmtHm(s.actualHours)}. Nice consistency.`
      : `Logged ${fmtHm(s.actualHours)} of a ${s.targetHours}h target. Every session counts.`);
    showView('fast');
  } catch (err) { alert(err.message); }
}

async function cancelFast() {
  if (!confirm('Cancel this fast? It will be recorded as cancelled and left out of your averages.')) return;
  try {
    const res = await apiRequest('/tracker/cancel', { method: 'POST', body: { date: todayLocal() } });
    state = res.state;
    renderFastPage();
  } catch (err) { alert(err.message); }
}

/* ---- live ticking + in-app reminders ---- */
function startTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (!state || !state.fast) return;
    const f = state.fast;
    const elapsed = (Date.now() - new Date(f.startAt)) / 3600000;
    const remaining = Math.max(0, f.targetHours - elapsed);
    const percent = Math.min(100, Math.round((elapsed / f.targetHours) * 100));
    const cd = document.getElementById('live-countdown');
    if (cd) cd.textContent = remaining > 0 ? fmtHms(remaining) : fmtHm(elapsed);
    const pc = document.getElementById('live-percent');
    if (pc) pc.textContent = `${percent}% complete`;
    const el = document.getElementById('live-elapsed');
    if (el) el.textContent = fmtHm(elapsed);
    checkReminders(elapsed, remaining);
    // Re-pull once when the target is first crossed so the UI switches state.
    if (remaining === 0 && !f.reachedTarget) { f.reachedTarget = true; refreshState().then(renderFastPage); }
  }, 1000);

  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(checkWaterReminder, 60000);
}

function notify(text) {
  showToast(text);
  if (window.Notification && Notification.permission === 'granted') {
    try { new Notification('FastCoach', { body: text }); } catch (e) { /* ignore */ }
  }
}

function checkReminders(elapsed, remaining) {
  const r = (profile && profile.reminders) || {};
  if (r.fastEndingSoon && r.fastEndingSoon.enabled && !firedReminders.endingSoon) {
    if (remaining > 0 && remaining * 60 <= (r.fastEndingSoon.minutesBefore || 30)) {
      firedReminders.endingSoon = true;
      notify('Your fasting goal is almost complete.');
    }
  }
  if (r.fastCompleted && r.fastCompleted.enabled && !firedReminders.completed && remaining === 0) {
    firedReminders.completed = true;
    notify('Your fasting goal has been reached.');
  }
  if (state.eating && r.eatingEnding && r.eatingEnding.enabled && !firedReminders.eatingEnd) {
    if (state.eating.remainingHours * 60 <= (r.eatingEnding.minutesBefore || 30)) {
      firedReminders.eatingEnd = true;
      notify('Your eating window is ending soon.');
    }
  }
}

function checkWaterReminder() {
  const r = profile && profile.reminders && profile.reminders.water;
  if (!r || !r.enabled) return;
  const now = new Date();
  const hour = now.getHours();
  if (hour < (r.fromHour ?? 8) || hour >= (r.toHour ?? 22)) return;
  const slot = Math.floor(hour / (r.everyHours || 2));
  const key = `${todayLocal()}-${slot}`;
  if (firedReminders.waterSlot === key) return;
  firedReminders.waterSlot = key;
  notify('Time for some water.');
}

function showToast(msg) {
  let el = document.getElementById('tracker-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tracker-toast';
    el.className = 'points-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ============================================================
   SCHEDULE
   ============================================================ */
async function loadSchedulePage() {
  document.getElementById('sched-start-time').value = hourToTimeInput(profile.startHour);
  await reloadSchedules();
  renderCustomSchedule();
  renderWeeklyEditor();
}

async function reloadSchedules() {
  const startHour = timeInputToHour(document.getElementById('sched-start-time').value);
  const data = await apiRequest(q('/tracker/schedules', { startHour }));
  schedulesCache = data.schedules;
  document.getElementById('schedule-grid').innerHTML = data.schedules
    .filter(s => s.key !== 'custom')
    .map(s => `
      <div class="sched-card ${s.key === profile.scheduleKey ? 'selected' : ''}" onclick="selectSchedule('${s.key}')">
        <div class="sched-top">
          <div class="sched-key">${esc(s.label)}</div>
          <span class="sched-level">${esc(s.level)}</span>
        </div>
        <p class="sched-blurb">${esc(s.blurb)}</p>
        <div class="sched-rows">
          <div><span>Fasting</span><b>${s.fastHours} h</b></div>
          <div><span>Eating window</span><b>${s.eatHours} h</b></div>
          <div><span>Suggested start</span><b>${s.suggestedStart}</b></div>
          <div><span>Fast completes</span><b>${s.fastEndsAt}</b></div>
          <div><span>Eating ends</span><b>${s.eatingEndsAt}</b></div>
        </div>
        <div class="sched-foot">${s.key === profile.scheduleKey ? '✓ Your schedule' : 'Choose this'}</div>
      </div>`).join('');
}

async function selectSchedule(key) {
  const s = schedulesCache.find(x => x.key === key);
  await saveProfile({
    scheduleKey: key, fastHours: s.fastHours, eatHours: s.eatHours,
    startHour: timeInputToHour(document.getElementById('sched-start-time').value)
  });
  reloadSchedules();
  showToast(`Schedule set to ${s.label}.`);
}

function renderCustomSchedule() {
  document.getElementById('custom-schedule-card').innerHTML = `
    <h3>Custom schedule</h3>
    <p class="hint" style="margin-top:4px;">Set your own hours. The end times update as you type.</p>
    <div class="custom-row">
      <div class="field"><label>Fasting hours</label><input type="number" id="cs-fast" step="0.5" min="1" max="23" value="${profile.fastHours}" oninput="previewCustom()"></div>
      <div class="field"><label>Eating hours</label><input type="number" id="cs-eat" step="0.5" min="1" max="23" value="${profile.eatHours}" oninput="previewCustom()"></div>
      <div class="field"><label>Start time</label><input type="time" id="cs-start" value="${hourToTimeInput(profile.startHour)}" oninput="previewCustom()"></div>
    </div>
    <div class="custom-preview" id="cs-preview"></div>
    <button class="btn btn-primary btn-sm" onclick="saveCustomSchedule()">Use this schedule</button>`;
  previewCustom();
}

function previewCustom() {
  const fast = parseFloat(document.getElementById('cs-fast').value) || 0;
  const eat = parseFloat(document.getElementById('cs-eat').value) || 0;
  const start = timeInputToHour(document.getElementById('cs-start').value);
  const fmt = (h) => { const t = ((h % 24) + 24) % 24; const hh = Math.floor(t); return `${String(hh).padStart(2, '0')}:${String(Math.round((t - hh) * 60)).padStart(2, '0')}`; };
  const over = fast + eat > 24;
  document.getElementById('cs-preview').innerHTML = `
    <div class="confirm-row"><span>Fast completes at</span><b>${fmt(start + fast)}</b></div>
    <div class="confirm-row"><span>Eating window ends at</span><b>${fmt(start + fast + eat)}</b></div>
    ${over ? '<p class="error-text">Fasting plus eating hours cannot exceed 24.</p>' : ''}`;
}

async function saveCustomSchedule() {
  const fastHours = parseFloat(document.getElementById('cs-fast').value);
  const eatHours = parseFloat(document.getElementById('cs-eat').value);
  if (fastHours + eatHours > 24) return alert('Fasting plus eating hours cannot exceed 24.');
  await saveProfile({ scheduleKey: 'custom', fastHours, eatHours, startHour: timeInputToHour(document.getElementById('cs-start').value) });
  reloadSchedules();
  showToast('Custom schedule saved.');
}

const WEEK_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEK_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

function renderWeeklyEditor() {
  const ws = profile.weeklySchedule || {};
  const options = content.schedules.filter(s => s.key !== 'custom');
  document.getElementById('weekly-editor').innerHTML = `
    ${WEEK_KEYS.map(k => {
      const d = ws[k] || {};
      return `<div class="week-row">
        <div class="week-day">${WEEK_NAMES[k]}</div>
        <select id="ws-${k}" ${d.rest ? 'disabled' : ''}>
          ${options.map(o => `<option value="${o.key}" ${d.scheduleKey === o.key ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
        <label class="check-line"><input type="checkbox" id="wsr-${k}" ${d.rest ? 'checked' : ''}
          onchange="document.getElementById('ws-${k}').disabled = this.checked"> Rest day</label>
      </div>`;
    }).join('')}
    <button class="btn btn-primary btn-sm" style="margin-top:12px;" onclick="saveWeekly()">Save weekly plan</button>
    <p class="hint" style="margin-top:8px;">This is your intended routine — it pre-selects the schedule when you start a fast on that day. Nothing starts automatically.</p>`;
}

async function saveWeekly() {
  const ws = {};
  for (const k of WEEK_KEYS) {
    ws[k] = { scheduleKey: document.getElementById(`ws-${k}`).value, rest: document.getElementById(`wsr-${k}`).checked };
  }
  await saveProfile({ weeklySchedule: ws });
  showToast('Weekly plan saved.');
}

async function saveProfile(patch) {
  const res = await apiRequest('/tracker/profile', { method: 'PUT', body: patch });
  profile = res.profile;
  if (state) state.profile = profile;
  return profile;
}

/* ============================================================
   HISTORY
   ============================================================ */
const STATUS_LABEL = { completed: 'Completed', ended_early: 'Ended early', cancelled: 'Cancelled' };

async function loadHistory() {
  const data = await apiRequest(q('/tracker/history'));
  const el = document.getElementById('history-list');
  if (!data.sessions.length) {
    el.innerHTML = emptyState('No fasting history yet', 'Complete your first fast to start building your history.', 'Start fast', 'openStartFast()');
    return;
  }
  el.innerHTML = data.sessions.map(s => `
    <div class="card hist-row">
      <div class="hist-date">
        <div class="d">${new Date(s.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
        <div class="y">${new Date(s.date + 'T00:00:00').getFullYear()}</div>
      </div>
      <div class="hist-main">
        <div class="hist-dur">${fmtHm(s.actualHours)} <span>/ target ${s.targetHours}h</span></div>
        <div class="hist-times">${fmtClock(s.startAt)} → ${s.endAt ? fmtClock(s.endAt) : '—'} · ${esc(s.scheduleKey || '')}</div>
        ${s.note ? `<div class="hist-note">${esc(s.note)}</div>` : ''}
      </div>
      <div class="hist-right">
        <span class="status-pill ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
        <div class="hist-pct">${s.percent}%</div>
        <button class="btn-ghost btn-sm" onclick="deleteSession(${s.id})">Delete</button>
      </div>
    </div>`).join('');
}

async function deleteSession(id) {
  if (!confirm('Delete this session from your history?')) return;
  await apiRequest(`/tracker/history/${id}`, { method: 'DELETE' });
  loadHistory();
}

function emptyState(title, body, cta, onclick) {
  return `<div class="card empty-state">
    <div class="empty-mark">◔</div>
    <h3>${esc(title)}</h3>
    <p>${esc(body)}</p>
    ${cta ? `<button class="btn btn-primary btn-sm" onclick="${onclick}">${esc(cta)}</button>` : ''}
  </div>`;
}

/* ============================================================
   STATISTICS
   ============================================================ */
function setStatsRange(range) {
  statsRange = range;
  document.querySelectorAll('.range-tab').forEach(t => t.classList.toggle('active', t.dataset.range === range));
  loadStats();
}

async function loadStats() {
  const s = await apiRequest(q('/tracker/stats', { range: statsRange }));
  document.getElementById('stats-grid').innerHTML = [
    ['Total fasts', s.totalFasts, ''],
    ['Completed', s.completedFasts, `${s.completionRate}% completion rate`],
    ['Average', s.averageHours ? fmtHm(s.averageHours) : '—', ''],
    ['Longest', s.longestHours ? fmtHm(s.longestHours) : '—', ''],
    ['Shortest', s.shortestHours ? fmtHm(s.shortestHours) : '—', ''],
    ['Total hours', `${s.totalHours}h`, ''],
    ['Current streak', `${s.currentStreak}`, `Longest ${s.longestStreak}`],
    ['Rest days', s.restDays, 'Planned, not missed']
  ].map(([lbl, val, sub]) => `
    <div class="card mini-tile">
      <div class="mini-head">${lbl}</div>
      <div class="mini-val">${val}</div>
      ${sub ? `<div class="tile-sub">${sub}</div>` : ''}
    </div>`).join('');

  const weekly = await apiRequest(q('/tracker/weekly'));
  document.getElementById('stats-weekly').innerHTML = weeklyChartHtml(weekly);
}

/* ============================================================
   CALENDAR
   ============================================================ */
function shiftMonth(delta) {
  const [y, m] = calMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  loadCalendar();
}

async function loadCalendar() {
  if (!calMonth) calMonth = todayLocal().slice(0, 7);
  const data = await apiRequest(q('/tracker/calendar', { month: calMonth }));
  const byDate = {};
  data.days.forEach(d => { byDate[d.date] = d; });

  const [y, m] = calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Monday-first

  document.getElementById('cal-title').textContent =
    first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  let cells = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => `<div class="cal-head-cell">${d}</div>`).join('');
  cells += Array(lead).fill('<div class="cal-cell empty"></div>').join('');
  for (let i = 1; i <= daysInMonth; i++) {
    const key = `${calMonth}-${String(i).padStart(2, '0')}`;
    const d = byDate[key];
    const status = d ? (d.restDay && d.status === 'none' ? 'rest' : d.status) : 'none';
    cells += `<div class="cal-cell ${status} ${key === todayLocal() ? 'today' : ''}" onclick="showCalDay('${key}')">
      <div class="cal-num">${i}</div>
      ${d && d.hours ? `<div class="cal-hours">${d.hours}h</div>` : ''}
    </div>`;
  }
  document.getElementById('cal-grid').innerHTML = cells;
  window._calData = byDate;
  document.getElementById('cal-detail').innerHTML = '<p class="hint">Pick a day to see its detail.</p>';
}

function showCalDay(key) {
  const d = (window._calData || {})[key];
  const el = document.getElementById('cal-detail');
  const restBtn = `<button class="btn btn-outline btn-sm" onclick="toggleRestDay('${key}')">
    ${d && (d.status === 'rest' || d.restDay) ? 'Remove rest day' : 'Mark as rest day'}</button>`;
  if (!d || (!d.sessions.length && d.status !== 'rest')) {
    el.innerHTML = `<h3>${fmtDay(key)}</h3><p class="hint" style="margin:8px 0 12px;">No fasting session on this day.</p>${restBtn}`;
    return;
  }
  el.innerHTML = `
    <h3>${fmtDay(key)}</h3>
    ${d.status === 'rest' || d.restDay ? '<p class="hint" style="margin-top:6px;">Marked as a rest day — it does not count against your streak.</p>' : ''}
    <div style="margin-top:12px;">
      ${d.sessions.map(s => `
        <div class="confirm-row">
          <span>${fmtClock(s.startAt)} → ${s.endAt ? fmtClock(s.endAt) : 'running'}</span>
          <b>${fmtHm(s.actualHours)} / ${s.targetHours}h
            <span class="status-pill ${s.status}">${STATUS_LABEL[s.status] || s.status}</span></b>
        </div>`).join('')}
    </div>
    <div style="margin-top:12px;">${restBtn}</div>`;
}

async function toggleRestDay(date) {
  await apiRequest('/tracker/rest-day', { method: 'POST', body: { date } });
  await loadCalendar();
  showCalDay(date);
}

/* ============================================================
   NUTRITION
   ============================================================ */
const CAT_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };

async function loadNutrition() {
  const data = await apiRequest(q('/tracker/nutrition'));
  document.getElementById('nutrition-date-label').textContent = fmtDay(data.date);

  const bar = (label, value, goal, unit) => {
    const pct = goal ? Math.min(100, Math.round((value / goal) * 100)) : 0;
    return `<div class="macro-row">
      <div class="macro-head"><span>${label}</span><b>${value}${unit} <span class="muted">/ ${goal}${unit}</span></b></div>
      <div class="prog-track slim"><div class="prog-fill ${label === 'Calories' ? '' : 'journey'}" style="width:${pct}%;"></div></div>
    </div>`;
  };
  document.getElementById('macro-card').innerHTML =
    bar('Calories', Math.round(data.totals.calories), data.goals.calories, ' kcal') +
    bar('Protein', data.totals.proteinG, data.goals.proteinG, ' g') +
    bar('Carbohydrates', data.totals.carbsG, data.goals.carbsG, ' g') +
    bar('Fat', data.totals.fatG, data.goals.fatG, ' g') +
    `<p class="hint" style="margin-top:10px;">Goals are yours to set — change them in Settings.</p>`;

  const el = document.getElementById('meals-by-category');
  const anyMeal = data.meals.length > 0;
  if (!anyMeal) {
    el.innerHTML = emptyState('No meals logged yet', 'Log what you eat in your window to see your daily totals.', 'Log a meal', "openMealModal('breakfast')");
    return;
  }
  el.innerHTML = ['breakfast', 'lunch', 'dinner', 'snack'].map(c => {
    const g = data.byCategory[c];
    if (!g.items.length) return '';
    return `<div class="card meal-group">
      <div class="meal-group-head">
        <h3>${CAT_LABEL[c]}</h3>
        <span class="meal-total">${g.calories} kcal</span>
      </div>
      ${g.items.map(m => `
        <div class="meal-line">
          <div>
            <div class="meal-name">${esc(m.name)}${m.quantity ? ` <span class="muted">· ${esc(m.quantity)}</span>` : ''}</div>
            <div class="meal-macros">${Math.round(m.calories)} kcal · P ${m.proteinG}g · C ${m.carbsG}g · F ${m.fatG}g</div>
          </div>
          <button class="btn-ghost btn-sm" onclick="deleteMeal(${m.id})">Remove</button>
        </div>`).join('')}
    </div>`;
  }).join('');
}

function openMealModal(category) {
  document.getElementById('meal-category').value = category;
  document.getElementById('meal-modal-title').textContent = `Log ${CAT_LABEL[category].toLowerCase()}`;
  ['meal-name', 'meal-qty', 'meal-cal', 'meal-pro', 'meal-carb', 'meal-fat', 'meal-notes']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('meal-error').style.display = 'none';
  openModal('meal-modal');
}

async function submitMeal() {
  const errEl = document.getElementById('meal-error');
  try {
    const name = document.getElementById('meal-name').value.trim();
    if (!name) throw new Error('Enter what you ate.');
    await apiRequest('/tracker/meals', {
      method: 'POST',
      body: {
        date: todayLocal(),
        category: document.getElementById('meal-category').value,
        name,
        quantity: document.getElementById('meal-qty').value,
        calories: document.getElementById('meal-cal').value,
        proteinG: document.getElementById('meal-pro').value,
        carbsG: document.getElementById('meal-carb').value,
        fatG: document.getElementById('meal-fat').value,
        notes: document.getElementById('meal-notes').value
      }
    });
    closeModal('meal-modal');
    loadNutrition();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

async function deleteMeal(id) {
  await apiRequest(`/tracker/meals/${id}`, { method: 'DELETE' });
  loadNutrition();
}

/* ============================================================
   WATER
   ============================================================ */
async function loadWater() {
  const d = await apiRequest(q('/tracker/water'));
  const unit = d.unit;
  const adds = unit === 'oz' ? [236, 355, 473] : [250, 500, 750];
  const c = 239; // 2πr, r = 38
  const offset = c - (c * d.percent) / 100;

  document.getElementById('water-card').innerHTML = `
    <div class="water-main">
      <div class="ring-wrap small">
        <svg width="120" height="120" viewBox="0 0 90 90">
          <circle cx="45" cy="45" r="38" fill="none" stroke="var(--line)" stroke-width="9"/>
          <circle cx="45" cy="45" r="38" fill="none" stroke="var(--forest)" stroke-width="9" stroke-linecap="round"
                  stroke-dasharray="${c}" stroke-dashoffset="${offset}"
                  style="transform:rotate(-90deg);transform-origin:45px 45px;transition:stroke-dashoffset .4s ease;"/>
        </svg>
        <div class="ring-label"><div class="time" style="font-size:17px;">${d.percent}%</div></div>
      </div>
      <div class="water-numbers">
        <div class="water-big">${ml2unit(d.todayMl, unit)} <span>/ ${ml2unit(d.goalMl, unit)}</span></div>
        <div class="tile-sub">${ml2unit(d.remainingMl, unit)} to go</div>
        <div class="water-btns">
          ${adds.map(ml => `<button class="btn btn-outline btn-sm" onclick="addWater(${ml})">+ ${ml2unit(ml, unit)}</button>`).join('')}
          <button class="btn-ghost btn-sm" onclick="addWater(-${adds[0]})">−</button>
        </div>
      </div>
    </div>
    ${d.todayEntries.length ? `<div class="water-entries">
      ${d.todayEntries.map(e => `<span class="water-chip">${e.ml > 0 ? '+' : ''}${e.ml} ml · ${fmtClock(e.at)}
        <button onclick="removeWater(${e.id})">×</button></span>`).join('')}
    </div>` : `<p class="hint" style="margin-top:12px;">Start tracking your hydration.</p>`}`;

  const max = Math.max(d.goalMl, ...d.last7.map(x => x.ml), 1);
  document.getElementById('water-history').innerHTML = `
    <div class="week-bars">
      ${d.last7.map(x => `
        <div class="week-col">
          <div class="week-val">${x.ml ? Math.round(x.ml / 100) / 10 + 'L' : ''}</div>
          <div class="week-track"><div class="week-fill water ${x.ml >= d.goalMl ? 'hit' : ''}" style="height:${Math.round((x.ml / max) * 100)}%;"></div></div>
          <div class="week-lbl">${new Date(x.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })}</div>
        </div>`).join('')}
    </div>
    <div class="week-foot">
      <span>Today <b>${ml2unit(d.todayMl, unit)}</b></span>
      <span>Yesterday <b>${ml2unit(d.yesterdayMl, unit)}</b></span>
      <span>Weekly average <b>${ml2unit(d.weeklyAverageMl, unit)}</b></span>
      <span>Best day <b>${d.bestDay ? `${ml2unit(d.bestDay.ml, unit)} (${fmtDay(d.bestDay.date)})` : '—'}</b></span>
    </div>`;

  renderWaterReminders();
}

function renderWaterReminders() {
  const r = (profile.reminders && profile.reminders.water) || {};
  document.getElementById('water-reminders').innerHTML = `
    <label class="check-line"><input type="checkbox" id="wr-on" ${r.enabled ? 'checked' : ''}> Remind me to drink water</label>
    <div class="custom-row" style="margin-top:12px;">
      <div class="field"><label>Every</label>
        <select id="wr-every">
          ${[1, 2, 3].map(h => `<option value="${h}" ${r.everyHours === h ? 'selected' : ''}>${h} hour${h > 1 ? 's' : ''}</option>`).join('')}
          <option value="4" ${r.everyHours === 4 ? 'selected' : ''}>Custom — 4 hours</option>
        </select>
      </div>
      <div class="field"><label>From</label><input type="time" id="wr-from" value="${hourToTimeInput(r.fromHour ?? 8)}"></div>
      <div class="field"><label>Until</label><input type="time" id="wr-to" value="${hourToTimeInput(r.toHour ?? 22)}"></div>
    </div>
    <button class="btn btn-primary btn-sm" onclick="saveWaterReminders()">Save reminders</button>
    <p class="hint" style="margin-top:10px;">Reminders appear while FastCoach is open in a browser tab. Allow notifications to get them as system alerts too.</p>`;
}

async function saveWaterReminders() {
  const reminders = Object.assign({}, profile.reminders, {
    water: {
      enabled: document.getElementById('wr-on').checked,
      everyHours: parseInt(document.getElementById('wr-every').value, 10),
      fromHour: Math.floor(timeInputToHour(document.getElementById('wr-from').value)),
      toHour: Math.floor(timeInputToHour(document.getElementById('wr-to').value))
    }
  });
  await saveProfile({ reminders });
  if (reminders.water.enabled) requestNotifications();
  showToast('Reminder settings saved.');
}

function requestNotifications() {
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
}

async function addWater(ml) {
  await apiRequest('/tracker/water', { method: 'POST', body: { ml, date: todayLocal() } });
  loadWater();
}
async function removeWater(id) {
  await apiRequest(`/tracker/water/${id}`, { method: 'DELETE' });
  loadWater();
}

/* ============================================================
   STAGES / EDUCATION / TASKS
   ============================================================ */
function renderStages() {
  const hours = state.fast ? state.fast.elapsedHours : null;
  document.getElementById('stages-list').innerHTML = content.stages.map(s => {
    const active = hours !== null && hours >= s.from && hours < s.to;
    return `<div class="card stage-card ${active ? 'active' : ''}">
      <div class="stage-range">${s.from}${s.to > 100 ? '+' : `–${s.to}`} hours</div>
      <h3>${esc(s.name)}${active ? ' <span class="badge badge-active">You are here</span>' : ''}</h3>
      <p class="stage-short">${esc(s.short)}</p>
      <p class="hint">${esc(s.detail)}</p>
    </div>`;
  }).join('');
}

function renderLearn() {
  document.getElementById('learn-index').innerHTML = content.education.map(t => `
    <button class="learn-card" onclick="openArticle('${t.key}')">
      <div class="learn-title">${esc(t.title)}</div>
      <div class="learn-meta">${t.minutes} min read</div>
    </button>`).join('');
  document.getElementById('learn-article').style.display = 'none';
  document.getElementById('learn-index').style.display = 'grid';
  document.getElementById('safety-card').innerHTML = `
    <h3>Safety</h3>
    <p class="stage-short">${esc(content.safety.headline)}</p>
    <ul class="safety-list">${content.safety.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
}

function openArticle(key) {
  const t = content.education.find(x => x.key === key);
  if (!t) return;
  document.getElementById('learn-index').style.display = 'none';
  const el = document.getElementById('learn-article');
  el.style.display = 'block';
  el.innerHTML = `
    <button class="btn-ghost btn-sm" onclick="renderLearn()">‹ All topics</button>
    <h2 style="margin-top:10px;">${esc(t.title)}</h2>
    <div class="learn-meta" style="margin-bottom:14px;">${t.minutes} min read</div>
    ${t.body.map(p => `<p class="article-p">${esc(p)}</p>`).join('')}`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadTasks() {
  const data = await apiRequest(q('/tracker/tasks'));
  document.getElementById('tasks-list').innerHTML =
    `<div class="tasks-head">${data.completed} of ${data.total} completed today</div>` +
    data.tasks.map(taskRow).join('');
  document.getElementById('tips-card').innerHTML = `
    <p class="stage-short">💡 ${esc(content.tipOfDay)}</p>
    <div class="tip-list">${content.tips.map(t => `<div class="tip-line">${esc(t)}</div>`).join('')}</div>`;
}

function taskRow(t) {
  return `<div class="task-row ${t.done ? 'done' : ''}">
    <label class="chk-label">
      <input type="checkbox" ${t.done ? 'checked' : ''} onchange="toggleTask('${t.key}')">
      <span>
        <b>${esc(t.title)}</b>
        <span class="task-desc">${esc(t.description)}</span>
      </span>
    </label>
    ${t.minutes ? `<span class="task-mins">${t.minutes} min</span>` : ''}
    ${t.link ? `<button class="btn-ghost btn-sm" onclick="showView('learn');openArticle('${t.link}')">Read</button>` : ''}
  </div>`;
}

async function toggleTask(key) {
  await apiRequest(`/tracker/tasks/${key}`, { method: 'POST', body: { date: todayLocal() } });
  loadTasks();
}

/* ============================================================
   SETTINGS
   ============================================================ */
function renderSettings() {
  const r = profile.reminders || {};
  const toggle = (id, on, label) =>
    `<label class="check-line"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;

  document.getElementById('settings-card').innerHTML = `
    <h3>Fasting</h3>
    <div class="custom-row">
      <div class="field"><label>Default schedule</label>
        <select id="set-schedule">${content.schedules.map(s => `<option value="${s.key}" ${profile.scheduleKey === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Default start time</label><input type="time" id="set-start" value="${hourToTimeInput(profile.startHour)}"></div>
      <div class="field"><label>Daily fasting goal (hours)</label><input type="number" id="set-goal" step="0.5" min="1" max="24" value="${profile.dailyGoalHours}"></div>
    </div>
    <div class="custom-row">
      <div class="field"><label>Default fasting hours</label><input type="number" id="set-fast" step="0.5" value="${profile.fastHours}"></div>
      <div class="field"><label>Default eating hours</label><input type="number" id="set-eat" step="0.5" value="${profile.eatHours}"></div>
      <div class="field"><label>Personal goal</label>
        <select id="set-focus">${content.goalOptions.map(g => `<option ${profile.goalFocus === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
      </div>
    </div>

    <h3 style="margin-top:22px;">Hydration</h3>
    <div class="custom-row">
      <div class="field"><label>Daily water goal (ml)</label><input type="number" id="set-water" step="100" value="${profile.waterGoalMl}"></div>
      <div class="field"><label>Units</label>
        <select id="set-unit">
          <option value="ml" ${profile.waterUnit === 'ml' ? 'selected' : ''}>Millilitres (ml)</option>
          <option value="oz" ${profile.waterUnit === 'oz' ? 'selected' : ''}>Ounces (oz)</option>
          <option value="l" ${profile.waterUnit === 'l' ? 'selected' : ''}>Litres (L)</option>
        </select>
      </div>
    </div>

    <h3 style="margin-top:22px;">Nutrition goals</h3>
    <div class="custom-row">
      <div class="field"><label>Calories</label><input type="number" id="set-cal" value="${profile.calorieGoal}"></div>
      <div class="field"><label>Protein (g)</label><input type="number" id="set-pro" value="${profile.proteinGoalG}"></div>
      <div class="field"><label>Carbs (g)</label><input type="number" id="set-carb" value="${profile.carbGoalG}"></div>
      <div class="field"><label>Fat (g)</label><input type="number" id="set-fat" value="${profile.fatGoalG}"></div>
    </div>

    <h3 style="margin-top:22px;">Reminders</h3>
    ${toggle('set-r-start', r.fastStart && r.fastStart.enabled, 'Fast starting')}
    ${toggle('set-r-soon', r.fastEndingSoon && r.fastEndingSoon.enabled, 'Fast ending soon')}
    ${toggle('set-r-done', r.fastCompleted && r.fastCompleted.enabled, 'Fast completed')}
    ${toggle('set-r-eat', r.eatingEnding && r.eatingEnding.enabled, 'Eating window ending')}
    ${toggle('set-r-water', r.water && r.water.enabled, 'Water reminders')}
    <p class="hint" style="margin-top:8px;">Reminders fire while the app is open in a tab. FastCoach has no push-notification server, so it cannot wake your phone when the app is closed.</p>

    <h3 style="margin-top:22px;">Schedule</h3>
    ${toggle('set-paused', profile.schedulePaused, 'Pause my schedule (stop suggesting fasts)')}

    <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" onclick="saveSettings()">Save settings</button>
      <button class="btn btn-outline btn-sm" onclick="requestNotifications()">Enable browser notifications</button>
    </div>

    <div class="safety-inline">
      <strong>${esc(content.safety.headline)}</strong>
      <p>${esc(content.safety.points[0])}</p>
    </div>`;
}

async function saveSettings() {
  const reminders = {
    water: Object.assign({ everyHours: 2, fromHour: 8, toHour: 22 }, (profile.reminders || {}).water, { enabled: document.getElementById('set-r-water').checked }),
    fastStart: { enabled: document.getElementById('set-r-start').checked },
    fastEndingSoon: { enabled: document.getElementById('set-r-soon').checked, minutesBefore: 30 },
    fastCompleted: { enabled: document.getElementById('set-r-done').checked },
    eatingEnding: { enabled: document.getElementById('set-r-eat').checked, minutesBefore: 30 }
  };
  try {
    await saveProfile({
      scheduleKey: document.getElementById('set-schedule').value,
      startHour: timeInputToHour(document.getElementById('set-start').value),
      dailyGoalHours: parseFloat(document.getElementById('set-goal').value),
      fastHours: parseFloat(document.getElementById('set-fast').value),
      eatHours: parseFloat(document.getElementById('set-eat').value),
      goalFocus: document.getElementById('set-focus').value,
      waterGoalMl: parseInt(document.getElementById('set-water').value, 10),
      waterUnit: document.getElementById('set-unit').value,
      calorieGoal: parseInt(document.getElementById('set-cal').value, 10),
      proteinGoalG: parseInt(document.getElementById('set-pro').value, 10),
      carbGoalG: parseInt(document.getElementById('set-carb').value, 10),
      fatGoalG: parseInt(document.getElementById('set-fat').value, 10),
      schedulePaused: document.getElementById('set-paused').checked,
      reminders
    });
    showToast('Settings saved.');
  } catch (err) { alert(err.message); }
}
