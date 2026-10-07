// Clock access goes through here so tests can control time.
let clock = () => Date.now();

export const setClock = (fn) => { clock = fn; };
export const resetClock = () => { clock = () => Date.now(); };
export const nowMs = () => clock();
export const nowIso = () => new Date(clock()).toISOString();

const IST_OFFSET_MS = 330 * 60_000;

/** Limits reset on the Indian calendar day (IST, UTC+05:30). */
export function istDay(ms = clock()) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC ISO timestamp of the start of the IST day containing `ms`. */
export function istDayStartIso(ms = clock()) {
  const d = new Date(ms + IST_OFFSET_MS);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - IST_OFFSET_MS).toISOString();
}

export const isoMinus = (sec) => new Date(clock() - sec * 1000).toISOString();
