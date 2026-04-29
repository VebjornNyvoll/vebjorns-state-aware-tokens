// State Engine — central registry, resolution, and application logic.
//
// Responsibilities:
// - Register state definitions (StateDef objects).
// - Re-evaluate which state wins for a given actor's tokens when triggered.
// - Apply the winning state's mutations to the token document.
// - Snapshot original token values before first swap; restore on clear.
// - Coexistence-check before mutating: if another module owns the image, defer.
//
// The engine is system-agnostic. All system-specific knowledge lives in shims
// that register states via the public API.

import { MODULE_ID } from "../module.mjs";
import { takeSnapshot, restoreSnapshot, hasSnapshot } from "./snapshot.mjs";
import { isTokenManagedExternally } from "./coexistence.mjs";

/** @typedef {Object} StateDef
 *  @property {string}  id          Unique state identifier
 *  @property {number}  priority    0..1000 — higher wins first-match resolution
 *  @property {(actor: Actor, ctx?: object) => boolean} predicate  Pure function
 *  @property {Array<{hook: string, filter?: Function}>} [triggers]  Hooks that signal re-eval
 *  @property {Object<string, any>} [apply]       Field overrides; null means "use user-config image"
 *  @property {"skip"|"image-only"|"non-image-only"} [fallback]
 *  @property {boolean} [ephemeral]               Auto-clears after durationMs
 *  @property {number}  [durationMs]              Required when ephemeral
 *  @property {string}  [systemTag]               Filtering / coexistence policies
 *  @property {string}  [description]             Localisation key or free text
 */

/** Registry of all known states, keyed by state.id. */
const _states = new Map();

/** Per-token last-applied state id (for debouncing / no-op detection).
 *  Lives in memory; also mirrored to tokenDoc.flags as activeState for persistence. */
const _lastApplied = new Map(); // tokenId -> stateId|null

/** Per-actor pending ephemeral state expiry timers (so we can clear them on early reeval). */
const _ephemeralTimers = new Map(); // tokenId -> { stateId, timer }

/** Set of tokenIds in pending re-evaluation (debouncing). */
const _pendingEval = new Set();
let _evalScheduled = false;

/** Debug log helper. */
function _dbg(...args) {
  if (game.settings.get(MODULE_ID, "debugLogging")) {
    console.log(`${MODULE_ID} |`, ...args);
  }
}

// ---------------------------------------------------------------------------
// Registration

/** Register a state definition. Idempotent on id (later registrations win). */
export function registerState(stateDef) {
  if (!stateDef?.id || typeof stateDef.predicate !== "function") {
    console.error(`${MODULE_ID} | registerState: invalid stateDef`, stateDef);
    return false;
  }
  if (typeof stateDef.priority !== "number") stateDef.priority = 100;
  _states.set(stateDef.id, stateDef);
  _dbg(`registered state: ${stateDef.id} (priority ${stateDef.priority})`);
  return true;
}

/** Unregister a state by id. */
export function unregisterState(stateId) {
  const removed = _states.delete(stateId);
  if (removed) _dbg(`unregistered state: ${stateId}`);
  return removed;
}

/** Get all registered states (read-only snapshot, sorted by priority desc). */
export function getRegisteredStates() {
  return [...Array.from(_states.values())].sort((a, b) => b.priority - a.priority);
}

/** Get a single state by id, or undefined. */
export function getState(stateId) {
  return _states.get(stateId);
}

/** Clear all registered states. (Used by tests and pack-reset.) */
export function clearStates() {
  _states.clear();
  _lastApplied.clear();
  for (const { timer } of _ephemeralTimers.values()) clearTimeout(timer);
  _ephemeralTimers.clear();
}

// ---------------------------------------------------------------------------
// Evaluation — finds the winning state for a given actor

/** Find the highest-priority state whose predicate returns true.
 *  Returns the StateDef or null. */
export function evaluate(actor, ctx = {}) {
  const sorted = getRegisteredStates();
  for (const state of sorted) {
    try {
      if (state.predicate(actor, ctx)) return state;
    } catch (err) {
      console.error(`${MODULE_ID} | predicate error in state '${state.id}':`, err);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Application — mutate the token document to reflect the winning state

/** Schedule re-evaluation for all tokens of an actor.
 *  Debounces multiple rapid triggers via microtask. */
export function scheduleReevaluate(actor, ctx = {}) {
  if (!actor) return;
  const tokens = actor.getActiveTokens(true, true); // (linked, includeUnlinked)
  if (!tokens?.length) return;
  for (const token of tokens) {
    _pendingEval.add(token.id);
  }
  if (!_evalScheduled) {
    _evalScheduled = true;
    queueMicrotask(() => _flushPending(ctx));
  }
}

/** Schedule a single token re-eval (for token-document hooks). */
export function scheduleReevaluateToken(tokenDoc, ctx = {}) {
  if (!tokenDoc?.actor) return;
  _pendingEval.add(tokenDoc.id);
  if (!_evalScheduled) {
    _evalScheduled = true;
    queueMicrotask(() => _flushPending(ctx));
  }
}

/** Process all pending tokens. */
async function _flushPending(ctx) {
  _evalScheduled = false;
  const ids = [..._pendingEval];
  _pendingEval.clear();

  for (const tokenId of ids) {
    const tokenDoc = _findTokenById(tokenId);
    if (!tokenDoc) continue;
    try {
      await _applyForToken(tokenDoc, ctx);
    } catch (err) {
      console.error(`${MODULE_ID} | apply failed for token ${tokenId}:`, err);
    }
  }
}

/** Locate a TokenDocument anywhere across loaded scenes. */
function _findTokenById(tokenId) {
  for (const scene of game.scenes) {
    const t = scene.tokens.get(tokenId);
    if (t) return t;
  }
  return null;
}

/** Should the current user be the one to apply mutations?
 *  Default: GM only. World setting can opt-in players for tokens they own. */
function _shouldRunOnThisClient(tokenDoc) {
  if (game.user.isGM) return true;
  if (!game.settings.get(MODULE_ID, "enabledForNonGMOwners")) return false;
  return tokenDoc.isOwner;
}

/** Apply the winning state's mutations to a single token. */
async function _applyForToken(tokenDoc, ctx) {
  const actor = tokenDoc.actor;
  if (!actor) return;

  // Per-actor disable bypass.
  const actorDisabled = actor.getFlag(MODULE_ID, "disabled");
  if (actorDisabled) return;

  // Permission gate.
  if (!_shouldRunOnThisClient(tokenDoc)) return;

  // Determine winner.
  const winner = evaluate(actor, ctx);
  const winnerId = winner?.id ?? null;
  const lastId = _lastApplied.get(tokenDoc.id) ?? tokenDoc.getFlag(MODULE_ID, "activeState") ?? null;

  if (winnerId === lastId) {
    _dbg(`${tokenDoc.name}: no change (still ${winnerId ?? "none"})`);
    return;
  }

  _dbg(`${tokenDoc.name}: ${lastId ?? "none"} -> ${winnerId ?? "none"}`);

  // Cancel any pending ephemeral timer for this token (state changed).
  const existing = _ephemeralTimers.get(tokenDoc.id);
  if (existing) {
    clearTimeout(existing.timer);
    _ephemeralTimers.delete(tokenDoc.id);
  }

  if (winner) {
    await _applyState(tokenDoc, winner);
    _lastApplied.set(tokenDoc.id, winnerId);
    if (winner.ephemeral && winner.durationMs > 0) {
      const timer = setTimeout(() => {
        _ephemeralTimers.delete(tokenDoc.id);
        scheduleReevaluateToken(tokenDoc, { ephemeralExpired: winnerId });
      }, winner.durationMs);
      _ephemeralTimers.set(tokenDoc.id, { stateId: winnerId, timer });
    }
  } else {
    // No state matches — restore snapshot.
    await _clearState(tokenDoc);
    _lastApplied.set(tokenDoc.id, null);
  }

  // Fire hook for downstream consumers.
  Hooks.callAll(`${MODULE_ID}.stateChanged`, tokenDoc, lastId, winnerId);
}

/** Build the update payload for a state's `apply` directives, then update. */
async function _applyState(tokenDoc, state) {
  // BEFORE_APPLY hook — cancellable.
  const allowed = Hooks.call(`${MODULE_ID}.beforeApply`, tokenDoc, state, /* changes */ {});
  if (allowed === false) {
    _dbg(`apply cancelled by hook for ${state.id}`);
    return;
  }

  // Snapshot first time we touch a token.
  if (!hasSnapshot(tokenDoc)) {
    await takeSnapshot(tokenDoc);
  }

  // Resolve image config: actor flags > per-token override (v0.2) > state.apply.texture.src.
  const actorImages = tokenDoc.actor.getFlag(MODULE_ID, "images") ?? {};
  const tokenImages = tokenDoc.getFlag(MODULE_ID, "imagesOverride") ?? {};
  const userImage = tokenImages[state.id] ?? actorImages[state.id] ?? null;

  // Build the change payload from state.apply directives.
  const changes = {};
  const apply = state.apply ?? {};

  for (const [field, value] of Object.entries(apply)) {
    if (field === "texture.src") {
      // null means "use user-configured image"; explicit string overrides.
      let src = value;
      if (src === null) src = userImage;
      if (src) {
        // Resolve wildcard if glob-pattern.
        if (src.includes("*") || src.includes("?")) {
          src = await _resolveWildcard(src);
        }
        if (src) changes["texture.src"] = src;
      } else if (state.fallback === "skip") {
        // No image configured AND skip-fallback; this state can't apply.
        // Try the next-priority state by re-running evaluate without this one.
        // For v0.1 simplicity we just don't apply image; future v0.2 may walk down.
      }
    } else {
      changes[field] = value;
    }
  }

  // If user has an image configured but the state didn't include texture.src in apply,
  // still swap the image (treat user config as authoritative for the visual).
  if (!("texture.src" in changes) && userImage) {
    let src = userImage;
    if (src.includes("*") || src.includes("?")) src = await _resolveWildcard(src);
    if (src) changes["texture.src"] = src;
  }

  if (!Object.keys(changes).length) {
    _dbg(`${state.id}: no changes to apply`);
    return;
  }

  // Coexistence check — if another module owns the image, drop image fields.
  if ("texture.src" in changes) {
    const externalOwner = isTokenManagedExternally(tokenDoc);
    const mode = game.settings.get(MODULE_ID, "coexistenceMode");
    if (externalOwner && mode === "defer") {
      _dbg(`coexistence: deferring image to ${externalOwner}`);
      delete changes["texture.src"];
    } else if (externalOwner && mode === "warn") {
      ui.notifications?.warn(
        game.i18n.format("VSAT.Notification.CoexistenceWarn", {
          module: externalOwner,
          count: 1,
        })
      );
      delete changes["texture.src"];
    }
    // If mode === "clobber", proceed.
  }

  if (!Object.keys(changes).length) return;

  // Build animation options.
  const duration = game.settings.get(MODULE_ID, "defaultAnimationDuration");
  const updateOptions = {
    animate: duration > 0,
    animation: duration > 0 ? { duration } : undefined,
    [`${MODULE_ID}.appliedState`]: state.id, // tag for our own deduping
  };

  await tokenDoc.update(changes, updateOptions);
  await tokenDoc.setFlag(MODULE_ID, "activeState", state.id);

  Hooks.callAll(`${MODULE_ID}.afterApply`, tokenDoc, state, changes);
}

/** Restore the token to its pre-state values. */
async function _clearState(tokenDoc) {
  const allowed = Hooks.call(`${MODULE_ID}.beforeApply`, tokenDoc, null, {});
  if (allowed === false) return;
  await restoreSnapshot(tokenDoc);
  await tokenDoc.unsetFlag(MODULE_ID, "activeState");
  Hooks.callAll(`${MODULE_ID}.afterApply`, tokenDoc, null, {});
}

/** Resolve a glob pattern to a single random matching file. */
async function _resolveWildcard(pattern) {
  try {
    const lastSlash = pattern.lastIndexOf("/");
    const dir = lastSlash >= 0 ? pattern.substring(0, lastSlash) : "";
    const lastDot = pattern.lastIndexOf(".");
    const ext = lastDot > lastSlash ? pattern.substring(lastDot) : "";
    const result = await FilePicker.browse("data", dir, {
      wildcard: true,
      extensions: ext ? [ext] : undefined,
    });
    if (!result.files?.length) return null;
    return result.files[Math.floor(Math.random() * result.files.length)];
  } catch (err) {
    console.warn(`${MODULE_ID} | wildcard resolution failed for ${pattern}:`, err);
    return pattern; // fall back to literal
  }
}

// ---------------------------------------------------------------------------
// Imperative API (used by debug commands and the public api object)

/** Force a specific state on a token (debug only). */
export async function forceState(tokenDoc, stateId) {
  if (!game.user.isGM) return;
  const state = _states.get(stateId);
  if (!state) {
    console.warn(`${MODULE_ID} | forceState: unknown state ${stateId}`);
    return;
  }
  await _applyState(tokenDoc, state);
  _lastApplied.set(tokenDoc.id, stateId);
}

/** Clear all module-managed state on a token. */
export async function clearOverrides(tokenDoc) {
  if (!game.user.isGM) return;
  await _clearState(tokenDoc);
  _lastApplied.delete(tokenDoc.id);
}

/** Get the currently active state ID for a token. */
export function getActiveState(tokenDoc) {
  return _lastApplied.get(tokenDoc.id)
      ?? tokenDoc.getFlag(MODULE_ID, "activeState")
      ?? null;
}

/** Test if a specific state is currently active on a token. */
export function isStateActive(tokenDoc, stateId) {
  return getActiveState(tokenDoc) === stateId;
}
