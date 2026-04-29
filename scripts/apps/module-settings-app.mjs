// Module Settings App — read-only summary of currently-registered states
// and system shims. Settings themselves are managed via Foundry's standard
// settings UI; this app shows what the engine currently knows about.

import { MODULE_ID, getRegisteredStates } from "../module.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ModuleSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
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

  /** @override */
  async _prepareContext(_options) {
    const states = getRegisteredStates();
    const currentPack = game.settings.get(MODULE_ID, "appliedPack");

    // Group states by systemTag for the shims-summary section.
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
}

// Hook the app into the module settings menu.
Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, "moduleSettings", {
    name:       "VSAT.Settings.Menu.Name",
    label:      "VSAT.Settings.Menu.Label",
    hint:       "VSAT.Settings.Menu.Hint",
    icon:       "fa-solid fa-gears",
    type:       ModuleSettingsApp,
    restricted: true,
  });
});
