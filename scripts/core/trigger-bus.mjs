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
  // Any combat-related event triggers a sweep of every token on the active
  // scene. This is more aggressive than strictly needed but it's reliable:
  // when a Combat is deleted, `combat.combatants` may already be empty by
  // the time the hook fires, so iterating it would miss every token.
  // Sweeping the active scene's tokens guarantees the engine re-evaluates
  // their predicates and clears the inCombat state when appropriate.
  Hooks.on("combatStart",     (combat) => _reevaluateAllInActiveScene("combatStart"));
  Hooks.on("deleteCombat",    (combat) => _reevaluateAllInActiveScene("deleteCombat"));
  Hooks.on("updateCombat",    (combat, changes) => {
    // Re-eval on turn/round/active changes. `active` is the End-Combat signal
    // in some workflows; turn/round cover normal flow.
    if (
      changes.turn   !== undefined ||
      changes.round  !== undefined ||
      changes.active !== undefined
    ) {
      _reevaluateAllInActiveScene("updateCombat");
    }
  });
  Hooks.on("createCombatant", (combatant) => {
    _reevaluateCombatant(combatant, "createCombatant");
    _reevaluateAllInActiveScene("createCombatant");
  });
  Hooks.on("deleteCombatant", (combatant) => {
    _reevaluateCombatant(combatant, "deleteCombatant");
    _reevaluateAllInActiveScene("deleteCombatant");
  });

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

/** Schedule re-evaluation for every token in the active scene that has an
 *  actor. Used by combat events because at delete-time the affected actors
 *  aren't always reachable through the combat document anymore. Cheap
 *  enough for combat events (which are infrequent). */
function _reevaluateAllInActiveScene(source) {
  if (!canvas?.scene) return;
  for (const tokenDoc of canvas.scene.tokens) {
    if (tokenDoc.actor) {
      scheduleReevaluateToken(tokenDoc, { source });
    }
  }
}
