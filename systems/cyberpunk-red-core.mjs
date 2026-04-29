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

/** CPR encapsulates CPRRoll inside its bundle — it's not on globalThis,
 *  game.cpr, or CONFIG.Dice.rolls. So we can't patch CPRRoll.prototype.roll
 *  directly. Instead we wrap the actor sheets' _onRoll(event) handler, which
 *  is the entry point for every roll users initiate via the sheet. The event
 *  carries data-roll-type and data-item-id attributes that tell us what
 *  kind of roll is starting. We fire our ephemeral state immediately and
 *  schedule a clear after the roll-display window passes. */

const ROLL_TYPE_TO_STATE = {
  deathsave:    "cpr.rolling.deathSave",
  skill:        "cpr.rolling.skill",
  // Attack subtypes — actual weaponType refines further to handgun/shoulderArms/melee.
  attack:       "cpr.rolling.melee",         // fallback if weaponType unknown
  aimed:        "cpr.rolling.melee",
  autofire:     "cpr.rolling.melee",
  suppressive:  "cpr.rolling.melee",
};

function _stateForSheetRoll(actor, event) {
  const target = event?.currentTarget ?? event?.target;
  const rollType = target?.dataset?.rollType?.toLowerCase();
  if (!rollType) return null;

  // Attack rolls — refine by weapon type.
  if (["attack", "aimed", "autofire", "suppressive"].includes(rollType)) {
    const itemId = target.dataset.itemId;
    const item = itemId ? actor?.items?.get(itemId) : null;
    const weaponType = item?.system?.weaponType;
    return _classifyWeaponType(weaponType) ?? ROLL_TYPE_TO_STATE[rollType];
  }

  return ROLL_TYPE_TO_STATE[rollType] ?? null;
}

function _markRollActive(actor, stateId, durationMs = 2500) {
  if (!actor || !stateId) return;
  let set = _activeRolls.get(actor.id);
  if (!set) { set = new Set(); _activeRolls.set(actor.id, set); }
  set.add(stateId);
  scheduleReevaluate(actor, { source: "cpr-onRoll", stateId });
  setTimeout(() => {
    set.delete(stateId);
    scheduleReevaluate(actor, { source: "cpr-onRoll-clear", stateId });
  }, durationMs);
}

/** Patch _onRoll on every CPR actor sheet class we can reach. Direct
 *  prototype patching (not libWrapper) because each sheet class is a
 *  unique target; libWrapper namespacing would be more verbose for no
 *  real benefit. CPR is the only consumer of these methods. */
function _installSheetRollWraps() {
  const apps = game.cpr?.apps ?? {};
  const SHEET_CLASSES = [
    "CPRCharacterActorSheet",
    "CPRMookActorSheet",
    "CPRBlackIceActorSheet",
    "CPRDemonActorSheet",
  ];

  let wrapped = 0;
  for (const className of SHEET_CLASSES) {
    const SheetClass = apps[className];
    if (typeof SheetClass !== "function") continue;
    const proto = SheetClass.prototype;
    if (typeof proto._onRoll !== "function") continue;
    if (proto.__vsatRollWrapped) continue;  // idempotent

    const original = proto._onRoll;
    proto._onRoll = async function (event) {
      try {
        const stateId = _stateForSheetRoll(this.actor, event);
        if (stateId) _markRollActive(this.actor, stateId);
      } catch (err) {
        console.error(`${MODULE_ID} | error pre-detecting CPR roll:`, err);
      }
      return original.call(this, event);
    };
    proto.__vsatRollWrapped = true;
    wrapped++;
  }

  if (wrapped > 0) {
    console.log(`${MODULE_ID} | wrapped _onRoll on ${wrapped} CPR actor sheet class(es)`);
    return true;
  }

  console.warn(`${MODULE_ID} | no CPR actor sheets found to wrap; ephemeral roll states disabled`);
  return false;
}

function _hasActiveRoll(actor, stateId) {
  return _activeRolls.get(actor.id)?.has(stateId) ?? false;
}

// ---------------------------------------------------------------------------
// State definitions

function _isInCombat(actor) {
  // Match if any combatant in any combat references this actor.
  // Previously gated on c.active, but V12's Combat.active flag isn't always
  // set when a combatant is added to the tracker — leading to false
  // negatives for "I added them and clicked Begin Combat but the swap
  // didn't fire". Treat any tracker membership as in-combat.
  return game.combats.some(c =>
    c.combatants?.some(cbt => cbt.actorId === actor.id)
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

  // Install the sheet-level _onRoll wrapper for ephemeral roll-state detection.
  _installSheetRollWraps();

  // Register all the states.
  api.addSystemIntegration({
    systemId: SYSTEM_ID,
    states:   STATES,
  });

  console.log(`${MODULE_ID} | CPR shim installed (${STATES.length} states)`);
  return true;
}
