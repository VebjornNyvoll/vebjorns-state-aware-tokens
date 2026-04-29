# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-29

### Added

- **Core state engine** — priority-ordered first-match resolution; per-actor evaluation triggered by Foundry-native hooks (combat, ActiveEffect, updateActor) plus system-shim-fired custom hooks.
- **Snapshot/restore** — captures the original token values before the first state-driven mutation; restores them when no state matches anymore.
- **Coexistence detection** — checks for `flags.token-variants.defaultImg`, `flags.visage.activeStack`, `flags.ATL.originals` before clobbering `texture.src`. Three modes: `defer` (default), `clobber`, `warn`.
- **CPR system shim** — registers 11 states (dead, unconscious, bloodied, wounded, inCombat, cpr.dead, cpr.rolling.{deathSave, handgun, shoulderArms, melee, skill}). libWrapper-patches `CPRRoll.prototype.roll` to detect ephemeral rolling states (CPR fires zero custom hooks).
- **Recommended CPR Combat Pack** — sensible default priority ordering for combat-heavy CPR campaigns.
- **Per-actor config app** — ApplicationV2 dialog opened from any actor sheet's header (theatrical-mask icon, GM only). One row per registered state; image picker per row.
- **Public API** — `game.vsat.api` (also `game.vebjornsStateAwareTokens.api`): `addState`, `addSystemIntegration`, `getActiveState`, `reevaluate`, `forceState` (debug), plus custom hooks for downstream consumers.
- **Settings** — coexistence mode, default animation duration (default 0 ms = instant snap, optimised for animated webm tokens), enabled-for-non-GM-owners, applied pack, debug logging.

### v0.1 limitations

- No light-field UI in actor config (engine writes light fields if states declare them; UI for picking light values per state is v0.2).
- No UI for user-created custom states (compound / HP threshold / status effect — v0.2).
- No per-token override UI (token-level `imagesOverride` flag reserved in storage; UI is v0.2).
- No system shims for dnd5e / pf2e / others — v0.2+.

### Built atop the engineering skill

Built per the `foundry-vtt-module` skill conventions:
- ApplicationV2 + HandlebarsApplicationMixin for UI
- libWrapper for CPR's roll method (system-internal)
- CSS scoped under `.vsat-*` and wrapped in `@layer modules` for v13 cascade ordering
- Three-plane separation: engine ≠ shims ≠ user config
- System-agnostic core; shim contract documented for future systems
