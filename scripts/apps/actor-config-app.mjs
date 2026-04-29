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

// Inject a header button on Actor sheets so GMs can open this app.
//
// Why renderActorSheet + DOM injection rather than getHeaderControls / getHeaderButtons:
//   - getHeaderControls<ClassName> (v13 AppV2) and get<ClassName>HeaderButtons (v12) both
//     fire ONLY for the EXACT class. Systems that subclass ActorSheet (CPR, dnd5e, pf2e,
//     swade, ...) don't see hooks targeting the base class fire on their sheets.
//   - renderActorSheet fires for every render of any actor sheet regardless of subclass,
//     because Foundry walks the inheritance chain when emitting render hooks.
//   - This is exactly the approach Item Piles, Theatre Inserts, and PopOut! use.

Hooks.on("renderActorSheet", _injectHeaderButton);
// v13 also fires renderActorSheetV2 for V2-based sheets. Cover both.
Hooks.on("renderActorSheetV2", _injectHeaderButton);

function _injectHeaderButton(app, html, _data) {
  if (!game.user.isGM) return;

  // html may be a jQuery object (v12) or an HTMLElement (v13). Normalise.
  const root = (html instanceof HTMLElement) ? html
              : (html?.[0] instanceof HTMLElement ? html[0] : null);
  if (!root) return;

  // Find the window's header (the .window-header bar with the title and close button).
  // The actor sheet's HTML root is inside .window-content; the header is its sibling.
  const windowApp = root.closest(".window-app") ?? app.element?.[0] ?? app.element;
  if (!windowApp) return;
  const header = windowApp.querySelector?.(".window-header") ?? null;
  if (!header) return;

  // Avoid duplicate injection on re-render.
  if (header.querySelector(".vsat-open-config")) return;

  // Build the button. Style it to match the other header anchors.
  const a = document.createElement("a");
  a.className = "vsat-open-config header-button";
  a.title = game.i18n.localize("VSAT.ActorConfig.HeaderButton");
  a.innerHTML = `<i class="fa-solid fa-masks-theater"></i> <span>${
    game.i18n.localize("VSAT.ActorConfig.HeaderButton")
  }</span>`;
  a.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    new ActorConfigApp(app.document).render({ force: true });
  });

  // Insert before the close button so it sits inline with the other module buttons.
  const close = header.querySelector('[data-action="close"], a.close, .header-button.close');
  if (close) close.before(a);
  else header.appendChild(a);
}
