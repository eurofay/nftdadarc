// Sending before the stage opens, so the transaction ARRIVES when it opens.
//
// At fire time the critical path is a single round trip: the transaction is
// already signed (local, no network) and the socket is already warm, so the
// only thing between deciding and sending is one eth_sendRawTransaction. That
// is the floor — no amount of code gets below one round trip.
//
// But arrival time is not the same as send time. Sending at T when the flight
// takes 7ms means arriving at T+7ms, and losing to anyone closer. Sending at
// T-7ms means arriving at T. The wire time is spent either way; the only
// question is whether it is spent before the stage opens or after.
//
// THE DANGEROUS DIRECTION IS EARLY. This chain's sequencer has no public
// mempool — it executes on arrival. A transaction that lands before the stage
// opens does not wait, it reverts, and a revert costs gas. So the lead is
// deliberately biased to land just after the open rather than just before:
// being 2ms late costs nothing, being 2ms early costs a mint and a fee.

/** Setting value meaning "measure it and decide". */
export const EARLY_FIRE_AUTO = -1;

/**
 * Fraction of the estimated flight time to actually lead by.
 *
 * Below 1 on purpose. Clock skew, scheduler jitter and a variable network all
 * push the real arrival either side of the estimate, and the two sides are
 * not symmetric — late is free, early is a reverted mint.
 */
export const EARLY_FIRE_SAFETY = 0.75;

/**
 * Never lead by more than this, whatever is measured or configured.
 *
 * A quarter second of lead implies a half-second round trip, which on a
 * healthy path means the measurement is wrong rather than the network being
 * slow. Trusting it would fire a long way before the stage opened.
 */
export const EARLY_FIRE_CAP_MS = 250;

/**
 * How long the transaction spends in flight, from a round-trip measurement.
 *
 * Half of it: the round trip is out and back, and the transaction only has to
 * get there. Leading by the full round trip is the obvious mistake here and
 * would put every send a whole flight time before the stage opened.
 */
export function flightTimeMs(roundTripMs: number): number {
  return roundTripMs / 2;
}

/**
 * The lead to apply, given the setting and whatever the network measured.
 *
 * Returns milliseconds to subtract from the stage start. Zero means send at
 * the stage start, which is what this did before any of it existed.
 */
export function resolveEarlyFire(setting: number, roundTripMs: number | null): number {
  if (!Number.isFinite(setting) || setting === 0) return 0;

  if (setting === EARLY_FIRE_AUTO) {
    // No measurement means no basis for guessing. Sending at the stage start
    // is the honest fallback: later than ideal, never early.
    if (roundTripMs === null || !Number.isFinite(roundTripMs) || roundTripMs <= 0) return 0;
    const lead = Math.floor(flightTimeMs(roundTripMs) * EARLY_FIRE_SAFETY);
    return Math.max(0, Math.min(lead, EARLY_FIRE_CAP_MS));
  }

  if (setting < 0) return 0; // any other negative is not a sentinel we know
  return Math.min(Math.floor(setting), EARLY_FIRE_CAP_MS);
}

/** One line for the log, so the choice is visible when a mint is reviewed. */
export function describeEarlyFire(setting: number, roundTripMs: number | null, lead: number): string {
  if (lead === 0) {
    if (setting === EARLY_FIRE_AUTO && roundTripMs === null) {
      return "Early fire: off — the round trip could not be measured, so sending at the stage start.";
    }
    return "Early fire: off — sending at the stage start.";
  }
  if (setting === EARLY_FIRE_AUTO) {
    return (
      `Early fire: ${lead}ms — round trip measured at ${Math.round(roundTripMs!)}ms, ` +
      `so ~${Math.round(flightTimeMs(roundTripMs!))}ms in flight, led by ${Math.round(EARLY_FIRE_SAFETY * 100)}% of it ` +
      "to land just after the open rather than just before."
    );
  }
  return `Early fire: ${lead}ms — your setting. Landing early reverts, so keep it under the one-way flight time.`;
}
