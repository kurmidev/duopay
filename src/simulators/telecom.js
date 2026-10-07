// Telecom simulator: delivers an SMS sent from a SIM to a PSP VMN, stamping the
// originating number the network knows for that SIM. The app cannot forge this number,
// which is why SMS device binding proves possession of the SIM.

export function createTelecom(world, pspSwitch) {
  return {
    sendSms({ iccid, to, text }) {
      const sim = world.sims.find((s) => s.iccid === iccid);
      if (!sim) return { delivered: false, reason: 'UNKNOWN_SIM' };
      if (!world.vmns.includes(to)) return { delivered: false, reason: 'NOT_A_PSP_NUMBER' };
      pspSwitch.inboundSms({ vmn: to, text: String(text).slice(0, 160), originMsisdn: sim.msisdn });
      return { delivered: true };
    },
  };
}
