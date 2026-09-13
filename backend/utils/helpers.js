function generateReferralCode(name) {
  const base = (name || 'FC').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'FCUS';
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${rand}`;
}

// Given an eating window (startHour/endHour, 0-23.99 in the user's local clock)
// return the live fasting/eating state for "now".
function computeFastingState(fastingWindow, now = new Date()) {
  if (!fastingWindow) return null;
  const hours = now.getHours() + now.getMinutes() / 60;
  const { startHour, endHour } = fastingWindow;

  const inEatingWindow = startHour <= endHour
    ? hours >= startHour && hours < endHour
    : hours >= startHour || hours < endHour; // window crosses midnight

  const state = inEatingWindow ? 'eating' : 'fasting';

  let targetHour = inEatingWindow ? endHour : startHour;
  let diff = targetHour - hours;
  if (diff < 0) diff += 24;

  const totalSeconds = Math.round(diff * 3600);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;

  return {
    state,
    secondsRemaining: totalSeconds,
    countdown: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
    eatingWindow: fastingWindow
  };
}

module.exports = { generateReferralCode, computeFastingState };
