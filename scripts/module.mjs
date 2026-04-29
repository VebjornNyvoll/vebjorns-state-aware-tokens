// State-Aware Tokens — entry point.
//
// Lifecycle:
//   init        register settings, set up game.<API> namespace
//   ready       install trigger bus, fire systemReady so shims register
//                 (shim registration window) → apply preset pack → first eval
//
// Public exports:
//   MODULE_ID — re-exported for internal modules
//   game.vebjornsStateAwareTokens.api — for external consumers + shims

export const MODULE_ID = "vebjorns-state-aware-tokens";

import { installTriggerBus } from "./core/trigger-bus.mjs";
import {
  registerState,
  getRegisteredStates,
  getActiveState,
  isStateActive,
  scheduleReevaluate,
  scheduleReevaluateToken,
  forceState,
  clearOverrides,
  clearStates,
} from "./core/state-engine.mjs";
import { installCPRShim } from "../systems/cyberpunk-red-core.mjs";
import { CPRRecommendedPack } from "./packs/cpr-recommended.mjs";

// Side-effecting imports — these register Foundry hooks at module load time.
import "./apps/actor-config-app.mjs";
import "./apps/module-settings-app.mjs";

const SYSTEM_SHIMS = {
  "cyberpunk-red-core": installCPRShim,
};

const PRESET_PACKS = {
  "cpr-recommended": CPRRecommendedPack,
};

// ---------------------------------------------------------------------------
// init — settings registration + API namespace creation

Hooks.once("init", () => {
  // ── World settings ─────────────────────────────────────────────────────
  game.settings.register(MODULE_ID, "coexistenceMode", {
    name:    "VSAT.Settings.CoexistenceMode.Name",
    hint:    "VSAT.Settings.CoexistenceMode.Hint",
    scope:   "world",
    config:  true,
    type:    String,
    choices: {
      defer:    "VSAT.Settings.CoexistenceMode.Defer",
      clobber:  "VSAT.Settings.CoexistenceMode.Clobber",
      warn:     "VSAT.Settings.CoexistenceMode.Warn",
    },
    default: "defer",
  });

  game.settings.register(MODULE_ID, "defaultAnimationDuration", {
    name:    "VSAT.Settings.AnimationDuration.Name",
    hint:    "VSAT.Settings.AnimationDuration.Hint",
    scope:   "world",
    config:  true,
    type:    Number,
    range:   { min: 0, max: 2000, step: 50 },
    default: 0, // instant — matches decision #4
  });

  game.settings.register(MODULE_ID, "enabledForNonGMOwners", {
    name:    "VSAT.Settings.EnabledForNonGMOwners.Name",
    hint:    "VSAT.Settings.EnabledForNonGMOwners.Hint",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "appliedPack", {
    name:    "VSAT.Settings.AppliedPack.Name",
    hint:    "VSAT.Settings.AppliedPack.Hint",
    scope:   "world",
    config:  true,
    type:    String,
    choices: {
      "":                 "VSAT.Settings.AppliedPack.None",
      "cpr-recommended":  "VSAT.Settings.AppliedPack.CPRRecommended",
    },
    default: "",
    requiresReload: true,
  });

  game.settings.register(MODULE_ID, "debugLogging", {
    name:    "VSAT.Settings.DebugLogging.Name",
    hint:    "VSAT.Settings.DebugLogging.Hint",
    scope:   "client",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // ── Public API namespace ───────────────────────────────────────────────
  // Anchored at game.<longName> AND game.vsat for terse access.
  const api = Object.freeze({
    // Registration (called by shims and external consumers)
    addState: registerState,
    addSystemIntegration({ systemId, states /*, version */ }) {
      if (game.system.id !== systemId) {
        console.log(`${MODULE_ID} | system shim '${systemId}' ignored (active system: ${game.system.id})`);
        return false;
      }
      let count = 0;
      for (const state of states ?? []) {
        if (registerState(state)) count++;
      }
      console.log(`${MODULE_ID} | registered ${count} states for ${systemId}`);
      return true;
    },
    addStatePack(pack) {
      if (!pack?.id || !Array.isArray(pack.states)) {
        console.error(`${MODULE_ID} | addStatePack: invalid pack`, pack);
        return false;
      }
      let count = 0;
      for (const state of pack.states) {
        if (registerState(state)) count++;
      }
      console.log(`${MODULE_ID} | applied pack '${pack.id}' with ${count} states`);
      return true;
    },

    // Query
    getActiveState(tokenOrDoc) {
      const doc = tokenOrDoc?.document ?? tokenOrDoc;
      return getActiveState(doc);
    },
    getRegisteredStates,
    isStateActive(tokenOrDoc, stateId) {
      const doc = tokenOrDoc?.document ?? tokenOrDoc;
      return isStateActive(doc, stateId);
    },

    // Imperative
    reevaluate(tokenOrDoc) {
      const doc = tokenOrDoc?.document ?? tokenOrDoc;
      if (!doc) return;
      scheduleReevaluateToken(doc, { source: "api.reevaluate" });
    },
    reevaluateActor(actor) {
      scheduleReevaluate(actor, { source: "api.reevaluateActor" });
    },
    forceState,
    clearOverrides,

    // Constants
    HOOKS: Object.freeze({
      SYSTEM_READY:   `${MODULE_ID}.systemReady`,
      STATE_CHANGED:  `${MODULE_ID}.stateChanged`,
      BEFORE_APPLY:   `${MODULE_ID}.beforeApply`,
      AFTER_APPLY:    `${MODULE_ID}.afterApply`,
      SYSTEM_EVENT:   `${MODULE_ID}.systemEvent`,
    }),
    MODULE_ID,
  });

  game.vsat = api;
  game.vebjornsStateAwareTokens = api;
});

// ---------------------------------------------------------------------------
// ready — install trigger bus, fire systemReady, apply preset pack

Hooks.once("ready", async () => {
  // Hard dependency check.
  if (!game.modules.get("lib-wrapper")?.active) {
    if (game.user.isGM) {
      ui.notifications.error(game.i18n.localize("VSAT.Notification.LibWrapperMissing"));
    }
    return;
  }

  // Install trigger bus first so subsequent registrations see triggers.
  installTriggerBus();

  // Auto-install the matching system shim (if present).
  const systemInstaller = SYSTEM_SHIMS[game.system.id];
  if (systemInstaller) {
    try {
      await systemInstaller(game.vsat);
    } catch (err) {
      console.error(`${MODULE_ID} | system shim install failed for ${game.system.id}:`, err);
    }
  } else {
    console.log(`${MODULE_ID} | no first-party shim for system '${game.system.id}'`);
  }

  // Fire SYSTEM_READY so external system shims (companion modules) register.
  Hooks.callAll(`${MODULE_ID}.systemReady`, game.vsat);

  // Apply preset pack if one is selected and we're a GM (avoids duplicate registers).
  if (game.user.isGM) {
    const packId = game.settings.get(MODULE_ID, "appliedPack");
    if (packId && PRESET_PACKS[packId]) {
      // Pack states should ALREADY be registered by the system shim that owns them.
      // The pack mechanism is currently equivalent to "use the system shim's defaults".
      // The setting acts as an opt-in that the user explicitly selected this pack.
      // (Future v0.2: packs may include state overrides, priority adjustments, etc.)
      console.log(`${MODULE_ID} | applied pack: ${packId}`);
    }
  }

  // First-pass evaluation for every token in the loaded scene.
  if (canvas?.ready && canvas.scene) {
    for (const tokenDoc of canvas.scene.tokens) {
      scheduleReevaluateToken(tokenDoc, { source: "ready-pass" });
    }
  }

  // Coexistence warn-mode initial scan.
  if (game.user.isGM && game.settings.get(MODULE_ID, "coexistenceMode") === "warn") {
    const { scanForExternalManagement } = await import("./core/coexistence.mjs");
    const summary = scanForExternalManagement();
    for (const [module, count] of Object.entries(summary)) {
      if (count > 0) {
        ui.notifications.warn(
          game.i18n.format("VSAT.Notification.CoexistenceWarn", { module, count })
        );
      }
    }
  }

  console.log(`${MODULE_ID} | ready (system: ${game.system.id})`);
});

// ---------------------------------------------------------------------------
// canvasReady — re-run evaluation when scene swaps

Hooks.on("canvasReady", () => {
  if (!canvas.scene) return;
  for (const tokenDoc of canvas.scene.tokens) {
    scheduleReevaluateToken(tokenDoc, { source: "canvasReady" });
  }
});

// Re-export for sub-modules that need the engine API.
export {
  registerState,
  getRegisteredStates,
  getActiveState,
  isStateActive,
  scheduleReevaluate,
  scheduleReevaluateToken,
  forceState,
  clearOverrides,
  clearStates,
};
