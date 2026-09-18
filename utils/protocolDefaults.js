/* ============================================================
   FastCoach — 55-Day Step-by-Step Fasting Protocol (static reference)
   Transcribed from the coach's protocol document. There is no separate
   "protocol" database table anymore — this is only used to pre-fill the
   Assign Plan day-picker in the admin console. The coach edits the
   window/meals/habits directly on the client's Regimen when applying a
   day; nothing here is stored or mutated.
   Hours are on a 24h clock (13.5 = 1:30 PM).
   ============================================================ */

// eating-window day
function w(day, phase, start, end, focus, type = 'eating_window', label = '') {
  const eating = Math.round((end - start) * 10) / 10;
  return {
    day, phase, protocolType: type, label,
    startHour: start, endHour: end,
    isFullDayFast: false,
    eatingHours: eating,
    fastingHours: Math.round((24 - eating) * 10) / 10,
    focus, waterTargetMl: 3000
  };
}

// full-day fast (24h / 36h / 48h)
function f(day, phase, focus, type = 'fast_24', label = '', waterTargetMl = 3500) {
  return {
    day, phase, protocolType: type, label,
    startHour: 9, endHour: 9,
    isFullDayFast: true,
    eatingHours: 0, fastingHours: 24,
    focus, waterTargetMl
  };
}

const P1 = 'Phase 1 — Foundation & Adaptation';
const P2 = 'Phase 2 — Deep Intermittent Fasting';
const P3 = 'Phase 3 — Narrow Window & Autophagy Prep';
const P4 = 'Phase 4 — 24-Hour Fasting Integration';
const P5 = 'Phase 5 — Extended Fasting Progression';
const P6 = 'Phase 6 — Mastery & Long-Term Exit';

const PROTOCOL_DAYS = [
  /* ---- Phase 1: Days 1-7 ---- */
  w(1, P1, 9, 21, 'Program baseline start. Log starting weight and baseline water intake (3L/day).', 'eating_window', '12/12 baseline'),
  w(2, P1, 9, 20.5, 'Cut evening snacks 30 minutes earlier. Keep dinner light.'),
  w(3, P1, 9, 20, 'Reduce the eating window by another 30 mins. Focus on a fibre-rich dinner.'),
  w(4, P1, 9, 19.5, 'Eliminate late-night cravings. Hydrate with warm water after 7:30 PM.'),
  w(5, P1, 9, 19, 'Hit the 14/10 baseline target. Morning detox water (warm lemon water).', 'eating_window', '14/10 baseline'),
  w(6, P1, 9, 19, 'Consolidate the 14/10 window. Clean protein and complex carbs.'),
  w(7, P1, 9, 19, 'Week 1 completion check. Log weight and review energy levels.'),

  /* ---- Phase 2: Days 8-21 ---- */
  w(8, P2, 9, 18.5, '30-minute evening window reduction.'),
  w(9, P2, 9, 18, 'Solid 15-hour fast. Introduce electrolytes in the morning if needed.'),
  w(10, P2, 9, 17.5, 'Gradual progression towards 16 hours.'),
  w(11, P2, 9, 17, 'Standard 16/8 window reached. Dinner finished by 5:00 PM.', 'eating_window', '16/8 reached'),
  w(12, P2, 9, 17, '16/8 stability day. Maintain the 3L water target.'),
  w(13, P2, 9, 17, '16/8 stability day. Log daily adherence on the cohort dashboard.'),
  w(14, P2, 9, 16.5, 'Pushing past 16 hours. Light 30-minute evening walk recommended.'),
  w(15, P2, 9, 16, 'Hit the 17-hour fast mark. Meals rich in healthy fats.'),
  w(16, P2, 9, 16, 'Stable 17/7 routine.'),
  w(17, P2, 9, 15.5, '30-minute step down towards 18 hours.'),
  w(18, P2, 9, 15, '18/6 golden standard reached. Eating window 9 AM to 3 PM.', 'eating_window', '18/6 golden standard'),
  w(19, P2, 9, 15, 'Add Himalayan pink salt to fasting water to maintain electrolyte balance.'),
  w(20, P2, 9, 15, 'High nutrient density during the 6-hour window. Avoid sugar spikes.'),
  w(21, P2, 9, 14.5, 'Week 3 milestone. Prepare for short-window adaptation.'),

  /* ---- Phase 3: Days 22-28 ---- */
  w(22, P3, 9, 14, '19-hour fasting baseline.'),
  w(23, P3, 9, 13.5, 'Transition day. Maintain hydration.'),
  w(24, P3, 9, 13, '20/4 warrior fasting reached. Eating window 9 AM to 1 PM.', 'eating_window', '20/4 warrior'),
  w(25, P3, 9, 13, 'Stable 20/4 protocol. Two solid protein/veg meals inside 4 hours.'),
  w(26, P3, 9, 12.5, 'Short window progression.'),
  w(27, P3, 9, 12, '21/3 protocol. Eating window 9 AM to 12 PM.', 'eating_window', '21/3 protocol'),
  w(28, P3, 9, 12, "Heavy hydration prep for tomorrow's first 24-hour fast."),

  /* ---- Phase 4: Days 29-35 ---- */
  f(29, P4, 'Fast from Day 28, 9:00 AM to Day 29, 9:00 AM. Only water and electrolytes.', 'fast_24', 'First 24-hour fast'),
  w(30, P4, 9, 15, 'Break the fast gently at 9:00 AM with warm water and lemon/ghee. 6-hour refeed.', 'refeed', 'Refeed window'),
  w(31, P4, 9, 15, 'Clean protein and healthy fat focus. Hydration check.', 'refeed', 'Refeed window'),
  f(32, P4, 'Mid-week 24-hour metabolic reset (fast from Day 31, 9 AM to Day 32, 9 AM).', 'fast_24', '24-hour reset'),
  w(33, P4, 9, 15, 'Refeed with nutrient-dense meals. Avoid refined carbohydrates.', 'refeed', 'Refeed window'),
  w(34, P4, 9, 15, 'High fibre and protein recovery day.', 'refeed', 'Refeed window'),
  f(35, P4, 'Weekend 24-hour fast. Water and electrolyte protocol strictly enforced.', 'fast_24', '24-hour fast'),

  /* ---- Phase 5: Days 36-47 ---- */
  f(36, P5, 'Fasting starts after the Day 35 refeed. Zero calories (water + pink salt).', 'fast_36', '36-hour fast · day 1'),
  { day: 37, phase: P5, protocolType: 'fast_36', label: '36-hour fast · day 2 (break 9 PM)',
    startHour: 21, endHour: 23, isFullDayFast: false, eatingHours: 2, fastingHours: 22,
    focus: '36 hours completed at 9 PM. Break the fast with bone broth or light curd/soup.', waterTargetMl: 3500 },
  w(38, P5, 9, 15, 'Standard 6-hour recovery refeed window.', 'refeed', 'Refeed window'),
  w(39, P5, 9, 15, 'High micronutrient intake. Restore glycogen gently.', 'refeed', 'Refeed window'),
  w(40, P5, 9, 13, '20/4 intermediate fast to maintain momentum.', 'eating_window', 'Intermediate reset'),
  f(41, P5, 'Standard 24-hour reset fast.', 'fast_24', '24-hour reset'),
  w(42, P5, 9, 15, 'High electrolyte prep day for the upcoming 48-hour fast.', 'refeed', 'Refeed window'),
  f(43, P5, 'Start the 48-hour fast at 9:00 AM. Strict electrolyte regimen (salt + potassium).', 'fast_48', '48-hour fast · day 1'),
  f(44, P5, 'Peak autophagy state. Monitor energy. Zero-calorie hydration only.', 'fast_48', '48-hour fast · day 2'),
  w(45, P5, 9, 15, 'Break the fast at 9:00 AM with warm water + ghee/soup. Light meals 9 AM – 3 PM.', 'break_fast', 'Break 48h fast'),
  w(46, P5, 9, 15, 'Gut-friendly refeed (curd, cooked vegetables, soft proteins).', 'refeed', 'Refeed window'),
  w(47, P5, 9, 15, 'Recovery day. Track water intake and digestive comfort.', 'refeed', 'Refeed window'),

  /* ---- Phase 6: Days 48-55 ---- */
  f(48, P6, 'Final 24-hour reset before the exit taper.', 'fast_24', 'Final 24h reset'),
  w(49, P6, 9, 13, 'Stabilization at 20/4.', 'stabilization', 'Stabilization'),
  w(50, P6, 9, 14, 'Stabilization at 19/5.', 'stabilization', 'Stabilization'),
  w(51, P6, 9, 15, 'Stabilization at 18/6.', 'stabilization', 'Stabilization'),
  w(52, P6, 9, 15, 'Sustainable routine at 18/6.', 'stabilization', 'Sustainable routine'),
  w(53, P6, 9, 16, 'Sustainable routine at 17/7.', 'stabilization', 'Sustainable routine'),
  w(54, P6, 9, 17, 'Sustainable routine at 16/8.', 'stabilization', 'Sustainable routine'),
  w(55, P6, 9, 17, 'Graduation day — final weight check and review.', 'stabilization', 'Graduation day')
];

const SAFETY_NOTES = [
  'Hydration: minimum 3.0–3.5 litres of water daily. On 24h+ fasts add a pinch of Himalayan pink salt every 3–4 hours to prevent headaches and cramps.',
  'Refeeding: never break an extended fast (24h/36h/48h) with heavy carbs, fried food or sugar. Warm water + lemon/ghee first, then broth, soup or curd after 30 minutes.',
  'Coach override: any day\'s window can be adjusted from the admin panel if a client has extreme fatigue, illness or travel conflicts.'
];

module.exports = { PROTOCOL_DAYS, SAFETY_NOTES };
