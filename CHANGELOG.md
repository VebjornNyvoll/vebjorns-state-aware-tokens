# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.8] - 2026-04-29

### Fixed

- **In-combat detection now works for unlinked tokens.** The `_isInCombat` predicate previously compared `combatant.actorId` against `actor.id`, which fails for unlinked tokens because their synthetic-actor `.id` is not the world-actor's id. The predicate now also matches by `combatant.tokenId === actor.token.id` (and falls back to reference equality), so unlinked tokens correctly swap when added to the combat tracker and revert when combat ends or is deleted.

### Changed

- **CPR roll detection rewritten.** v0.1.7's single `cpr.rolling` bucket has been replaced with typed buckets and per-skill states:
  - `cpr.rolling.attack` — every attack roll, regardless of weapon type (one bucket — by user request).
  - `cpr.rolling.deathSave`, `cpr.rolling.initiative`, `cpr.rolling.damage`, `cpr.rolling.stat`, `cpr.rolling.role` — typed buckets per CPR roll subclass.
  - `cpr.rolling.skill` — generic "any skill check" catch-all (low priority).
  - `cpr.rolling.skill.<slug>` — per-skill states (e.g. `cpr.rolling.skill.animal_handling`, `cpr.rolling.skill.sea_vehicle_tech`). One state is registered per unique skill found in the world's items + actors at install. Higher priority than the generic skill state, so a per-skill image overrides the generic one when configured.

### How detection works (architecture note)

CPR's `CPRRoll` subclasses do not extend Foundry's `Roll`, are not registered with `CONFIG.Dice.rolls`, and are deliberately omitted from `ChatMessage.rolls` (CPR's own design choice for Dice So Nice integration). The previous `createChatMessage` listener could only see "some chat message exists" with no way to type it.

The new shim monkey-patches `CPRChat.RenderRollCard` (dynamic-imported from `/systems/cyberpunk-red-core/src/modules/chat/cpr-chat.js`) on the rolling client to inspect the `cprRoll` instance directly — class name (`CPRSkillRoll`, `CPRAttackRoll`, etc.) plus `skillName` for skills, plus `entityData.{actor,token}` for actor resolution. The detection is then stamped onto the chat message via `preCreateChatMessage` as a flag, so the typed info travels through the socket to every other client. Each client's `createChatMessage` listener reads the flag and marks the appropriate ephemeral state.

This makes the detection survive every CPR roll path (sheet button, Token Action HUD, macro, `/red` chat command) without needing to wrap each entry point separately.

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
