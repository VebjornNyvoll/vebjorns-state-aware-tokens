// Module Settings App — read-only summary of currently-registered states
// and system shims. Settings themselves are managed via Foundry's standard
// settings UI; this app shows what the engine currently knows about.
//
// Class is constructed lazily inside the init hook to avoid destructuring
// `foundry.applications.api` at module-load time (V12 quirk where the
// namespace may be undefined when ESM modules are first parsed).

import { MODULE_ID, getRegisteredStates } from "../module.mjs";

let _ModuleSettingsApp = null;

function _buildModuleSettingsApp() {
  if (_ModuleSettingsApp) return _ModuleSettingsApp;

  const api = foundry?.applications?.api;
  if (!api?.ApplicationV2 || !api?.HandlebarsApplicationMixin) {
    console.error(
      `${MODULE_ID} | foundry.applications.api unavailable; ` +
      `cannot construct ModuleSettingsApp.`
    );
    return null;
  }

  _ModuleSettingsApp = class ModuleSettingsApp extends api.HandlebarsApplicationMixin(api.ApplicationV2) {
    static DEFAULT_OPTIONS = {
      id: "vsat-module-settings",
      classes: ["vsat", "vsat-module-settings"],
      tag: "div",
      window: {
        title: "VSAT.SettingsApp.Title",
        icon:  "fa-solid fa-gears",
        resizable: true,
      },
      position: { width: 720, height: 580 },
      actions: {},
    };

    static PARTS = {
      main: {
        template: `modules/${MODULE_ID}/templates/module-settings.hbs`,
        scrollable: [".vsat-settings-states-table", ".vsat-settings-shims-list"],
      },
    };

    async _prepareContext(_options) {
      const states = getRegisteredStates();
      const currentPack = game.settings.get(MODULE_ID, "appliedPack");

      const shims = new Map();
      for (const s of states) {
        const tag = s.systemTag ?? "(generic)";
        if (!shims.has(tag)) shims.set(tag, []);
        shims.get(tag).push(s);
      }

      return {
        states: states.map(s => ({
          id: s.id,
          priority: s.priority,
          systemTag: s.systemTag ?? "",
          description: s.description ? game.i18n.localize(s.description) : "",
          ephemeral: !!s.ephemeral,
        })),
        hasStates: states.length > 0,
        shims: [...shims.entries()].map(([tag, list]) => ({
          tag,
          count: list.length,
        })),
        hasShims: shims.size > 0,
        currentPack: currentPack
          ? game.i18n.localize(`VSAT.Settings.AppliedPack.${currentPack === "cpr-recommended" ? "CPRRecommended" : "None"}`)
          : game.i18n.localize("VSAT.Settings.AppliedPack.None"),
        systemId: game.system.id,
        moduleId: MODULE_ID,
      };
    }
  };

  return _ModuleSettingsApp;
}

export function getModuleSettingsAppClass() {
  return _buildModuleSettingsApp();
}

// Build the class at init (foundry.applications.api is reliably available
// by then) and register the settings menu.
Hooks.once("init", () => {
  const Cls = _buildModuleSettingsApp();
  if (!Cls) return;
  game.settings.registerMenu(MODULE_ID, "moduleSettings", {
    name:       "VSAT.Settings.Menu.Name",
    label:      "VSAT.Settings.Menu.Label",
    hint:       "VSAT.Settings.Menu.Hint",
    icon:       "fa-solid fa-gears",
    type:       Cls,
    restricted: true,
  });
});

console.log("vebjorns-state-aware-tokens | module-settings-app loaded");
