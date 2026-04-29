// Trigger Bus — subscribes to Foundry-native hooks and Sequencer-style custom
// hooks fired by system shims, then routes the signal to the state engine.
//
// The bus only knows the universal triggers. Each registered state declares
// its own trigger list, but the bus listens to the union of all triggers and
// fires re-evaluations for affected actors. The engine's evaluate() function
// re-checks every state's predicate, so over-evaluation is safe (just slower).

import { MODULE_ID } from "../module.mjs";
import { scheduleReevaluate, scheduleReevaluateToken } from "./state-engine.mjs";

/** Attach all listeners. Idempotent — safe to call once at ready. */
export function installTriggerBus() {
  // ── Combat lifecycle ─────────────────────────────────────────────────────
  Hooks.on("combatStart", (combat) => _reevaluateCombatants(combat, "combatStart"));
  Hooks.on("deleteCombat", (combat) => _reevaluateCombatants(combat, "deleteCombat"));
  Hooks.on("updateCombat", (combat, changes) => {
    if (changes.turn !== undefined || changes.round !== undefined) {
      _reevaluateCombatants(combat, "combatTurn/Round");
    }
  });
  Hooks.on("createCombatant", (combatant) => _reevaluateCombatant(combatant, "createCombatant"));
  Hooks.on("deleteCombatant", (combatant) => _reevaluateCombatant(combatant, "deleteCombatant"));

  // ── Active Effect lifecycle ──────────────────────────────────────────────
  Hooks.on("createActiveEffect", (effect) => _reevaluateActorOfDoc(effect, "createActiveEffect"));
  Hooks.on("updateActiveEffect", (effect) => _reevaluateActorOfDoc(effect, "updateActiveEffect"));
  Hooks.on("deleteActiveEffect", (effect) => _reevaluateActorOfDoc(effect, "deleteActiveEffect"));

  // ── Special status effect application (canvas-level) ─────────────────────
  // Fires for IDs in CONFIG.specialStatusEffects only.
  Hooks.on("applyTokenStatusEffect", (token, /*statusId*/ _statusId, /*active*/ _active) => {
    if (token?.document) scheduleReevaluateToken(token.document, { source: "applyTokenStatusEffect" });
  });

  // ── Actor data updates ───────────────────────────────────────────────────
  Hooks.on("updateActor", (actor) => {
    scheduleReevaluate(actor, { source: "updateActor" });
  });

  // ── Token document updates (e.g. external mod changed our flag) ──────────
  Hooks.on("updateToken", (tokenDoc, changes, options) => {
    // Don't recurse on our own writes.
    if (options?.[`${MODULE_ID}.appliedState`]) return;
    // If anything we care about changed, re-evaluate.
    if (changes.actorId !== undefined || changes.actorLink !== undefined) {
      scheduleReevaluateToken(tokenDoc, { source: "updateToken" });
    }
  });

  // ── Token created (initial state for placed tokens) ──────────────────────
  Hooks.on("createToken", (tokenDoc) => {
    scheduleReevaluateToken(tokenDoc, { source: "createToken" });
  });

  // ── Custom hook bus — system shims fire these to inform the engine ───────
  Hooks.on(`${MODULE_ID}.systemEvent`, (actor /*, event, payload*/) => {
    if (actor) scheduleReevaluate(actor, { source: "systemEvent" });
  });

  console.log(`${MODULE_ID} | trigger bus installed`);
}

// ---------------------------------------------------------------------------
// Helpers

function _reevaluateCombatants(combat, source) {
  if (!combat?.combatants) return;
  for (const cbt of combat.combatants) {
    const actor = cbt.actor;
    if (actor) scheduleReevaluate(actor, { source });
  }
}

function _reevaluateCombatant(combatant, source) {
  const actor = combatant?.actor;
  if (actor) scheduleReevaluate(actor, { source });
}

function _reevaluateActorOfDoc(doc, source) {
  // doc.parent is Actor for direct AEs, Item for transferred AEs.
  let actor = null;
  if (doc?.parent instanceof Actor) actor = doc.parent;
  else if (doc?.parent?.parent instanceof Actor) actor = doc.parent.parent;
  if (actor) scheduleReevaluate(actor, { source });
}
