// Cyberpunk Red Core (cpr) — system shim.
//
// Two categories of states:
//
//   1. Persistent states from actor data (wound state, in-combat).
//      Detected via Foundry-native hooks (updateActor / createCombatant /
//      deleteCombat). CPR fires zero custom hooks of its own.
//
//   2. Ephemeral state for "actor is rolling something right now"
//      (`cpr.rolling`, 2.5 s window). Detected via `createChatMessage`,
//      because CPR creates a chat card for EVERY roll regardless of
//      whether the user clicked the actor sheet, used Token Action HUD,
//      or invoked a macro. This catches them all uniformly.
//
// The shim deliberately does NOT differentiate weapon types or roll
// subtypes — one rolling state for any CPR roll. The user can still
// configure a single dramatic image for "I am rolling something" and
// it'll fire reliably.

import { MODULE_ID } from "../scripts/module.mjs";
import { scheduleReevaluate } from "../scripts/core/state-engine.mjs";

const SYSTEM_ID = "cyberpunk-red-core";

// ---------------------------------------------------------------------------
// Ephemeral roll state — set briefly when ANY CPR roll happens for an actor.

const _activeRolls = new Map();   // actorId -> {timer, count}
const ROLL_DURATION_MS = 2500;

function _markRollActive(actor) {
  if (!actor) return;
  const prior = _activeRolls.get(actor.id);
  if (prior?.timer) clearTimeout(prior.timer);

  const timer = setTimeout(() => {
    _activeRolls.delete(actor.id);
    scheduleReevaluate(actor, { source: "cpr-roll-clear" });
  }, ROLL_DURATION_MS);

  _activeRolls.set(actor.id, { timer });
  scheduleReevaluate(actor, { source: "cpr-roll" });
}

function _hasActiveRoll(actor) {
  return _activeRolls.has(actor?.id);
}

/** Listen to chat-message creation. CPR fires CPRChat.RenderRollCard for
 *  every roll, which calls ChatMessage.create. We pick up the speaker.actor
 *  and mark a transient rolling state for that actor.
 *
 *  This catches:
 *    - Actor sheet button rolls
 *    - Token Action HUD rolls
 *    - Macro-driven rolls
 *    - Anything else that ends up creating a CPR roll card
 *
 *  We don't filter by message flags or roll type — the broad signal is
 *  what the user wants. The 2.5 s window matches the typical roll-card
 *  display time. */
function _installRollDetection() {
  Hooks.on("createChatMessage", (message) => {
    if (game.system.id !== SYSTEM_ID) return;

    // Cheap pre-filter: only act on messages that have rolls or look like
    // CPR roll cards. CPR's chat cards always set a speaker.
    const speaker = message.speaker;
    if (!speaker?.actor) return;

    const actor = game.actors.get(speaker.actor);
    if (!actor) return;

    // Look for SOME signal this is a roll-card. CPR roll cards always
    // contain at least a roll OR the cpr base-rollcard template flavor.
    // We accept both: presence of any roll OR a flavor that mentions cpr.
    const hasRolls = !!message.rolls?.length;
    const flavor = message.flavor ?? "";
    const looksCPR =
      hasRolls ||
      flavor.includes("CPR") ||
      flavor.toLowerCase().includes("cyberpunk") ||
      message.flags?.[SYSTEM_ID];
    if (!looksCPR) return;

    _markRollActive(actor);
  });

  console.log(`${MODULE_ID} | CPR roll detection installed (createChatMessage listener)`);
}

// ---------------------------------------------------------------------------
// State definitions

function _isInCombat(actor) {
  // Match if any combatant in any combat references this actor.
  // We do NOT gate on c.active here — V12's Combat.active flag isn't
  // reliable across "Begin Combat" workflows. Tracker membership is the
  // real signal we care about.
  return game.combats.some(c =>
    c.combatants?.some(cbt => cbt.actorId === actor.id)
  );
}

function _woundStateIs(actor, value) {
  return actor?.system?.derivedStats?.currentWoundState === value;
}

const STATES = [
  // ── Wound states (mapped to abstract semantic IDs where possible) ─────
  {
    id: "dead",
    priority: 1000,
    predicate: (actor) => _woundStateIs(actor, "dead"),
    triggers: [{ hook: "updateActor" }],
    description: "VSAT.State.dead.Description",
    systemTag: "cpr",
  },
  {
    id: "unconscious", // CPR's "mortallyWounded" maps here (HP < 1)
    priority: 900,
    predicate: (actor) => _woundStateIs(actor, "mortallyWounded"),
    triggers: [{ hook: "updateActor" }],
    description: "VSAT.State.unconscious.Description",
    systemTag: "cpr",
  },
  {
    id: "bloodied", // CPR's "seriouslyWounded"
    priority: 700,
    predicate: (actor) => _woundStateIs(actor, "seriouslyWounded"),
    triggers: [{ hook: "updateActor" }],
    description: "VSAT.State.bloodied.Description",
    systemTag: "cpr",
  },

  // ── Single ephemeral rolling state ────────────────────────────────────
  {
    id: "cpr.rolling",
    priority: 350,
    ephemeral: true,
    durationMs: ROLL_DURATION_MS,
    predicate: (actor) => _hasActiveRoll(actor),
    // Trigger via the engine's reevaluate call from _markRollActive — no
    // hook gymnastics needed.
    triggers: [],
    description: "VSAT.State.cpr.rolling.Description",
    systemTag: "cpr",
  },

  // ── Persistent low-priority states ────────────────────────────────────
  {
    id: "wounded", // CPR's "lightlyWounded"
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
      { hook: "updateCombat" },
    ],
    description: "VSAT.State.inCombat.Description",
    systemTag: "cpr",
  },
];

// ---------------------------------------------------------------------------
// Entry point — called by module.mjs from the ready hook

export async function installCPRShim(api) {
  if (game.system.id !== SYSTEM_ID) return false;

  _installRollDetection();

  api.addSystemIntegration({
    systemId: SYSTEM_ID,
    states:   STATES,
  });

  console.log(`${MODULE_ID} | CPR shim installed (${STATES.length} states; simplified roll detection via createChatMessage)`);
  return true;
}
