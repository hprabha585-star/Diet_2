function generateReferralCode(name) {
  const base = (name || 'FC').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'FCUS';
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${rand}`;
}

/**
 * Build the coach-assigned checklist items for a regimen — split into
 * meal items and habit-milestone items. These are the ONLY items that
 * count toward completion%, points and streak. Items a client adds
 * themselves are appended separately by the route with custom=true and
 * are never included here.
 */
function buildChecklistItems(regimen) {
  const seen = new Set();
  const unique = (base) => {
    let key = base, n = 2;
    while (seen.has(key)) key = `${base}_${n++}`;
    seen.add(key);
    return key;
  };
  const meals = (regimen.meals || []).map(m => ({
    itemKey: unique(`meal_${m.type}`),
    label: m.calories ? `${m.name} (${m.calories} kcal)` : m.name,
    kind: 'meal', done: false, custom: false
  }));
  const habits = (regimen.milestones || []).map(m => ({
    itemKey: unique(`habit_${m.itemKey || m.key}`),
    label: m.label, kind: 'habit', done: false, custom: false
  }));
  return [...meals, ...habits];
}

/**
 * Only coach-assigned (non-custom) items count toward adherence, points
 * and the streak. Client-added items are useful to the client but must
 * never move the leaderboard.
 */
function recalcCompletion(items) {
  const scored = items.filter(i => !i.custom);
  const done = scored.filter(i => i.done).length;
  return scored.length ? Math.round((done / scored.length) * 100) : 0;
}

module.exports = { generateReferralCode, buildChecklistItems, recalcCompletion };
