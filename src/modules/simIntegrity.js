// Continuous SIM integrity per profile (LLD §4.3, ADR-006).
import { nowMs } from '../lib/time.js';
import * as profiles from './profiles.js';

/**
 * Compares the signed SIM state the device reported with each live profile's bound SIM.
 * Applies suspensions / deregistrations / reactivations and returns what happened.
 */
export function check(ctx, installationId, simState) {
  const results = [];
  ctx.db.tx(() => {
    for (const p of profiles.liveForInstallation(ctx, installationId)) {
      const s = simState.slots.find((x) => x.slot === p.slot);
      let action = 'OK';
      let reason = null;
      if (!s || s.state !== 'READY') { action = 'SUSPEND'; reason = 'SIM_ABSENT'; }
      else if (s.fp !== p.sim_fp) { action = 'DEREGISTER'; reason = 'SIM_CHANGED'; }
      else if (simState.airplane) { action = 'SUSPEND'; reason = 'AIRPLANE_MODE'; }
      else if (p.state === 'SUSPENDED') { action = 'REACTIVATE'; reason = 'SIM_PRESENT'; }

      // A profile whose SIM has been absent too long is retired (LLD §4.2).
      if (action === 'SUSPEND' && p.state === 'SUSPENDED' && p.suspended_at
          && nowMs() - new Date(p.suspended_at).getTime() > ctx.cfg.suspendTtlDays * 86_400_000) {
        action = 'DEREGISTER'; reason = 'SUSPENDED_TOO_LONG';
      }

      if (action === 'SUSPEND' && p.state === 'ACTIVE') profiles.transition(ctx, p.id, 'suspend', reason);
      else if (action === 'DEREGISTER') profiles.transition(ctx, p.id, 'deregister', reason);
      else if (action === 'REACTIVATE') profiles.transition(ctx, p.id, 'reactivate', reason);
      else if (action === 'SUSPEND' && p.state !== 'ACTIVE') action = 'OK'; // already suspended or still BOUND
      if (action !== 'OK') results.push({ profileId: p.id, slot: p.slot, action, reason });
    }
  });
  return results;
}
