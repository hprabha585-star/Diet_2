let currentUser = null;
let dashboardData = null;
let timerInterval = null;
let addItemKind = 'meal';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  currentUser = requireRoleOrRedirect('client');
  if (!currentUser) return;
  document.getElementById('user-chip').textContent = currentUser.name;

  // Only intercept in-page views. The Fasting Tracker link is a real
  // link to its own page, so it must NOT be preventDefault()-ed.
  document.querySelectorAll('.nav-link[data-view]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      showView(a.dataset.view);
    });
  });

  await loadDashboard();
  loadProgress();
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
      document.getElementById('today-tracker-redirect').style.display = 'none';
      return;
    }
    throw err;
  }

  document.getElementById('plan-mode-tag').textContent = dashboardData.planMode === 'tracker' ? 'Fasting Tracker' : 'Coached client';

  // Fasting Tracker nav item: unlocked only when this IS the client's plan.
  const navTracker = document.getElementById('nav-tracker');
  const isTrackerPlan = dashboardData.planMode === 'tracker';
  navTracker.classList.toggle('unlocked', isTrackerPlan);

  if (isTrackerPlan) {
    document.getElementById('today-protocol').style.display = 'none';
    document.getElementById('today-tracker-redirect').style.display = 'block';
    document.getElementById('progress-bars').style.display = 'none';
  } else {
    document.getElementById('today-tracker-redirect').style.display = 'none';
    document.getElementById('today-protocol').style.display = 'block';
    renderProtocolToday();
  }

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tick, 1000);
}

/* ------------------------------------------------------------------ */
/* Today page — motivational progress strip                             */
/* ------------------------------------------------------------------ */
async function loadProgress() {
  try {
    const p = await apiRequest('/client/progress');
    const el = document.getElementById('progress-strip');
    const barsEl = document.getElementById('progress-bars');
    if (p.planMode === 'tracker') {
      el.innerHTML = `
        <div class="p-item"><div class="p-num">${p.totalFasts}</div><div class="p-lbl">Fasts logged</div></div>
        <div class="p-item"><div class="p-num">${p.currentStreak}</div><div class="p-lbl">Day streak</div></div>
        <div class="p-item"><div class="p-num">${p.longestFastHours}h</div><div class="p-lbl">Longest fast</div></div>`;
      barsEl.style.display = 'none';
    } else {
      el.innerHTML = `
        <div class="p-item"><div class="p-num">${p.streakCurrent}</div><div class="p-lbl">Current streak</div></div>
        <div class="p-item"><div class="p-num">${p.streakBest}</div><div class="p-lbl">Best streak</div></div>
        <div class="p-item"><div class="p-num">${p.points}</div><div class="p-lbl">Points</div></div>
        <div class="p-item"><div class="p-num">${p.day}/${p.challengeLengthDays}</div><div class="p-lbl">Day</div></div>`;

      const journeyPct = p.challengeLengthDays ? Math.min(100, Math.round((p.day / p.challengeLengthDays) * 100)) : 0;
      renderChecklistProgress({
        percent: p.todayPercent, done: p.todayDone, total: p.todayTotal,
        scored: p.todayScored, threshold: p.threshold, pointsPerDay: p.pointsPerDay,
        journeyPct, day: p.day, totalDays: p.challengeLengthDays
      });
      barsEl.style.display = 'block';
    }
    el.style.display = 'flex';
  } catch (err) { /* not active yet — leave the strip hidden */ }
}

/**
 * Today's checklist progress bar.
 *
 * The old markup reused .bar-row/.bar-track/.bar-fill — the same class
 * names the water bar-CHART uses, and that rule set `max-width: 40px`
 * on .bar-track, so the progress bar rendered as an invisible 40px
 * sliver. These classes are prog-* and collide with nothing.
 *
 * The bar also carries a marker at the scoring threshold, so it's
 * obvious how much of the checklist banks the day's points.
 */
let lastProgress = null;

function renderChecklistProgress(p) {
  lastProgress = Object.assign({}, lastProgress, p);
  const d = lastProgress;
  const barsEl = document.getElementById('progress-bars');
  if (!barsEl) return;

  const pct = Math.max(0, Math.min(100, d.percent || 0));
  const threshold = d.threshold || 80;
  const pointsPerDay = d.pointsPerDay || 100;
  const total = d.total || 0;
  const done = d.done || 0;

  const status = !total
    ? 'No plan assigned for today yet.'
    : d.scored
      ? `Day complete — ${pointsPerDay} points banked.`
      : `${threshold - pct}% more to bank today's ${pointsPerDay} points.`;

  barsEl.innerHTML = `
    <div class="prog-card card">
      <div class="prog-head">
        <div>
          <div class="prog-title">Today's checklist</div>
          <div class="prog-sub">${done} of ${total} coach-assigned item${total === 1 ? '' : 's'} done${total ? ` · ${status}` : ''}</div>
        </div>
        <div class="prog-pct ${d.scored ? 'hit' : ''}">${pct}%</div>
      </div>
      <div class="prog-track">
        <div class="prog-fill ${d.scored ? 'hit' : ''}" style="width:${pct}%;"></div>
        <div class="prog-marker" style="left:${threshold}%;" title="${threshold}% scores the day"></div>
      </div>
      <div class="prog-scale"><span>0%</span><span class="prog-scale-mid" style="left:${threshold}%;">${threshold}%</span><span>100%</span></div>

      <div class="prog-row-journey">
        <div class="prog-sub">55-day journey — day ${d.day || 0} of ${d.totalDays || 55}</div>
        <div class="prog-track slim"><div class="prog-fill journey" style="width:${d.journeyPct || 0}%;"></div></div>
      </div>
    </div>`;
  barsEl.style.display = 'block';
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
    // Paint the new percentage straight away, then refresh from the server.
    renderChecklistProgress({
      percent: res.completionPercent, done: res.scoredDone, total: res.scoredTotal,
      scored: res.dayScored, threshold: res.threshold, pointsPerDay: res.pointsPerDay
    });
    await loadDashboard();
    await loadProgress(); // points/streak are re-derived server-side
    if (res.awardedPoints) {
      showPointsToast(`+${res.pointsPerDay} points — day ${res.streakCurrent} of your streak.`);
    } else if (res.revokedPoints) {
      showPointsToast(`Back under ${res.threshold}% — today's ${res.pointsPerDay} points are on hold.`);
    }
  } catch (err) { alert(err.message); }
}

function showPointsToast(msg) {
  let el = document.getElementById('points-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'points-toast';
    el.className = 'points-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window._pointsToastTimer);
  window._pointsToastTimer = setTimeout(() => el.classList.remove('show'), 2600);
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
    await loadProgress(); // a deleted CUSTOM item never affected points, but a
                           // deleted coach item can change completion% — refresh
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
}

/* The self-guided Fasting Tracker now lives in its own section:
   public/client/tracker.html + public/js/tracker.js. Nothing tracker-
   related runs on this page any more. */

/* ------------------------------------------------------------------ */
/* History & weight                                                      */
/* ------------------------------------------------------------------ */
async function loadHistoryPage(opts = {}) {
  try {
    const data = await apiRequest('/client/history');
    document.getElementById('weight-list').innerHTML = (data.weightLogs || []).slice().reverse().map(w => `
      <div class="row-between" style="padding:10px 0;border-top:1px solid var(--line);">
        <span>${w.weightKg} kg — ${new Date(w.date).toLocaleDateString()}</span>
        <button class="btn-ghost btn-sm" onclick="deleteWeight(${w.id})">Delete</button>
      </div>`).join('') || '<p class="hint">No entries yet.</p>';

    // Pre-fill the calculator with whatever we already know, so returning
    // to this page doesn't make the person retype everything.
    const latestWeight = data.weightLogs && data.weightLogs.length ? data.weightLogs[data.weightLogs.length - 1].weightKg : '';
    const wEl = document.getElementById('bmi-weight-input');
    if (latestWeight && !wEl.value) wEl.value = latestWeight;
    if (currentUser.heightCm) document.getElementById('height-input').value = currentUser.heightCm;
    if (currentUser.age) document.getElementById('age-input').value = currentUser.age;
    if (currentUser.gender) document.getElementById('gender-input').value = currentUser.gender;

    // Only clear the calculator output on a plain page visit — clearing it
    // after a save is what made "Save this" look like it did nothing.
    if (!opts.keepResult) document.getElementById('bmi-result').innerHTML = '';
  } catch (err) { /* ignore if not active yet */ }
}
document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.nav-link[data-view="history"]').addEventListener('click', loadHistoryPage);
});

/* ------------------------------------------------------------------ */
/* BMI calculator — gauge + full read-out                              */
/* ------------------------------------------------------------------ */
let lastBmiCalc = null; // holds {weightKg, heightCm, age, gender} once Calculate has run, for Save

// The dial runs from BMI 12 to BMI 42 across a half circle.
const BMI_SCALE_MIN = 12;
const BMI_SCALE_MAX = 42;
const BMI_BANDS = [
  { from: 12,   to: 16,   color: '#A8402F', label: 'Severe thinness' },
  { from: 16,   to: 17,   color: '#C2603F', label: 'Moderate thinness' },
  { from: 17,   to: 18.5, color: '#D9A441', label: 'Mild thinness' },
  { from: 18.5, to: 25,   color: '#3F7D58', label: 'Normal' },
  { from: 25,   to: 30,   color: '#D9A441', label: 'Overweight' },
  { from: 30,   to: 35,   color: '#D98A70', label: 'Obese class I' },
  { from: 35,   to: 40,   color: '#B8452F', label: 'Obese class II' },
  { from: 40,   to: 42,   color: '#7E2417', label: 'Obese class III' }
];

function bmiCategory(bmi) {
  const band = BMI_BANDS.find(b => bmi >= b.from && bmi < b.to);
  if (bmi < 12) return 'Severe thinness';
  if (bmi >= 40) return 'Obese class III';
  return band ? band.label : '—';
}

function bmiToAngle(bmi) {
  const clamped = Math.max(BMI_SCALE_MIN, Math.min(BMI_SCALE_MAX, bmi));
  return 180 * ((clamped - BMI_SCALE_MIN) / (BMI_SCALE_MAX - BMI_SCALE_MIN)); // 0 = left, 180 = right
}

// Point on the dial circle for a given angle (0° left, 180° right).
function dialPoint(cx, cy, r, angleDeg) {
  const rad = (Math.PI * (180 - angleDeg)) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

function bandArc(cx, cy, rOuter, rInner, fromBmi, toBmi, color) {
  const a1 = bmiToAngle(fromBmi), a2 = bmiToAngle(toBmi);
  const o1 = dialPoint(cx, cy, rOuter, a1), o2 = dialPoint(cx, cy, rOuter, a2);
  const i2 = dialPoint(cx, cy, rInner, a2), i1 = dialPoint(cx, cy, rInner, a1);
  return `<path fill="${color}" d="M ${o1.x.toFixed(1)} ${o1.y.toFixed(1)}
    A ${rOuter} ${rOuter} 0 0 1 ${o2.x.toFixed(1)} ${o2.y.toFixed(1)}
    L ${i2.x.toFixed(1)} ${i2.y.toFixed(1)}
    A ${rInner} ${rInner} 0 0 0 ${i1.x.toFixed(1)} ${i1.y.toFixed(1)} Z"/>`;
}

function bmiGaugeSvg(bmi) {
  const cx = 170, cy = 168, rOuter = 148, rInner = 96;
  const bands = BMI_BANDS.map(b => bandArc(cx, cy, rOuter, rInner, b.from, b.to, b.color)).join('');

  const ticks = [16, 17, 18.5, 25, 30, 35, 40].map(v => {
    const p = dialPoint(cx, cy, rOuter + 13, bmiToAngle(v));
    return `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle"
              font-size="11" fill="#55594E">${v}</text>`;
  }).join('');

  const needle = dialPoint(cx, cy, rInner - 8, bmiToAngle(bmi));
  const tail = dialPoint(cx, cy, 14, bmiToAngle(bmi) + 180);

  return `
  <svg viewBox="0 0 340 200" class="bmi-gauge" role="img" aria-label="BMI ${bmi}">
    ${bands}
    ${ticks}
    <text x="42" y="196" font-size="10.5" fill="#6B6F63">Underweight</text>
    <text x="170" y="34" text-anchor="middle" font-size="10.5" fill="#6B6F63">Normal</text>
    <text x="298" y="196" text-anchor="end" font-size="10.5" fill="#6B6F63">Obesity</text>
    <line x1="${tail.x.toFixed(1)}" y1="${tail.y.toFixed(1)}" x2="${needle.x.toFixed(1)}" y2="${needle.y.toFixed(1)}"
          stroke="#16211D" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="8" fill="#16211D"/>
  </svg>`;
}

function calculateBmi() {
  const errEl = document.getElementById('bmi-error');
  errEl.style.display = 'none';
  const weightKg = parseFloat(document.getElementById('bmi-weight-input').value);
  const heightCm = parseFloat(document.getElementById('height-input').value);
  const age = parseInt(document.getElementById('age-input').value, 10) || null;
  const gender = document.getElementById('gender-input').value || '';

  if (!weightKg || !heightCm || weightKg <= 0 || heightCm <= 0) {
    errEl.textContent = 'Enter both weight and height to calculate.';
    errEl.style.display = 'block';
    document.getElementById('bmi-result').innerHTML = '';
    return;
  }

  const m = heightCm / 100;
  const raw = weightKg / (m * m);
  const bmi = Math.round(raw * 10) / 10;
  const category = bmiCategory(raw);
  const inNormal = raw >= 18.5 && raw < 25;

  const minKg = Math.round(18.5 * m * m * 10) / 10;
  const maxKg = Math.round(25 * m * m * 10) / 10;
  const bmiPrime = Math.round((raw / 25) * 100) / 100;          // BMI ÷ upper normal limit
  const ponderal = Math.round((weightKg / (m * m * m)) * 10) / 10; // kg/m³

  let note = '';
  if (age && age < 18) note = 'BMI bands here are the adult ones — under 18, a doctor\'s growth-chart reading is the accurate measure.';
  else if (age && age > 65) note = 'Over 65, a slightly higher BMI is often protective — treat this as a rough guide, not a target.';
  if (gender === 'female') note += (note ? ' ' : '') + 'Body composition differs by sex; this is a general guide, not tailored to you.';

  lastBmiCalc = { weightKg, heightCm, age, gender };

  document.getElementById('bmi-result').innerHTML = `
    <div class="bmi-result-grid">
      <div class="bmi-gauge-wrap">
        ${bmiGaugeSvg(raw)}
        <div class="bmi-gauge-value">BMI = ${bmi}</div>
      </div>
      <div class="bmi-readout">
        <div class="bmi-headline">
          BMI = <strong>${bmi}</strong> kg/m²
          <span class="bmi-cat ${inNormal ? 'ok' : 'warn'}">${esc(category)}</span>
        </div>
        <ul class="bmi-facts">
          <li><span>Healthy BMI range</span><b>18.5 – 25 kg/m²</b></li>
          <li><span>Healthy weight for your height</span><b>${minKg} – ${maxKg} kg</b></li>
          <li><span>BMI Prime</span><b>${bmiPrime}</b></li>
          <li><span>Ponderal Index</span><b>${ponderal} kg/m³</b></li>
        </ul>
      </div>
    </div>
    ${note ? `<p class="hint" style="margin-top:12px;">${esc(note)}</p>` : ''}
    <div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-outline btn-sm" onclick="saveBmiCalc()">💾 Save this</button>
      <button class="btn-ghost btn-sm" onclick="clearBmi()">Clear</button>
      <span class="hint" id="bmi-save-confirm" style="display:none;">Saved.</span>
    </div>`;
}

function clearBmi() {
  ['bmi-weight-input', 'height-input', 'age-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const g = document.getElementById('gender-input');
  if (g) g.value = '';
  document.getElementById('bmi-result').innerHTML = '';
  document.getElementById('bmi-error').style.display = 'none';
  lastBmiCalc = null;
}

async function saveBmiCalc() {
  if (!lastBmiCalc) return;
  const confirmEl = document.getElementById('bmi-save-confirm');
  const errEl = document.getElementById('bmi-error');
  errEl.style.display = 'none';
  try {
    // Two saves, in this order: the body profile (height/age/gender, which
    // the coach can then see on their side) and the weight entry itself.
    const res = await apiRequest('/client/profile', {
      method: 'POST',
      body: {
        heightCm: lastBmiCalc.heightCm,
        age: lastBmiCalc.age || undefined,
        gender: lastBmiCalc.gender || undefined
      }
    });
    await apiRequest('/client/weight', { method: 'POST', body: { weightKg: lastBmiCalc.weightKg } });

    // The old code never refreshed the stored session user, so height and
    // age looked "unsaved" the moment you came back to the page — and
    // loadHistoryPage() then blanked the result panel, which made it look
    // like nothing had happened at all. Both fixed here.
    if (res && res.user) {
      currentUser = res.user;
      setSession(getToken(), res.user);
    }
    await loadHistoryPage({ keepResult: true });
    if (confirmEl) {
      confirmEl.textContent = 'Saved — added to your weight log.';
      confirmEl.style.display = 'inline';
    }
  } catch (err) {
    errEl.textContent = `Could not save: ${err.message}`;
    errEl.style.display = 'block';
  }
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
