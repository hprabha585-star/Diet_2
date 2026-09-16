function generateReferralCode(name) {
  const base = (name || 'FC').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'FCUS';
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${rand}`;
}

function fmt(totalSeconds) {
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * Live fasting/eating state for "now".
 * @param regimen        a Regimen document (or a plain {fastingWindow, isFullDayFast})
 * @param options.paused true when the client has paused fasting
 */
function computeFastingState(regimen, options = {}, now = new Date()) {
  if (!regimen) return null;
  const fastingWindow = regimen.fastingWindow || regimen;
  if (!fastingWindow || typeof fastingWindow.startHour !== 'number') return null;

  const hours = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  const { startHour, endHour } = fastingWindow;

  // Paused: the countdown is meaningless, so report the paused state instead.
  if (options.paused) {
    return {
      state: 'paused',
      secondsRemaining: 0,
      countdown: '--:--:--',
      eatingWindow: fastingWindow,
      isFullDayFast: !!regimen.isFullDayFast,
      protocolType: regimen.protocolType || 'eating_window',
      reason: options.reason || ''
    };
  }

  // Full-day fast (24h / 36h / 48h): no eating window at all today.
  if (regimen.isFullDayFast) {
    let diff = startHour - hours;
    if (diff <= 0) diff += 24;
    const totalSeconds = Math.round(diff * 3600);
    return {
      state: 'fasting',
      secondsRemaining: totalSeconds,
      countdown: fmt(totalSeconds),
      eatingWindow: fastingWindow,
      isFullDayFast: true,
      protocolType: regimen.protocolType || 'fast_24'
    };
  }

  const inEatingWindow = startHour <= endHour
    ? hours >= startHour && hours < endHour
    : hours >= startHour || hours < endHour; // window crosses midnight

  const targetHour = inEatingWindow ? endHour : startHour;
  let diff = targetHour - hours;
  if (diff < 0) diff += 24;

  const totalSeconds = Math.round(diff * 3600);
  return {
    state: inEatingWindow ? 'eating' : 'fasting',
    secondsRemaining: totalSeconds,
    countdown: fmt(totalSeconds),
    eatingWindow: fastingWindow,
    isFullDayFast: false,
    protocolType: regimen.protocolType || 'eating_window'
  };
}

// Build the default checklist items for a regimen.
function buildChecklistItems(regimen) {
  // Keys must be unique — two "snack" meals or two habits sharing a key
  // would otherwise tick together.
  const seen = new Set();
  const unique = (base) => {
    let key = base, n = 2;
    while (seen.has(key)) key = `${base}_${n++}`;
    seen.add(key);
    return key;
  };
  return [
    ...(regimen.meals || []).map(m => ({
      key: unique(`meal_${m.type}`),
      label: m.calories ? `${m.name} (${m.calories} kcal)` : m.name,
      done: false, custom: false
    })),
    ...(regimen.milestones || []).map(m => ({
      key: unique(`habit_${m.key}`), label: m.label, done: false, custom: false
    }))
  ];
}

module.exports = { generateReferralCode, computeFastingState, buildChecklistItems, fmt };
