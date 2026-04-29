// Cyberpunk Red Core (cpr) — system shim.
//
// Registers states the engine can evaluate for CPR actors. Three categories:
//
//   1. Persistent states from actor data (wound state, in-combat).
//      Detected via Foundry's standard updateActor/createCombatant hooks
//      (no system-specific hooks needed; CPR fires none).
//
//   2. Ephemeral roll states (rolling.handgun, rolling.melee, ...).
//      CPR fires zero custom roll hooks. We dynamically import CPR's roll
//      module and patch CPRRoll.prototype.roll to fire OUR custom hook
//      when a roll subclass is detected.
//
//   3. The CPR explicit "dead" wound state (currentWoundState === "dead",
//      which CPR never auto-sets — GM must manually mark).
//
// All persistent states use the abstract semantic IDs (`unconscious`,
// `bloodied`, `wounded`, `dead`, `inCombat`) so user config in the actor
// editor is portable across systems. The CPR-specific states use the
// `cpr.*` prefix.

import { MODULE_ID } from "../scripts/module.mjs";
import { scheduleReevaluate } from "../scripts/core/state-engine.mjs";

const SYSTEM_ID = "cyberpunk-red-core";

// IMPORTANT: hardcoded — do NOT use `${MODULE_ID}.systemEvent` at top level.
// The STATES array below is built at module-load time, when MODULE_ID is still
// in the temporal dead zone due to the circular import (module.mjs imports us,
// we import module.mjs back). Touching MODULE_ID at top level throws
// ReferenceError. Inside functions is fine because functions execute later.
const SYSTEM_EVENT_HOOK = "vebjorns-state-aware-tokens.systemEvent";

// Per-token transient marker for "currently rolling X". Cleared after durationMs.
const _activeRolls = new Map(); // actorId -> Set<stateId>

// CPR weapon-type → state id (rolling categories)
const WEAPON_GROUPS = {
  melee:         ["lightMelee", "medMelee", "heavyMelee", "vHeavyMelee", "martialArts", "unarmed"],
  handgun:       ["medPistol", "heavyPistol", "vHeavyPistol"],
  shoulderArms:  ["assaultRifle", "sniperRifle", "shotgun", "smg", "heavySmg"],
};

function _classifyWeaponType(weaponType) {
  for (const [group, types] of Object.entries(WEAPON_GROUPS)) {
    if (types.includes(weaponType)) return `cpr.rolling.${group}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// libWrapper-style patching of CPRRoll.prototype.roll

let _cprRollClasses = null;

/** Probe known places for CPR's roll classes. CPR ships as a bundled `cpr.js`
 *  so `import()` of source paths doesn't work. We look for the classes on
 *  globals / game.cpr / CONFIG.Dice.rolls. If CPR doesn't expose them, the
 *  ephemeral roll states stay disabled (persistent states still work). */
function _probeCPRRollClasses() {
  if (_cprRollClasses) return _cprRollClasses;

  // Common candidate locations
  const candidates = {
    CPRRoll:           globalThis.CPRRoll          ?? game.cpr?.rolls?.CPRRoll          ?? game.cpr?.CPRRoll,
    CPRSkillRoll:      globalThis.CPRSkillRoll     ?? game.cpr?.rolls?.CPRSkillRoll     ?? game.cpr?.CPRSkillRoll,
    CPRAttackRoll:     globalThis.CPRAttackRoll    ?? game.cpr?.rolls?.CPRAttackRoll    ?? game.cpr?.CPRAttackRoll,
    CPRDeathSaveRoll:  globalThis.CPRDeathSaveRoll ?? game.cpr?.rolls?.CPRDeathSaveRoll ?? game.cpr?.CPRDeathSaveRoll,
  };

  // Fallback: search CONFIG.Dice.rolls (CPR may register subclasses there)
  if (!candidates.CPRRoll && Array.isArray(CONFIG.Dice?.rolls)) {
    candidates.CPRRoll = CONFIG.Dice.rolls.find(r => r?.name === "CPRRoll");
  }

  if (typeof candidates.CPRRoll !== "function") {
    console.warn(`${MODULE_ID} | CPRRoll class not found; ephemeral roll-state detection disabled. ` +
                 `Persistent states (wounded, unconscious, inCombat, etc.) still work.`);
    return null;
  }

  _cprRollClasses = candidates;
  return _cprRollClasses;
}

function _installRollWrap() {
  const cprRolls = _probeCPRRollClasses();
  if (!cprRolls?.CPRRoll) return false;

  if (!globalThis.libWrapper?.register) {
    console.warn(`${MODULE_ID} | libWrapper not available; falling back to direct prototype patch`);
    const orig = cprRolls.CPRRoll.prototype.roll;
    cprRolls.CPRRoll.prototype.roll = async function () {
      const result = await orig.call(this);
      _onRollComplete(this, cprRolls);
      return result;
    };
    console.log(`${MODULE_ID} | CPRRoll.prototype.roll patched (direct, no libWrapper)`);
    return true;
  }

  // Expose the class to a stable global so libWrapper has a string path target.
  globalThis.__vsat_cpr = { Roll: cprRolls.CPRRoll };

  libWrapper.register(
    MODULE_ID,
    "globalThis.__vsat_cpr.Roll.prototype.roll",
    async function (wrapped, ...args) {
      const result = await wrapped.apply(this, args);
      _onRollComplete(this, cprRolls);
      return result;
    },
    "WRAPPER"
  );
  console.log(`${MODULE_ID} | CPRRoll.prototype.roll wrapped via libWrapper`);
  return true;
}

function _onRollComplete(cprRoll, cprRolls) {
  // Identify the actor.
  const actorId = cprRoll?.entityData?.actor;
  const actor = actorId ? game.actors.get(actorId) : null;
  if (!actor) return;

  // Classify the roll into a state ID.
  let stateId = null;
  if (cprRoll instanceof cprRolls.CPRDeathSaveRoll) {
    stateId = "cpr.rolling.deathSave";
  } else if (cprRoll instanceof cprRolls.CPRAttackRoll) {
    // Aimed/Autofire/Suppressive all extend CPRAttackRoll.
    stateId = _classifyWeaponType(cprRoll.weaponType) ?? "cpr.rolling.melee";
  } else if (cprRoll instanceof cprRolls.CPRSkillRoll) {
    stateId = "cpr.rolling.skill";
  }

  if (!stateId) return;

  // Mark as active for this actor; ephemeral states will time out via the engine.
  let set = _activeRolls.get(actor.id);
  if (!set) { set = new Set(); _activeRolls.set(actor.id, set); }
  set.add(stateId);

  // Trigger re-eval. The ephemeral state's durationMs in the engine handles cleanup.
  scheduleReevaluate(actor, { source: "cpr-roll", stateId });

  // Auto-clear after a reasonable window (in case the engine's ephemeral timer
  // doesn't fire, e.g. if the engine cleared the state for higher priority).
  setTimeout(() => {
    set.delete(stateId);
    scheduleReevaluate(actor, { source: "cpr-roll-clear", stateId });
  }, 2500);
}

function _hasActiveRoll(actor, stateId) {
  return _activeRolls.get(actor.id)?.has(stateId) ?? false;
}

// ---------------------------------------------------------------------------
// State definitions

function _isInCombat(actor) {
  return game.combats.some(c =>
    c.active && c.combatants.some(cbt => cbt.actorId === actor.id)
  );
}

function _woundStateIs(actor, value) {
  return actor?.system?.derivedStats?.currentWoundState === value;
}

const STATES = [
  // ── Wound states (mapped to abstract semantic IDs) ─────────────────────
  {
    id: "dead",
    priority: 1000,
    predicate: (actor) => _woundStateIs(actor, "dead"),
    triggers: [{ hook: "updateActor" }],
    description: "VSAT.State.dead.Description",
    systemTag: "cpr",
  },
  {
    id: "cpr.dead",
    priority: 990,
    predicate: (actor) => _woundStateIs(actor, "dead"),
    triggers: [{ hook: "updateActor" }],
    description: "VSAT.State.cpr.dead.Description",
    systemTag: "cpr",
  },
  {
    id: "cpr.rolling.deathSave",
    priority: 950,
    ephemeral: true,
    durationMs: 3000,
    predicate: (actor) => _hasActiveRoll(actor, "cpr.rolling.deathSave"),
    triggers: [{ hook: SYSTEM_EVENT_HOOK }],
    description: "VSAT.State.cpr.rolling.deathSave.Description",
    systemTag: "cpr",
  },
  {
    id: "unconscious", // semantic abstract — CPR's mortallyWounded
    priority: 900,
    predicate: (actor) => _woundStateIs(actor, "mortallyWounded"),
    triggers: [{ hook: "updateActor" }],
    description: "VSAT.State.unconscious.Description",
    systemTag: "cpr",
  },
  {
    id: "bloodied", // semantic abstract — CPR's seriouslyWounded
    priority: 700,
    predicate: (actor) => _woundStateIs(actor, "seriouslyWounded"),
    triggers: [{ hook: "updateActor" }],
    description: "VSAT.State.bloodied.Description",
    systemTag: "cpr",
  },

  // ── Ephemeral roll states (lower priority than wound states; rolls
  //    mid-combat should still show wound state primarily) ──────────────
  {
    id: "cpr.rolling.handgun",
    priority: 350,
    ephemeral: true,
    durationMs: 2000,
    predicate: (actor) => _hasActiveRoll(actor, "cpr.rolling.handgun"),
    triggers: [{ hook: SYSTEM_EVENT_HOOK }],
    description: "VSAT.State.cpr.rolling.handgun.Description",
    systemTag: "cpr",
  },
  {
    id: "cpr.rolling.shoulderArms",
    priority: 350,
    ephemeral: true,
    durationMs: 2000,
    predicate: (actor) => _hasActiveRoll(actor, "cpr.rolling.shoulderArms"),
    triggers: [{ hook: SYSTEM_EVENT_HOOK }],
    description: "VSAT.State.cpr.rolling.shoulderArms.Description",
    systemTag: "cpr",
  },
  {
    id: "cpr.rolling.melee",
    priority: 350,
    ephemeral: true,
    durationMs: 2000,
    predicate: (actor) => _hasActiveRoll(actor, "cpr.rolling.melee"),
    triggers: [{ hook: SYSTEM_EVENT_HOOK }],
    description: "VSAT.State.cpr.rolling.melee.Description",
    systemTag: "cpr",
  },
  {
    id: "cpr.rolling.skill",
    priority: 300,
    ephemeral: true,
    durationMs: 1500,
    predicate: (actor) => _hasActiveRoll(actor, "cpr.rolling.skill"),
    triggers: [{ hook: SYSTEM_EVENT_HOOK }],
    description: "VSAT.State.cpr.rolling.skill.Description",
    systemTag: "cpr",
  },

  // ── Persistent low-priority states ─────────────────────────────────────
  {
    id: "wounded", // semantic — CPR's lightlyWounded
    priority: 200,
    predicate: (actor) => _woundStateIs(actor, "lightlyWounded"),
    triggers: [{ hook: "updateActor" }],
    description: "VSAT.State.wounded.Description",
    systemTag: "cpr",
  },
  {
    id: "inCombat",
    priority: 100,
    predicate: (actor) => _isInCombat(actor),
    triggers: [
      { hook: "createCombatant" },
      { hook: "deleteCombatant" },
      { hook: "deleteCombat" },
    ],
    description: "VSAT.State.inCombat.Description",
    systemTag: "cpr",
  },
];

// ---------------------------------------------------------------------------
// Entry point — called by module.mjs from the ready hook

export async function installCPRShim(api) {
  if (game.system.id !== SYSTEM_ID) return false;

  // Install the libWrapper-driven roll detector.
  const wrapped = await _installRollWrap();
  if (!wrapped) {
    console.warn(`${MODULE_ID} | could not patch CPRRoll.prototype.roll; ephemeral roll states disabled`);
  }

  // Register all the states.
  api.addSystemIntegration({
    systemId: SYSTEM_ID,
    states:   STATES,
  });

  console.log(`${MODULE_ID} | CPR shim installed (${STATES.length} states)`);
  return true;
}
