// Recommended CPR Combat Pack — a curated bundle of states with
// sensible priorities for combat-focused Cyberpunk Red Core campaigns.
//
// In v0.1 the pack mechanism is essentially a *label* that confirms
// "the user wants the defaults the CPR shim ships with". Future versions
// (v0.2+) may use packs to:
//   - override default priorities
//   - disable certain shim states (e.g. mute roll-state ephemeral reactions)
//   - add user-curated states (HP threshold, status effects, compounds)
//
// For now this file exports a manifest object that documents the pack and
// optionally adds a few extra abstract states that the CPR shim doesn't
// register on its own.

export const CPRRecommendedPack = Object.freeze({
  id: "cpr-recommended",
  label: "Recommended CPR Combat Pack",
  description:
    "A combat-focused state set: persistent wound stages, in-combat marker, " +
    "and ephemeral attack/skill-rolling reactions. Priorities are tuned so " +
    "wound-state visuals dominate over rolling reactions.",
  systemId: "cyberpunk-red-core",
  // States this pack adds ON TOP of the shim's defaults. v0.1 = empty;
  // the shim already registers the full set. This list is read by
  // the public API's addStatePack() helper.
  states: [],
});
