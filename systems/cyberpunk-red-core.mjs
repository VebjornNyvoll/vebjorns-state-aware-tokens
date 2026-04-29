// Cyberpunk Red Core (cpr) — system shim.
//
// Two categories of states:
//
//   1. Persistent states from actor data (wound stages, in-combat).
//      Detected via Foundry-native hooks (updateActor, createCombatant,
//      deleteCombat). CPR fires zero custom hooks of its own.
//
//   2. Ephemeral roll states — bucketed by roll kind:
//        cpr.rolling.deathSave    death-save roll
//        cpr.rolling.attack       any attack roll (handgun/shoulder/melee/etc.
//                                  intentionally one bucket per user request)
//        cpr.rolling.initiative   initiative roll
//        cpr.rolling.damage       damage roll
//        cpr.rolling.stat         stat check (REF/BODY/etc.)
//        cpr.rolling.role         role/interface roll
//        cpr.rolling.skill        any skill (catch-all, low priority)
//        cpr.rolling.skill.<slug> per-skill (animal_handling, etc.)
//
// Detection mechanism:
//
// CPRRoll classes do NOT extend Foundry's Roll, do NOT register with
// CONFIG.Dice.rolls, and CPRChat.RenderRollCard never sets `rolls` on the
// chat message it creates (they explicitly suppress it for Dice So Nice
// integration). So `message.rolls` is always [] for CPR rollcards and we
// can't detect the type from there.
//
// Instead we monkey-patch CPRChat.RenderRollCard on the rolling client to
// inspect the cprRoll object's class name and properties (skillName, etc.),
// stash a typed detection, then in preCreateChatMessage we stamp a flag
// onto the chat message right before save. The flag travels with the
// message to all clients (via socket), and createChatMessage on every
// client reads the flag and marks the appropriate ephemeral state.

import { MODULE_ID } from "../scripts/module.mjs";
import { scheduleReevaluate, registerState } from "../scripts/core/state-engine.mjs";

const SYSTEM_ID = "cyberpunk-red-core";
const FLAG_KEY  = "cprRoll"; // flags.<MODULE_ID>.cprRoll

// ---------------------------------------------------------------------------
// Ephemeral roll state — set briefly when an actor performs a roll.

const ROLL_DURATION_MS = 2500;

/** actorId -> { stateIds: Set<string>, timer: number } */
const _activeRolls = new Map();

function _markRollActive(actor, stateIds) {
  if (!actor || !stateIds?.length) return;

  const prior = _activeRolls.get(actor.id);
  if (prior?.timer) clearTimeout(prior.timer);

  const set = new Set(stateIds);
  const timer = setTimeout(() => {
    _activeRolls.delete(actor.id);
    scheduleReevaluate(actor, { source: "cpr-roll-clear" });
  }, ROLL_DURATION_MS);

  _activeRolls.set(actor.id, { stateIds: set, timer });
  scheduleReevaluate(actor, { source: "cpr-roll" });
}

function _isRollStateActive(actor, stateId) {
  return _activeRolls.get(actor?.id)?.stateIds.has(stateId) === true;
}

// ---------------------------------------------------------------------------
// Detection from a CPRRoll instance (only available on the rolling client)

/** Inspect a CPRRoll subclass instance and return a serialisable detection
 *  payload, or null. */
function _detectFromCPRRoll(cprRoll) {
  if (!cprRoll) return null;
  const className = cprRoll.constructor?.name ?? "";

  // entityData is set by CPR on most rolls; pull actor/token ids while we have them.
  const actorId = cprRoll.entityData?.actor ?? null;
  const tokenId = cprRoll.entityData?.token ?? null;

  // Order matters: more-specific subclasses come BEFORE bases they extend
  // (CPRAttackRoll < CPRSkillRoll < CPRStatRoll < CPRRoll).
  if (className === "CPRDeathSaveRoll")
    return { kind: "deathSave", actorId, tokenId };

  if (className === "CPRInitiative")
    return { kind: "initiative", actorId, tokenId };

  if (className === "CPRDamageRoll")
    return { kind: "damage", actorId, tokenId };

  if (
    className === "CPRAttackRoll" ||
    className === "CPRAimedAttackRoll" ||
    className === "CPRAutofireRoll" ||
    className === "CPRSuppressiveFireRoll"
  ) {
    return { kind: "attack", actorId, tokenId };
  }

  if (className === "CPRSkillRoll" || className === "CPRFacedownRoll") {
    const name = typeof cprRoll.skillName === "string" ? cprRoll.skillName : null;
    return { kind: "skill", name, actorId, tokenId };
  }

  if (className === "CPRStatRoll" || className === "CPRProgramStatRoll") {
    return { kind: "stat", actorId, tokenId };
  }

  if (className === "CPRRoleRoll" || className === "CPRInterfaceRoll") {
    return { kind: "role", actorId, tokenId };
  }

  if (className === "CPRHumanityLossRoll") {
    return { kind: "humanity", actorId, tokenId };
  }

  // Fallback: generic CPRRoll (e.g. from /red chat command).
  return { kind: "generic", actorId, tokenId };
}

function _slugifySkillName(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "unknown";
}

/** Map a detection to the list of state IDs that should be marked active. */
function _stateIdsForDetect(detect) {
  if (!detect) return [];
  switch (detect.kind) {
    case "attack":     return ["cpr.rolling.attack"];
    case "deathSave":  return ["cpr.rolling.deathSave"];
    case "initiative": return ["cpr.rolling.initiative"];
    case "damage":     return ["cpr.rolling.damage"];
    case "stat":       return ["cpr.rolling.stat"];
    case "role":       return ["cpr.rolling.role"];
    case "humanity":   return [];
    case "generic":    return [];
    case "skill": {
      const ids = ["cpr.rolling.skill"];
      if (detect.name) {
        const slug = _slugifySkillName(detect.name);
        const id = `cpr.rolling.skill.${slug}`;
        _ensureSkillState(slug, detect.name);
        ids.push(id);
      }
      return ids;
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Per-skill state registration

const _registeredSkills = new Set(); // slug

function _ensureSkillState(slug, displayName) {
  if (_registeredSkills.has(slug)) return;
  _registeredSkills.add(slug);
  const stateId = `cpr.rolling.skill.${slug}`;
  registerState({
    id:          stateId,
    priority:    360,
    ephemeral:   true,
    durationMs:  ROLL_DURATION_MS,
    predicate:   (actor) => _isRollStateActive(actor, stateId),
    triggers:    [],
    description: displayName ? `CPR: rolling ${displayName}.` : `CPR: rolling skill (${slug}).`,
    systemTag:   "cpr",
  });
}

function _enumerateSkillNames() {
  const names = new Set();
  for (const item of game.items ?? []) {
    if (item.type === "skill" && typeof item.name === "string") names.add(item.name);
  }
  for (const actor of game.actors ?? []) {
    for (const item of actor.items ?? []) {
      if (item.type === "skill" && typeof item.name === "string") names.add(item.name);
    }
  }
  return [...names].sort();
}

function _registerEnumeratedSkillStates() {
  const names = _enumerateSkillNames();
  for (const name of names) {
    _ensureSkillState(_slugifySkillName(name), name);
  }
  console.log(`${MODULE_ID} | pre-registered ${names.length} CPR skill rolling states`);
}

// ---------------------------------------------------------------------------
// Pending-detection FIFO — handed off from CPRChat.RenderRollCard wrap to
// preCreateChatMessage so we can stamp a flag before save.

const _pendingDetections = [];
const _PENDING_TTL_MS    = 5000;

function _pushPendingDetection(detect) {
  if (!detect) return;
  _pendingDetections.push(detect);
  setTimeout(() => {
    const idx = _pendingDetections.indexOf(detect);
    if (idx >= 0) _pendingDetections.splice(idx, 1);
  }, _PENDING_TTL_MS);
}

// ---------------------------------------------------------------------------
// Resolve an actor from a chat message's flag payload (works for both linked
// and unlinked tokens). Falls back to speaker.

function _resolveActorFromDetect(detect, message) {
  if (detect?.tokenId) {
    // Synthetic actor for unlinked tokens lives in game.actors.tokens.
    const synth = game.actors?.tokens?.[detect.tokenId];
    if (synth) return synth;
    // Or find the TokenDocument on any scene and return its actor.
    for (const scene of game.scenes ?? []) {
      const tokenDoc = scene.tokens?.get(detect.tokenId);
      if (tokenDoc?.actor) return tokenDoc.actor;
    }
  }
  if (detect?.actorId) {
    const a = game.actors?.get(detect.actorId);
    if (a) return a;
  }
  // Fallback to the chat message's speaker.
  const speaker = message?.speaker;
  if (speaker?.scene && speaker?.token) {
    const scene = game.scenes?.get(speaker.scene);
    const tokenDoc = scene?.tokens?.get(speaker.token);
    if (tokenDoc?.actor) return tokenDoc.actor;
  }
  if (speaker?.actor) {
    return game.actors?.get(speaker.actor) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Install the RenderRollCard wrap (rolling client only) and the chat-message
// hooks (every client).

async function _installRollDetection() {
  // ── Wrap CPRChat.RenderRollCard via dynamic import ──────────────────
  // This only affects the client that initiates the roll. We use the
  // wrap to extract typed roll info before the chat message exists.
  let CPRChat = null;
  try {
    const mod = await import("/systems/cyberpunk-red-core/src/modules/chat/cpr-chat.js");
    CPRChat = mod?.default;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not import cpr-chat.js for typed roll detection:`, err);
  }

  if (CPRChat && typeof CPRChat.RenderRollCard === "function") {
    const original = CPRChat.RenderRollCard;
    CPRChat.RenderRollCard = function (cprRoll) {
      try {
        const detect = _detectFromCPRRoll(cprRoll);
        if (detect) _pushPendingDetection(detect);
      } catch (err) {
        console.warn(`${MODULE_ID} | RenderRollCard wrap failed`, err);
      }
      return original.call(this, cprRoll);
    };
    console.log(`${MODULE_ID} | wrapped CPRChat.RenderRollCard`);
  } else {
    console.warn(`${MODULE_ID} | CPRChat.RenderRollCard unavailable; typed roll detection disabled`);
  }

  // ── Stamp the flag in preCreateChatMessage on the rolling client ────
  Hooks.on("preCreateChatMessage", (message, data, _options, _userId) => {
    if (game.system.id !== SYSTEM_ID) return;
    if (!_pendingDetections.length) return;

    // Only stamp on rollcard messages — guard against stamping unrelated chats.
    const content = data?.content ?? "";
    if (!content.includes("rollcard")) return;

    const detect = _pendingDetections.shift();
    try {
      message.updateSource({
        flags: { [MODULE_ID]: { [FLAG_KEY]: detect } },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | failed to stamp cprRoll flag:`, err);
    }
  });

  // ── On every client, read the flag and mark the rolling state active ──
  Hooks.on("createChatMessage", (message) => {
    if (game.system.id !== SYSTEM_ID) return;

    const detect = message.getFlag?.(MODULE_ID, FLAG_KEY)
      ?? message.flags?.[MODULE_ID]?.[FLAG_KEY];
    if (!detect) return;

    const actor = _resolveActorFromDetect(detect, message);
    if (!actor) return;

    const ids = _stateIdsForDetect(detect);
    if (!ids.length) return;

    _markRollActive(actor, ids);
  });

  console.log(`${MODULE_ID} | CPR roll detection installed (RenderRollCard wrap + flag relay)`);
}

// ---------------------------------------------------------------------------
// Predicates — persistent states

/** True if the actor (or its token, for unlinked) participates in any combat.
 *
 *  Subtlety: for UNLINKED tokens, `tokenDoc.actor` is a synthetic delta-actor
 *  whose `.id` is NOT the world-actor's id. The combatant stores `actorId =
 *  baseActor.id` and `tokenId = tokenDoc.id`. So we must also match by
 *  `tokenId` when our actor is synthetic — it exposes `actor.token` referring
 *  back to the TokenDocument. */
function _isInCombat(actor) {
  if (!actor) return false;
  const actorTokenId = actor.token?.id ?? null;
  return game.combats.some(c =>
    c.combatants?.some(cbt => {
      if (!cbt) return false;
      // Linked: combatant.actorId === world-actor.id === tokenDoc.actor.id
      if (cbt.actorId === actor.id) return true;
      // Unlinked: synthetic actor.id ≠ combatant.actorId, but the token id matches.
      if (actorTokenId && cbt.tokenId === actorTokenId) return true;
      // Reference equality fallback (covers any synthetic-resolution path).
      if (cbt.actor === actor) return true;
      return false;
    })
  );
}

function _woundStateIs(actor, value) {
  return actor?.system?.derivedStats?.currentWoundState === value;
}

// ---------------------------------------------------------------------------
// State definitions (base set; per-skill states added at install time)

function _baseRollingState(id, priority, descriptionKey) {
  return {
    id,
    priority,
    ephemeral:   true,
    durationMs:  ROLL_DURATION_MS,
    predicate:   (actor) => _isRollStateActive(actor, id),
    triggers:    [],
    description: descriptionKey,
    systemTag:   "cpr",
  };
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

  // ── Ephemeral rolling states (typed) ──────────────────────────────────
  // Death save sits highest because it's a uniquely dramatic moment.
  _baseRollingState("cpr.rolling.deathSave",  365, "VSAT.State.cpr.rolling.deathSave.Description"),
  _baseRollingState("cpr.rolling.attack",     355, "VSAT.State.cpr.rolling.attack.Description"),
  _baseRollingState("cpr.rolling.initiative", 350, "VSAT.State.cpr.rolling.initiative.Description"),
  _baseRollingState("cpr.rolling.damage",     345, "VSAT.State.cpr.rolling.damage.Description"),
  _baseRollingState("cpr.rolling.stat",       342, "VSAT.State.cpr.rolling.stat.Description"),
  _baseRollingState("cpr.rolling.role",       341, "VSAT.State.cpr.rolling.role.Description"),
  _baseRollingState("cpr.rolling.skill",      340, "VSAT.State.cpr.rolling.skill.Description"),

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

  await _installRollDetection();

  api.addSystemIntegration({
    systemId: SYSTEM_ID,
    states:   STATES,
  });

  // Per-skill states registered after the base set so they group together
  // in the actor-config UI.
  _registerEnumeratedSkillStates();

  console.log(`${MODULE_ID} | CPR shim installed (${STATES.length} base states + ${_registeredSkills.size} skills)`);
  return true;
}
