let currentPayStatus = 'pending';
let currentPayoutStatus = 'pending';

document.addEventListener('DOMContentLoaded', async () => {
  const user = requireRoleOrRedirect('admin');
  if (!user) return;
  document.getElementById('user-chip').textContent = user.name;

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showView(link.dataset.view);
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
});

function showView(view) {
  document.querySelectorAll('section[id^="view-"]').forEach(s => s.style.display = 'none');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById(`view-${view}`).style.display = 'block';
  document.querySelector(`.nav-link[data-view="${view}"]`).classList.add('active');
  document.getElementById('page-title').textContent = document.querySelector(`.nav-link[data-view="${view}"]`).textContent;

  if (view === 'roster') loadRoster();
  if (view === 'payments') loadPayments();
  if (view === 'leaderboard') loadLeaderboard();
  if (view === 'payouts') loadPayouts();
}

function statusBadge(status) {
  const cls = status === 'active' ? 'active' : status === 'rejected' ? 'rejected' : 'pending';
  return `<span class="badge badge-${cls}">${status.replace('_', ' ')}</span>`;
}

async function loadRoster() {
  const tbody = document.getElementById('roster-body');
  try {
    const data = await apiRequest('/admin/clients');
    tbody.innerHTML = data.clients.map(c => `
      <tr>
        <td><strong>${c.name}</strong><br><span style="color:#6B6F63; font-size:12.5px;">${c.email}</span></td>
        <td>${c.status === 'active' ? `${c.day} / ${c.challengeLengthDays}` : '—'}</td>
        <td>${statusBadge(c.status)}</td>
        <td>${c.fastingState ? `${c.fastingState.state} · ${c.fastingState.countdown}` : (c.status === 'active' ? 'No plan today' : '—')}</td>
        <td>${c.waterMl} ml</td>
        <td>${c.completionPercent}%</td>
        <td>${c.points}</td>
        <td>
          ${c.status === 'active' ? `<button class="btn btn-outline btn-sm" onclick="openRegimenModal('${c._id}','${c.name.replace(/'/g, "\\'")}',${c.day})">Assign plan</button>` : ''}
          ${c.status === 'pending_payment' ? `<button class="btn btn-dark btn-sm" onclick="activateClient('${c._id}')">Activate</button>` : ''}
        </td>
      </tr>
    `).join('') || '<tr><td colspan="8" style="color:#6B6F63;">No clients yet.</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="error-text">${err.message}</td></tr>`;
  }
}

async function activateClient(id) {
  if (!confirm('Activate this client without a logged payment?')) return;
  try {
    await apiRequest(`/admin/clients/${id}/activate`, { method: 'POST' });
    loadRoster();
  } catch (err) { alert(err.message); }
}

async function loadPayments() {
  const tbody = document.getElementById('payments-body');
  try {
    const data = await apiRequest(`/admin/payments?status=${currentPayStatus}`);
    tbody.innerHTML = data.payments.map(p => `
      <tr>
        <td><strong>${p.user ? p.user.name : 'Unknown'}</strong><br><span style="color:#6B6F63; font-size:12.5px;">${p.user ? p.user.email : ''}</span></td>
        <td style="text-transform:capitalize;">${p.tier}</td>
        <td>₹${p.amountInr}</td>
        <td>${p.utr}</td>
        <td>${new Date(p.createdAt).toLocaleString()}</td>
        <td>
          ${p.status === 'pending' ? `
            <button class="btn btn-dark btn-sm" onclick="approvePayment('${p._id}')">Approve</button>
            <button class="btn btn-outline btn-sm" onclick="rejectPayment('${p._id}')">Reject</button>
          ` : statusBadge(p.status)}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="6" style="color:#6B6F63;">No ${currentPayStatus} payments.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="error-text">${err.message}</td></tr>`;
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
        <span class="name">${c.name} <span style="font-weight:400; color:#6B6F63; font-size:12.5px; text-transform:capitalize;">(${c.tier})</span></span>
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
        <td>${p.user ? p.user.name : 'Unknown'}</td>
        <td>₹${p.amountInr}</td>
        <td>${p.upiId}</td>
        <td>${new Date(p.requestedAt).toLocaleDateString()}</td>
        <td>
          ${p.status === 'pending' ? `
            <button class="btn btn-dark btn-sm" onclick="approvePayout('${p._id}')">Mark paid</button>
            <button class="btn btn-outline btn-sm" onclick="rejectPayout('${p._id}')">Reject</button>
          ` : statusBadge(p.status)}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="5" style="color:#6B6F63;">No ${currentPayoutStatus} payouts.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="error-text">${err.message}</td></tr>`;
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

/* ---------------- Regimen builder modal ---------------- */
function openRegimenModal(clientId, name, suggestedDay) {
  document.getElementById('regimen-client-id').value = clientId;
  document.getElementById('regimen-client-name').textContent = name;
  document.getElementById('regimen-day').value = suggestedDay || 1;
  document.getElementById('regimen-start').value = 13;
  document.getElementById('regimen-end').value = 21;
  document.getElementById('regimen-water').value = 3000;
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
function closeRegimenModal() {
  document.getElementById('regimen-modal').classList.remove('open');
}

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
    <input type="text" class="meal-name" placeholder="e.g. 3 egg whites + oats" value="${name}">
    <input type="number" class="meal-cal" placeholder="kcal" value="${calories}">
    <button class="remove-row-btn" onclick="this.parentElement.remove()">Remove</button>
  `;
  document.getElementById('meal-rows').appendChild(row);
}

function addMilestoneRow(key = '', label = '') {
  const row = document.createElement('div');
  row.className = 'meal-row';
  row.style.gridTemplateColumns = '1fr 1.6fr auto';
  row.innerHTML = `
    <input type="text" class="milestone-key" placeholder="key e.g. water_target" value="${key}">
    <input type="text" class="milestone-label" placeholder="Label shown to client" value="${label}">
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
    const startHour = parseFloat(document.getElementById('regimen-start').value);
    const endHour = parseFloat(document.getElementById('regimen-end').value);
    const waterTargetMl = parseInt(document.getElementById('regimen-water').value, 10);

    const meals = Array.from(document.querySelectorAll('#meal-rows .meal-row')).map(row => ({
      type: row.querySelector('.meal-type').value,
      name: row.querySelector('.meal-name').value,
      calories: row.querySelector('.meal-cal').value ? Number(row.querySelector('.meal-cal').value) : undefined
    })).filter(m => m.name.trim().length > 0);

    const milestones = Array.from(document.querySelectorAll('#milestone-rows .meal-row')).map(row => ({
      key: row.querySelector('.milestone-key').value,
      label: row.querySelector('.milestone-label').value
    })).filter(m => m.key.trim() && m.label.trim());

    if (!day || isNaN(startHour) || isNaN(endHour)) {
      throw new Error('Day and eating window are required');
    }

    await apiRequest(`/admin/clients/${clientId}/regimen`, {
      method: 'POST',
      body: { day, fastingWindow: { startHour, endHour }, meals, milestones, waterTargetMl }
    });
    closeRegimenModal();
    loadRoster();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}
