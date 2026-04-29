// Actor Config App — per-actor state→image mapping editor.
//
// Renders one row per registered state, with an image picker per row.
// Saves to actor.flags[MODULE_ID].images.

import { MODULE_ID, getRegisteredStates, scheduleReevaluate } from "../module.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ActorConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
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
      handler: ActorConfigApp.#onSubmit,
      closeOnSubmit: true,
      submitOnChange: false,
    },
    actions: {
      pickImage:  ActorConfigApp.#onPickImage,
      clearImage: ActorConfigApp.#onClearImage,
    },
  };

  static PARTS = {
    form: {
      template: `modules/${MODULE_ID}/templates/actor-config.hbs`,
      scrollable: [".vsat-state-list"],
    },
  };

  /** @param {Actor} actor */
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
  }

  /** @override */
  get title() {
    return game.i18n.format("VSAT.ActorConfig.Title", { actor: this.actor?.name ?? "" });
  }

  /** @override */
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

  // ── Action handlers (static) ───────────────────────────────────────────

  static async #onPickImage(event, target) {
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
        // Update preview thumbnail.
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

  static async #onClearImage(event, target) {
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

  // ── Form submit ────────────────────────────────────────────────────────

  static async #onSubmit(event, form, formData) {
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
}

// Defensive actor lookup — V1 ActorSheet uses app.actor/app.object,
// V2 uses app.document; v12+ provides app.document on V1 sheets too.
function _resolveActor(app) {
  return app?.document ?? app?.actor ?? app?.object ?? null;
}

// Inject a header button on V2 actor sheets (rare on V12; default on V13+).
Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
  if (!game.user.isGM) return;
  controls.unshift({
    label: game.i18n.localize("VSAT.ActorConfig.HeaderButton"),
    action: "vsatOpenConfig",
    icon: "fa-solid fa-masks-theater",
    onClick: () => {
      const actor = _resolveActor(app);
      if (actor) new ActorConfigApp(actor).render({ force: true });
    },
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
    onclick: () => {
      const actor = _resolveActor(app);
      if (actor) new ActorConfigApp(actor).render({ force: true });
    },
  });
});

console.log("vebjorns-state-aware-tokens | actor-config-app loaded; header-button hooks registered");

  // Insert before the close button so it sits inline with the other module buttons.
  const close = header.querySelector('[data-action="close"], a.close, .header-button.close');
  if (close) close.before(a);
  else header.appendChild(a);
}
