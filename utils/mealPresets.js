/* ============================================================
   Commonly-assigned meals — a quick-add library for the coach's
   "Assign plan" screen. These are just starting points: the coach
   picks one to pre-fill a meal row, then can rename, retype or
   re-calorie it (or delete it) before applying. Nothing here is
   locked in — it only saves the coach re-typing the same handful
   of meals for every client, every day.
   ============================================================ */
const MEAL_PRESETS = [
  { type: 'morning_detox', name: 'Warm lemon water', calories: 5 },
  { type: 'morning_detox', name: 'Black coffee (no sugar)', calories: 5 },
  { type: 'breakfast', name: 'Sprouts & moong dal chilla', calories: 280 },
  { type: 'breakfast', name: 'Vegetable poha', calories: 250 },
  { type: 'breakfast', name: '3-egg omelette + veggies', calories: 300 },
  { type: 'lunch', name: '2 roti + dal + sabzi + salad', calories: 450 },
  { type: 'lunch', name: 'Grilled chicken + brown rice + salad', calories: 500 },
  { type: 'lunch', name: 'Rajma/chole + rice + curd', calories: 480 },
  { type: 'snack', name: 'Roasted chana / makhana', calories: 150 },
  { type: 'snack', name: 'Buttermilk (chaas)', calories: 60 },
  { type: 'snack', name: 'Fruit bowl (seasonal)', calories: 120 },
  { type: 'dinner', name: 'Vegetable soup + grilled paneer', calories: 350 },
  { type: 'dinner', name: 'Khichdi + curd', calories: 400 },
  { type: 'dinner', name: 'Grilled fish + steamed vegetables', calories: 380 }
];

module.exports = { MEAL_PRESETS };
