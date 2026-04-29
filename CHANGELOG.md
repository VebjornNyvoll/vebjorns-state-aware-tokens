# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-04-29

### Fixed

- **Header button now appears on system-specific actor sheets.** v0.1.0 used `getHeaderControlsActorSheetV2` + `getActorSheetHeaderButtons` hooks, both of which only fire for the EXACT base sheet class. CPR (and most game systems) subclass `ActorSheet` (e.g. `CPRCharacterActorSheet`), so neither hook fired and the button was invisible. v0.1.1 switches to the `renderActorSheet` / `renderActorSheetV2` hooks (which fire for all actor sheets regardless of subclass) and injects the button via DOM manipulation — same pattern Theatre Inserts, PopOut!, and Item Piles use.

## [0.1.0] - 2026-04-29

### Added

- **Core state engine** — registry, priority-ordered first-match resolution, snapshot/restore, debounced re-evaluation.
- **Trigger bus** — listens to Foundry-native hooks (combat lifecycle, AE lifecycle, actor updates, token lifecycle, applyTokenStatusEffect) and routes signals to the engine.
- **Coexistence detection** — defers to Token Variants Art, Visage, and Active Token Lighting when their flags are present.
- **Public API** — `game.vsat` (alias `game.vebjornsStateAwareTokens`) with `addState`, `addSystemIntegration`, `addStatePack`, `getActiveState`, `isStateActive`, `reevaluate`, `forceState`, `clearOverrides`, plus a `HOOKS` constants object.
- **Per-actor configuration UI** — ApplicationV2 dialog accessible via the actor sheet header. Image picker per registered state. Toggle to disable swap-driven changes for a specific actor.
- **Module settings UI** — read-only summary of registered states and active system shims.
- **Cyberpunk Red Core shim** — registers 11 states for CPR (`unconscious`/`bloodied`/`wounded`/`dead`/`inCombat` + `cpr.dead`/`cpr.rolling.*` ephemeral states). Uses libWrapper to wrap `CPRRoll.prototype.roll` (CPR fires zero custom hooks; this is the only way to detect roll types).
- **Recommended CPR Combat Pack** — auto-applied for Cyberpunk Red Core campaigns.
- **MIT license, GitHub Actions release pipeline** with token-stamped manifest and Node 24.

### Known limitations (deferred to v0.1.1+)

- No light-field UI yet (engine supports light mutations; UI only exposes the image picker for v0.1).
- No custom-state UI (Compound / HP threshold / Status effect) yet — only states registered by shims are available.
- No per-token override UI (snapshot/restore preserves per-token original art automatically; only "I want a different swap target for this specific token" needs the UI).
- Alpha / scale / tint mutations not yet exposed in UI (engine handles them generically).
- Only English localisation.

### Compatibility

- Foundry VTT v12 (minimum), v13 (verified).
- Required: libWrapper.
- Recommended: socketlib (used by future v0.2+ for player-relayed updates).
- First-party shim: cyberpunk-red-core v0.92.x.
