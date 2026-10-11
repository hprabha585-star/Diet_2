// One-time (but safe to re-run every boot) repair for clients who should
// have DUAL plan access (e.g. a 30-day or 55-day coached plan AND the
// Fasting Tracker) but don't, because they were first approved for one
// plan back before hasProtocolAccess/hasTrackerAccess existed — so that
// access was only ever implied by planMode — and a LATER approval for the
// other kind of plan overwrote planMode, silently erasing the earlier one
// (nothing had ever set the explicit flag to remember it).
//
// This scans every client's full APPROVED payment history and makes sure
// both flags reflect every plan mode they've ever been approved for, not
// just whichever plan happens to be "current". It only ever adds access,
// never removes it, and is a no-op (not even a DB write) for anyone whose
// flags already match — so it's cheap and harmless to run on every boot.
async function backfillDualPlanAccess() {
  const { User, Payment, Plan } = require('../models');
  const [clients, approvedPayments, plans] = await Promise.all([
    User.findAll({ where: { role: 'client' } }),
    Payment.findAll({ where: { status: 'approved' } }),
    Plan.findAll()
  ]);

  const modeByTier = new Map(plans.map(p => [p.key, p.mode]));
  const paymentsByUser = new Map();
  for (const pay of approvedPayments) {
    if (!paymentsByUser.has(pay.userId)) paymentsByUser.set(pay.userId, []);
    paymentsByUser.get(pay.userId).push(pay);
  }

  let fixed = 0;
  for (const client of clients) {
    let needsProtocol = client.hasProtocolAccess || client.planMode === 'protocol';
    let needsTracker = client.hasTrackerAccess || client.planMode === 'tracker';

    for (const pay of (paymentsByUser.get(client.id) || [])) {
      const mode = modeByTier.get(pay.tier);
      if (mode === 'tracker') needsTracker = true;
      else if (mode === 'protocol') needsProtocol = true;
      // Plan since deleted (mode unknown) — nothing more we can infer from
      // this one payment; the planMode/flag fallback above still applies.
    }

    if (needsProtocol !== !!client.hasProtocolAccess || needsTracker !== !!client.hasTrackerAccess) {
      client.hasProtocolAccess = needsProtocol;
      client.hasTrackerAccess = needsTracker;
      await client.save();
      fixed++;
    }
  }
  if (fixed) console.log(`backfillDualPlanAccess: restored dual-plan access for ${fixed} client(s).`);
}

module.exports = { backfillDualPlanAccess };
