// Actor Config App — per-actor state→image mapping editor.
//
// Renders one row per registered state, with an image picker per row.
// Saves to actor.flags[MODULE_ID].images.
//
// IMPORTANT: foundry.applications.api may not be populated when this module's
// top-level code runs in V12. We DEFER class definition until first use to
// avoid `TypeError: Cannot destructure property 'ApplicationV2' of
// 'foundry.applications.api' as it is undefined` at module-load time.

import { MODULE_ID, getRegisteredStates, scheduleReevaluate } from "../module.mjs";

let _ActorConfigApp = null;

/** Build the class on first use; cache it. Returns null if V12 ApplicationV2
 *  is unavailable (very old build or non-Foundry environment). */
function _getActorConfigApp() {
  if (_ActorConfigApp) return _ActorConfigApp;

  const api = foundry?.applications?.api;
  if (!api?.ApplicationV2 || !api?.HandlebarsApplicationMixin) {
    console.error(
      `${MODULE_ID} | foundry.applications.api.ApplicationV2 or HandlebarsApplicationMixin unavailable; ` +
      `cannot construct ActorConfigApp. Foundry version may be too old (need v12+).`
    );
    return null;
  }

  // ── Action handlers (plain functions; ApplicationV2 binds `this` to the instance) ──
  async function onPickImage(event, target) {
    const stateId = target.dataset.stateId;
    if (!stateId) return;
    const inputName = `images.${stateId}`;
    const input = this.element.querySelector(`input[name="${CSS.escape(inputName)}"]`);
    const current = input?.value ?? "";
    const fp = new FilePicker({
      type: "imagevideo",
      current,
      callback: (path) => {
        if (input) input.value = path;
        const preview = this.element.querySelector(
          `[data-state-id="${CSS.escape(stateId)}"] .vsat-image-preview`
        );
        if (preview) {
          if (path) {
            preview.style.backgroundImage = `url("${path}")`;
            preview.classList.remove("vsat-image-preview-empty");
          } else {
            preview.style.backgroundImage = "";
            preview.classList.add("vsat-image-preview-empty");
          }
        }
      },
    });
    await fp.browse();
  }

  async function onClearImage(event, target) {
    const stateId = target.dataset.stateId;
    if (!stateId) return;
    const input = this.element.querySelector(
      `input[name="${CSS.escape(`images.${stateId}`)}"]`
    );
    if (input) input.value = "";
    const preview = this.element.querySelector(
      `[data-state-id="${CSS.escape(stateId)}"] .vsat-image-preview`
    );
    if (preview) {
      preview.style.backgroundImage = "";
      preview.classList.add("vsat-image-preview-empty");
    }
  }

  async function onSubmit(event, form, formData) {
    const data = formData.object;
    const images = {};
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith("images.")) {
        const stateId = k.substring("images.".length);
        if (typeof v === "string" && v.length > 0) {
          images[stateId] = v;
        }
      }
    }
    const disabled = !!data.disabled;

    await this.actor.update({
      [`flags.${MODULE_ID}.images`]:    images,
      [`flags.${MODULE_ID}.disabled`]:  disabled,
    });

    scheduleReevaluate(this.actor, { source: "actor-config-saved" });

    ui.notifications?.info(`State-Aware Tokens: saved for ${this.actor.name}`);
  }

  // ── The actual class — built lazily ───────────────────────────────────
  _ActorConfigApp = class ActorConfigApp extends api.HandlebarsApplicationMixin(api.ApplicationV2) {
    static DEFAULT_OPTIONS = {
      id: "vsat-actor-config-{id}",
      classes: ["vsat", "vsat-actor-config"],
      tag: "form",
      window: {
        title: "VSAT.ActorConfig.Title",
        icon:  "fa-solid fa-masks-theater",
        resizable: true,
      },
      position: { width: 640, height: 560 },
      form: {
        handler: onSubmit,
        closeOnSubmit: true,
        submitOnChange: false,
      },
      actions: {
        pickImage:  onPickImage,
        clearImage: onClearImage,
      },
    };

    static PARTS = {
      form: {
        template: `modules/${MODULE_ID}/templates/actor-config.hbs`,
        scrollable: [".vsat-state-list"],
      },
    };

    constructor(actor, options = {}) {
      super(options);
      this.actor = actor;
    }

    get title() {
      return game.i18n.format("VSAT.ActorConfig.Title", { actor: this.actor?.name ?? "" });
    }

    async _prepareContext(_options) {
      const states = getRegisteredStates();
      const images = this.actor.getFlag(MODULE_ID, "images") ?? {};
      const disabled = !!this.actor.getFlag(MODULE_ID, "disabled");
      return {
        actor: this.actor,
        disabled,
        states: states.map(s => ({
          id: s.id,
          priority: s.priority,
          description: s.description ? game.i18n.localize(s.description) : "",
          image: images[s.id] ?? "",
          systemTag: s.systemTag ?? "",
        })),
        hasStates: states.length > 0,
        moduleId: MODULE_ID,
      };
    }
  };

  return _ActorConfigApp;
}

// Public export for any external consumer that wants the class.
export function getActorConfigAppClass() {
  return _getActorConfigApp();
}

// Defensive actor lookup — V1 ActorSheet uses app.actor/app.object,
// V2 uses app.document; v12+ provides app.document on V1 sheets too.
function _resolveActor(app) {
  return app?.document ?? app?.actor ?? app?.object ?? null;
}

/** Open the config app for an actor (lazily constructs the class). */
function _openConfig(actor) {
  if (!actor) return;
  const Cls = _getActorConfigApp();
  if (!Cls) {
    ui.notifications?.error("State-Aware Tokens: ApplicationV2 unavailable");
    return;
  }
  new Cls(actor).render({ force: true });
}

// Inject a header button on V2 actor sheets (rare on V12; default on V13+).
Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
  if (!game.user.isGM) return;
  controls.unshift({
    label: game.i18n.localize("VSAT.ActorConfig.HeaderButton"),
    action: "vsatOpenConfig",
    icon: "fa-solid fa-masks-theater",
    onClick: () => _openConfig(_resolveActor(app)),
  });
});

// Backwards-compat for v12-style V1 ActorSheet: getActorSheetHeaderButtons.
// CPR's CPRCharacterActorSheet extends ActorSheet (V1), so this is the path
// that fires on V12 + CPR.
Hooks.on("getActorSheetHeaderButtons", (app, buttons) => {
  if (!game.user.isGM) return;
  if (buttons.some(b => b.class === "vsat-open-config")) return;
  buttons.unshift({
    label: game.i18n.localize("VSAT.ActorConfig.HeaderButton"),
    class: "vsat-open-config",
    icon:  "fa-solid fa-masks-theater",
    onclick: () => _openConfig(_resolveActor(app)),
  });
});

console.log("vebjorns-state-aware-tokens | actor-config-app loaded; header-button hooks registered");

