let dashboardData = null;
let timerInterval = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = requireRoleOrRedirect('client');
  if (!user) return;
  document.getElementById('user-chip').textContent = user.name;

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showView(link.dataset.view);
    });
  });

  await loadDashboard();
  await loadWeightGoalDefaults();
});

function showView(view) {
  document.querySelectorAll('section[id^="view-"]').forEach(s => s.style.display = 'none');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById(`view-${view}`).style.display = 'block';
  document.querySelector(`.nav-link[data-view="${view}"]`).classList.add('active');
  document.getElementById('page-title').textContent = document.querySelector(`.nav-link[data-view="${view}"]`).textContent;

  if (view === 'history') loadHistory();
  if (view === 'leaderboard') loadLeaderboard();
  if (view === 'refer') loadReferral();
}

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
      document.getElementById('checklist-container').innerHTML = '<div class="empty-state"><h3>No plan yet</h3><p>Your coach will assign day 1 once your payment is approved.</p></div>';
      return;
    }

    document.getElementById('stat-day').textContent = `${data.day} / ${data.challengeLengthDays}`;
    document.getElementById('stat-points').textContent = data.points;
    document.getElementById('stat-streak').textContent = data.streakCurrent;
    document.getElementById('stat-best').textContent = data.streakBest;

    renderChecklist(data.checklist);
    renderWater(data.checklist, data.regimen);
    renderTimer(data.fastingState);

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (dashboardData.fastingState) {
        dashboardData.fastingState.secondsRemaining -= 1;
        if (dashboardData.fastingState.secondsRemaining <= 0) { loadDashboard(); return; }
        const s = dashboardData.fastingState.secondsRemaining;
        const hh = String(Math.floor(s / 3600)).padStart(2, '0');
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        document.getElementById('timer-time').textContent = `${hh}:${mm}:${ss}`;
      }
    }, 1000);

  } catch (err) {
    document.getElementById('checklist-container').innerHTML = `<p class="error-text">${err.message}</p>`;
  }
}

function renderTimer(fastingState) {
  const arc = document.getElementById('timer-arc');
  const CIRC = 2 * Math.PI * 62;
  if (!fastingState) {
    document.getElementById('timer-state').textContent = 'No plan yet';
    document.getElementById('timer-time').textContent = '--:--:--';
    document.getElementById('timer-desc').textContent = "Your fasting window will appear here once your coach assigns today's plan.";
    arc.setAttribute('stroke-dasharray', `0 ${CIRC}`);
    return;
  }
  document.getElementById('timer-state').textContent = fastingState.state === 'fasting' ? 'Fasting' : 'Eating window';
  document.getElementById('timer-time').textContent = fastingState.countdown;
  document.getElementById('timer-desc').textContent = fastingState.state === 'fasting'
    ? `Stay the course — your eating window opens in ${fastingState.countdown}.`
    : `You're in your eating window for another ${fastingState.countdown}.`;
  const frac = Math.max(0, Math.min(1, fastingState.secondsRemaining / 86400));
  arc.setAttribute('stroke-dasharray', `${CIRC * (1 - frac)} ${CIRC}`);
}

function renderChecklist(checklist) {
  const container = document.getElementById('checklist-container');
  if (!checklist || !checklist.items || checklist.items.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>Nothing assigned yet</h3><p>Check back once your coach has set today\'s plan.</p></div>';
    return;
  }
  container.innerHTML = checklist.items.map(item => `
    <div class="checklist-item ${item.done ? 'done' : ''}">
      <input type="checkbox" ${item.done ? 'checked' : ''} onchange="toggleItem('${item.key}', this.checked)">
      <label>${item.label}</label>
    </div>
  `).join('');
}

function renderWater(checklist, regimen) {
  const target = (regimen && regimen.waterTargetMl) || 3000;
  const current = checklist ? checklist.waterMl : 0;
  const pct = Math.min(100, Math.round((current / target) * 100));
  document.getElementById('water-fill').style.width = `${pct}%`;
  document.getElementById('water-label').textContent = `${current} / ${target} ml`;
}

async function toggleItem(itemKey, done) {
  try {
    const data = await apiRequest('/client/checklist', { method: 'POST', body: { itemKey, done } });
    renderChecklist(data.checklist);
    document.getElementById('stat-points').textContent = data.points;
    document.getElementById('stat-streak').textContent = data.streakCurrent;
  } catch (err) {
    alert(err.message);
  }
}

async function addWater(ml) {
  try {
    const data = await apiRequest('/client/checklist', { method: 'POST', body: { addWaterMl: ml } });
    renderWater(data.checklist, dashboardData.regimen);
  } catch (err) {
    alert(err.message);
  }
}

async function loadWeightGoalDefaults() {}

async function loadHistory() {
  try {
    const data = await apiRequest('/client/history');
    const wTbody = document.querySelector('#weight-table tbody');
    wTbody.innerHTML = data.weightLogs.slice().reverse().map(w => `
      <tr><td>${new Date(w.date).toLocaleDateString()}</td><td>${w.weightKg} kg</td></tr>
    `).join('') || '<tr><td colspan="2" style="color:#6B6F63;">No weight logged yet</td></tr>';

    const hTbody = document.querySelector('#history-table tbody');
    hTbody.innerHTML = data.checklistHistory.slice().reverse().map(h => `
      <tr><td>Day ${h.day}</td><td>${new Date(h.date).toLocaleDateString()}</td><td>${h.completionPercent}%</td></tr>
    `).join('') || '<tr><td colspan="3" style="color:#6B6F63;">No history yet</td></tr>';
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
  } catch (err) {
    alert(err.message);
  }
}

async function loadLeaderboard() {
  try {
    const data = await apiRequest('/client/leaderboard');
    const list = document.getElementById('leaderboard-list');
    list.innerHTML = data.leaderboard.map((c, i) => `
      <div class="leaderboard-row">
        <span class="rank">${i + 1}</span>
        <span class="name">${c.name}</span>
        <span class="pts">${c.points} pts · ${c.streakCurrent}🔥 streak</span>
      </div>
    `).join('') || '<p class="hint">No active clients yet.</p>';
  } catch (err) {
    console.error(err);
  }
}

async function loadReferral() {
  try {
    const data = await apiRequest('/client/referral');
    document.getElementById('referral-code').textContent = data.referralCode;
    document.getElementById('ref-count').textContent = data.referredCount;
    document.getElementById('ref-wallet').textContent = `₹${data.walletBalanceInr}`;

    const tbody = document.querySelector('#payout-table tbody');
    tbody.innerHTML = data.payouts.map(p => `
      <tr><td>${new Date(p.requestedAt).toLocaleDateString()}</td><td>₹${p.amountInr}</td><td><span class="badge badge-${p.status === 'paid' ? 'active' : p.status === 'rejected' ? 'rejected' : 'pending'}">${p.status}</span></td></tr>
    `).join('') || '<tr><td colspan="3" style="color:#6B6F63;">No payout requests yet</td></tr>';
  } catch (err) {
    console.error(err);
  }
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
