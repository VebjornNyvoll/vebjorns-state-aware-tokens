# State-Aware Tokens

A Foundry VTT module that automatically swaps a token's image (and other token visuals) based on game-state conditions. Priority-ordered state machine. Per-actor configuration. System-agnostic core that can be extended with system shims; ships with a Cyberpunk Red Core shim for v0.1.

> **Status: v0.1.0** — core engine + CPR shim + per-actor image picker + recommended CPR Combat Pack.

## What it does

Tokens swap their art based on conditions. Examples:

- HP drops to 0 → `unconscious` state wins → swap to bloody-prone art
- Actor enters combat → `inCombat` state wins → swap to combat-ready stance
- Player rolls a handgun attack in CPR → `cpr.rolling.handgun` state wins for ~2 seconds → swap to firing pose, then return

Each state has a priority. The highest-priority state whose condition is true *right now* wins, and its mutations apply to the token. When all states clear, the token returns to its original art.

## Install

In Foundry → Add-on Modules → Install Module → Manifest URL:

```
https://github.com/VebjornNyvoll/vebjorns-state-aware-tokens/releases/latest/download/module.json
```

Required dependency: **libWrapper**.

## Usage

1. Enable the module in your world.
2. Open any actor sheet. Click the **State-Aware Tokens** header button (theatrical-mask icon, GM only).
3. Pick an image for each registered state. Image and webm formats both work.
4. Save. Place a token of that actor on a scene. Trigger the conditions (take damage, enter combat, make a roll). Watch it swap.

## How it works (mental model)

- A **state** is `{id, priority, predicate(actor), apply}`. The predicate is a pure function — given an actor, returns true if the state currently applies.
- The **engine** listens to Foundry hooks (combat, AE, actor update) and to system-shim-fired custom hooks. When triggered, it re-evaluates every registered state's predicate for the affected actor.
- The **first match wins** — highest-priority state whose predicate returns true is the winning state. Its mutations apply.
- When the winning state changes, the engine snapshots the original token values (so we can restore later) and writes the new ones via `tokenDoc.update()`.
- When no state matches, the engine restores from snapshot.

This is a [first-match priority resolution](https://en.wikipedia.org/wiki/Priority_queue) state machine, the same model used by `Token Variants Art`.

## Coexistence with other token modules

This module **defers** to Token Variants Art, Visage, and Active Token Lighting by default. If any of those modules has set its snapshot flag on a token, we skip image mutations on that token (we'll still apply non-image effects like `light.*`).

You can change this in the module settings (`coexistenceMode = clobber` or `warn`). `defer` is recommended.

## CPR shim

Out of the box, the CPR shim registers these states on Cyberpunk Red Core worlds:

| State ID | Priority | Triggers when |
|---|---|---|
| `dead` / `cpr.dead` | 1000/990 | `actor.system.derivedStats.currentWoundState === "dead"` (GM-set; CPR never auto-sets) |
| `cpr.rolling.deathSave` | 950 | Death save roll in flight (~3 s) |
| `unconscious` | 900 | `currentWoundState === "mortallyWounded"` (HP < 1) |
| `bloodied` | 700 | `currentWoundState === "seriouslyWounded"` (HP < ceil(maxHP/2)) |
| `cpr.rolling.handgun` | 350 | Handgun attack roll in flight (~2 s) |
| `cpr.rolling.shoulderArms` | 350 | Shoulder-arms attack roll in flight (~2 s) |
| `cpr.rolling.melee` | 350 | Melee attack roll in flight (~2 s) |
| `cpr.rolling.skill` | 300 | Generic skill roll in flight (~1.5 s) |
| `wounded` | 200 | `currentWoundState === "lightlyWounded"` |
| `inCombat` | 100 | Token has a combatant in any active combat |

CPR fires zero custom hooks of its own, so the rolling-* states are detected via libWrapper-wrapping CPR's `CPRRoll.prototype.roll`. This is fragile-ish (CPR could rename the class) but stable across the v0.92.x line as of 2026-04.

## Configuration

| Setting | Scope | Default | Description |
|---|---|---|---|
| Coexistence Mode | World (GM) | `defer` | What to do when another token-art module owns the image |
| Default Animation Duration | World (GM) | `0` (instant) | Cross-fade duration in ms when swapping |
| Enable for Player-Owned Tokens | World (GM) | `false` | If on, players see swaps for tokens they own |
| Active Preset Pack | World (GM) | `(none)` | Built-in: "Recommended CPR Combat Pack" |
| Debug Logging | Client | `false` | Verbose console output |

## Public API

```js
// game.vsat = game.vebjornsStateAwareTokens
game.vsat.api.addState({ id, priority, predicate, apply, ... });
game.vsat.api.addSystemIntegration({ systemId, states });
game.vsat.api.getActiveState(token);
game.vsat.api.reevaluate(token);

// Custom hooks fired by the module:
Hooks.on(game.vsat.api.HOOKS.STATE_CHANGED, (token, prior, current) => {});
Hooks.on(game.vsat.api.HOOKS.BEFORE_APPLY, (token, state, changes) => { /* return false to cancel */ });
Hooks.on(game.vsat.api.HOOKS.AFTER_APPLY, (token, state, changes) => {});
```

## Roadmap

**v0.2** — UI for user-created custom states (compound, HP threshold, status effect), light-field UI in the actor config, per-token override UI.

**v0.3** — UI-driven custom states with sandboxed JS predicates, more system shims (dnd5e, pf2e), Compendium-driven state packs.

## Architecture

Built per the [`foundry-vtt-module`](https://github.com/VebjornNyvoll/) skill conventions. Three-plane separation: engine ≠ shims ≠ user config. No monkey-patching in the engine; shims may use libWrapper for system internals (CPR forces this). CSS scoped under `.vsat-*` and wrapped in `@layer modules`.

## License

MIT — see LICENSE.
