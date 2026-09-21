/* ============================================================
   Fasting Tracker — static reference content.

   Nothing here is stored in the database; it's served as-is to the
   tracker frontend. Wording is deliberately cautious: fasting affects
   people differently, so stages describe what generally happens rather
   than promising an outcome, and nothing here is medical advice.
   ============================================================ */

const SCHEDULES = [
  { key: '12:12', label: '12:12', fastHours: 12, eatHours: 12, blurb: 'A gentle starting point — most of the fast is overnight.', level: 'Beginner' },
  { key: '14:10', label: '14:10', fastHours: 14, eatHours: 10, blurb: 'A small step up from 12:12; usually just a later breakfast.', level: 'Beginner' },
  { key: '16:8',  label: '16:8',  fastHours: 16, eatHours: 8,  blurb: 'The most common schedule — two or three meals inside 8 hours.', level: 'Popular' },
  { key: '18:6',  label: '18:6',  fastHours: 18, eatHours: 6,  blurb: 'A tighter window that suits people already used to 16:8.', level: 'Intermediate' },
  { key: '20:4',  label: '20:4',  fastHours: 20, eatHours: 4,  blurb: 'A short 4-hour window. Plan meals carefully so intake stays adequate.', level: 'Advanced' },
  { key: '23:1',  label: '23:1',  fastHours: 23, eatHours: 1,  blurb: 'One meal a day. Demanding — worth discussing with a professional first.', level: 'Advanced' },
  { key: 'custom', label: 'Custom', fastHours: 16, eatHours: 8, blurb: 'Set your own fasting and eating hours.', level: 'Your own' }
];

/* Stage boundaries are in hours since the fast started. */
const STAGES = [
  {
    key: 'fed', from: 0, to: 4, name: 'Fed state',
    short: 'Your body is working through the meal you just ate.',
    detail: 'Right after eating, digestion and absorption are underway and blood sugar and insulin are typically at their highest point of the fast. Most people feel no different from normal here.'
  },
  {
    key: 'digestion', from: 4, to: 8, name: 'Post-meal digestion',
    short: 'Digestion and absorption are finishing up.',
    detail: 'The last of the meal is being absorbed and the body gradually shifts from using food that has just arrived to using what it stored. Hunger at this point is often habit or routine as much as need.'
  },
  {
    key: 'early', from: 8, to: 12, name: 'Early fasting period',
    short: 'The body leans more on stored energy.',
    detail: 'With nothing new coming in, stored energy covers more of the demand. Some people notice hunger arriving in waves — rising, then passing — rather than building steadily.'
  },
  {
    key: 'stored', from: 12, to: 16, name: 'Increasing reliance on stored energy',
    short: 'Stored energy is doing most of the work.',
    detail: 'Around this point many people report that hunger settles and concentration steadies, though this varies a lot between individuals and from day to day. Hydration matters more here than earlier.'
  },
  {
    key: 'extended', from: 16, to: 24, name: 'Longer fasting period',
    short: 'You are past a typical daily fast.',
    detail: 'Beyond 16 hours you are in the range people usually describe as a longer fast. Keep fluids up, and consider adding a pinch of salt to water if you get headaches or cramps. Stop if you feel unwell.'
  },
  {
    key: 'long', from: 24, to: 1000, name: 'Extended fast',
    short: 'A full day or more without food.',
    detail: 'Fasts of 24 hours or more are not appropriate for everyone and are best done with guidance from a qualified professional, especially if you take medication or have any medical condition.'
  }
];

const EDUCATION = [
  {
    key: 'what-is-if', title: 'What is intermittent fasting?', minutes: 3,
    body: [
      'Intermittent fasting is a pattern of eating that alternates between periods of eating and periods of not eating. It does not tell you what to eat — only when.',
      'The most common form is time-restricted eating, where all meals happen inside a fixed window each day. A 16:8 schedule, for example, means an 8-hour eating window and 16 hours without food.',
      'People take it up for different reasons: routine, simplicity, appetite awareness, or fitting meals around their day. Research is ongoing and results differ from person to person.'
    ]
  },
  {
    key: 'schedules', title: 'Different fasting schedules', minutes: 3,
    body: [
      '12:12 and 14:10 are the gentlest patterns — for many people they mean little more than skipping late-night snacks.',
      '16:8 is the most widely used schedule. Meals usually sit between late morning and early evening.',
      '18:6 and 20:4 narrow the window further and need more planning, because the same nutrition has to fit into less time.',
      '23:1 (one meal a day) is demanding and is not a good default. If you are curious about it, discuss it with a qualified professional first.'
    ]
  },
  {
    key: 'how-to-start', title: 'How to start fasting', minutes: 3,
    body: [
      'Start with the schedule that is closest to what you already do. If you normally finish dinner at 9pm and eat breakfast at 8am, you are already close to 12:12.',
      'Move the edges of the window by 30 minutes at a time rather than jumping straight to a long fast.',
      'Pick a window that fits your life, not one that fights it. A schedule you can keep on a busy Tuesday is worth more than a perfect one you abandon.',
      'Expect the first week to feel odd. That usually settles.'
    ]
  },
  {
    key: 'hunger', title: 'Hunger during fasting', minutes: 2,
    body: [
      'Hunger tends to come in waves rather than climbing steadily. Many people find a wave passes within 15 to 20 minutes.',
      'Habit plays a large part: if you always eat at 8am, 8am will feel hungry for a while regardless of need.',
      'Water, tea or black coffee help some people ride out a wave. Others do better with a short walk or a change of task.',
      'Hunger that comes with dizziness, shaking or feeling faint is different — that is a signal to eat and, if it repeats, to get medical advice.'
    ]
  },
  {
    key: 'hydration', title: 'Hydration during fasting', minutes: 2,
    body: [
      'A good part of most people\'s daily fluid normally arrives with food, so fasting days need deliberate drinking.',
      'Water, plain tea and black coffee are the usual choices during a fasting window.',
      'On longer fasts, headaches and cramps are often about salts rather than water alone. A pinch of salt in water can help, but do not do this if you have been told to limit sodium.'
    ]
  },
  {
    key: 'breaking', title: 'Breaking a fast', minutes: 2,
    body: [
      'After a normal daily fast, most people can eat a regular meal without any special preparation.',
      'After a longer fast, easing in tends to be more comfortable: something small and light first, then a proper meal 20 to 30 minutes later.',
      'Very large, very sugary or very fatty first meals are what people most often regret. Protein and vegetables sit better.'
    ]
  },
  {
    key: 'routine', title: 'Building a consistent routine', minutes: 2,
    body: [
      'Consistency beats intensity. Four steady 14-hour fasts a week will serve you better than one heroic 24-hour fast followed by a week off.',
      'Anchor the window to fixed points in your day — leaving work, putting the kids to bed — rather than to the clock alone.',
      'Plan rest days deliberately instead of letting them happen by accident. A planned rest day is part of the routine, not a break from it.'
    ]
  },
  {
    key: 'mistakes', title: 'Common fasting mistakes', minutes: 2,
    body: [
      'Going too long too soon, then giving up entirely.',
      'Treating the eating window as unlimited and eating well past comfort.',
      'Under-drinking, then blaming the resulting headache on fasting itself.',
      'Ignoring protein, so the total for the day falls short even though calories do not.',
      'Sticking rigidly to a schedule on a day when your body is clearly telling you otherwise.'
    ]
  },
  {
    key: 'exercise', title: 'Fasting and exercise', minutes: 2,
    body: [
      'Light and moderate activity is fine for most people during a fasting window.',
      'Hard or long training sessions usually feel better placed near or inside the eating window.',
      'If you train fasted and feel light-headed, stop. That is information, not weakness.'
    ]
  },
  {
    key: 'sleep', title: 'Fasting and sleep', minutes: 2,
    body: [
      'Finishing food a few hours before bed suits many people and often falls out of a fasting schedule naturally.',
      'Going to bed very hungry can have the opposite effect and disturb sleep. If that happens repeatedly, shift the window later.',
      'Caffeine used to push through a fast late in the day is a common hidden cause of poor sleep.'
    ]
  },
  {
    key: 'when-to-stop', title: 'When to stop fasting', minutes: 2,
    body: [
      'Stop and eat if you feel faint, shaky, confused, unusually weak, or your heart is racing.',
      'Stop if you are unwell, and do not restart until you have recovered.',
      'Speak to a qualified healthcare professional before fasting if you are pregnant or breastfeeding, take medication affected by food or blood sugar, have diabetes or any condition affecting blood sugar, or have a history of disordered eating.',
      'This app tracks what you do. It cannot assess whether fasting is right for you — only a professional who knows your history can do that.'
    ]
  }
];

const TIPS = [
  'Drink water steadily through the fasting window rather than all at once when you notice you are behind.',
  'A consistent schedule is easier to keep than a perfect one.',
  'Hunger usually arrives in waves. Give a wave twenty minutes before deciding anything.',
  'Try not to compensate for a long fast with an oversized first meal.',
  'Protein and vegetables first; they make the eating window feel longer.',
  'Plan your rest days rather than letting them happen by accident.',
  'Light activity during a fast is fine for most people. Heavy training usually sits better near the eating window.',
  'Black coffee and plain tea are fine for most people during a fast.',
  'If a schedule keeps failing on the same day of the week, change the schedule, not the day.',
  'Track the days you do fast. The pattern matters more than any single day.'
];

const DAILY_TASKS = [
  { key: 'learn-basics', title: 'Learn how to fast', description: 'Read the basics of intermittent fasting.', minutes: 3, link: 'what-is-if' },
  { key: 'hydrate', title: 'Stay hydrated', description: 'Log your water intake for today.', minutes: 1 },
  { key: 'complete-fast', title: 'Complete your fast', description: 'Finish the fasting session you started.', minutes: null },
  { key: 'learn-hunger', title: 'Learn about hunger', description: 'Understand how hunger behaves during a fast.', minutes: 2, link: 'hunger' },
  { key: 'break-fast', title: 'Break your fast well', description: 'Read how to eat after a fasting period.', minutes: 2, link: 'breaking' }
];

const GOAL_OPTIONS = [
  'Build a consistent fasting routine',
  'Track fasting habits',
  'Maintain a regular eating schedule',
  'Improve consistency',
  'Track hydration',
  'Track nutrition'
];

const SAFETY = {
  headline: 'Fasting is not suitable for everyone.',
  points: [
    'Speak to a qualified healthcare professional before fasting if you are pregnant or breastfeeding, have diabetes or another condition affecting blood sugar, take medication affected by food intake, or have a history of an eating disorder.',
    'Stop the fast and eat if you feel faint, shaky, confused or unwell.',
    'This tracker records what you choose to do. It does not give medical advice and cannot tell you whether a schedule is safe for you.',
    'Longer schedules are not better schedules. Consistency at a moderate window beats an extreme one you cannot sustain.'
  ]
};

/** Which stage a fast is in, given hours elapsed. */
function stageFor(hours) {
  return STAGES.find(s => hours >= s.from && hours < s.to) || STAGES[STAGES.length - 1];
}

/** A stable "tip of the day" — same tip all day, different tomorrow. */
function tipForDate(dateStr) {
  const seed = String(dateStr || '').split('-').join('');
  const n = parseInt(seed, 10) || 0;
  return TIPS[n % TIPS.length];
}

module.exports = { SCHEDULES, STAGES, EDUCATION, TIPS, DAILY_TASKS, GOAL_OPTIONS, SAFETY, stageFor, tipForDate };
