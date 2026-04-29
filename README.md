# State-Aware Tokens

A Foundry VTT module that automatically swaps a token's image (and other token visuals) based on game-state conditions: in combat, wounded, unconscious, rolling a specific skill, etc. **Priority-ordered state machine with per-actor configuration.** System-agnostic core; ships with a Cyberpunk Red Core integration shim. Extensible via a public API for other systems.

> **Status: v0.1.0 (initial release).** Core engine, CPR shim, per-actor image picker, recommended pack auto-applied. Custom-state UI (Compound / HP threshold / Status effect) and light-field UI ship in v0.1.1.

## Install

In Foundry VTT, paste this manifest URL into Add-on Modules → Install Module:

```
https://github.com/VebjornNyvoll/vebjorns-state-aware-tokens/releases/latest/download/module.json
```

Required dependency: **libWrapper** (`lib-wrapper`).
Recommended: **socketlib** (`socketlib`).

## Concept

Each token has a "winning state" — the highest-priority registered state whose predicate currently returns true for that actor. When the winning state changes, the token's image (and optionally other fields) swap to the user-configured visual for that state.

States are registered by **system shims**:

- **`unconscious`** — actor is at HP 0 (CPR's `mortallyWounded` maps to this)
- **`bloodied`** — actor is at half HP or below (CPR's `seriouslyWounded`)
- **`wounded`** — actor has taken damage but isn't bloodied
- **`dead`** — actor is dead
- **`inCombat`** — actor is in active combat
- **`cpr.rolling.handgun`** — ephemeral, fires while a CPR handgun attack is rolling
- **`cpr.rolling.shoulderArms`** — ephemeral, fires for ranged shoulder weapons
- **`cpr.rolling.melee`** — ephemeral, fires for melee attacks
- **`cpr.rolling.skill`** — ephemeral, fires for skill checks
- **`cpr.rolling.deathSave`** — ephemeral, fires while a death save is rolling

Higher-priority states win. If two states match at the same priority, the order of registration decides — but typically system shims declare priorities so this doesn't happen.

## Configure per actor

Open any actor sheet → header button **"State-Aware Tokens"** → for each registered state, pick the image you want shown when that state is winning. Save.

Per-actor config is stored at `actor.flags.vebjorns-state-aware-tokens.images`.

## Module settings

Foundry → Game Settings → Configure Settings → State-Aware Tokens:

| Setting | Scope | Default | Description |
|---|---|---|---|
| Coexistence Mode | World | `defer` | What to do when another module (TVA, Visage, ATL) is also managing the token's image. `defer` = let them win, we apply non-image fields only. `clobber` = override. `warn` = notify GM once, then defer. |
| Default Animation Duration | World | `0` (instant) | Cross-fade duration in milliseconds. Recommended `0` for animated webm tokens. |
| Active Preset Pack | World | (system-driven) | Bundle of states with sensible priorities. Auto-applied based on system. |
| Enable for Player-Owned Tokens | World | `false` | If on, players see swaps for tokens they own. Default GM-only. |
| Debug Logging | Client | `false` | Verbose console logging. |

## Public API

Other modules can register custom states or system integrations:

```js
// At your module's "ready" hook (after vebjorns-state-aware-tokens has fired its systemReady):
Hooks.once("vebjorns-state-aware-tokens.systemReady", (api) => {
  api.addState({
    id: "myCustomState",
    priority: 400,
    predicate: (actor) => actor.system.someValue > 100,
    triggers: [{ hook: "updateActor" }],
    description: "My custom state.",
  });
});
```

Full API:

```js
game.vsat.addState(stateDef)                   // register one state
game.vsat.addSystemIntegration({ systemId, states }) // register a bundle
game.vsat.addStatePack(pack)                   // register a curated pack
game.vsat.getActiveState(token)                // current winning state id
game.vsat.getRegisteredStates()                // all registered states
game.vsat.isStateActive(token, "unconscious")  // boolean
game.vsat.reevaluate(token)                    // force re-eval
game.vsat.reevaluateActor(actor)               // re-eval for all of actor's tokens
game.vsat.forceState(token, "unconscious")     // GM debug
game.vsat.clearOverrides(token)                // restore original art

// Hooks fired:
game.vsat.HOOKS.SYSTEM_READY        // shim registration window
game.vsat.HOOKS.STATE_CHANGED       // (token, prior, current)
game.vsat.HOOKS.BEFORE_APPLY        // (token, state, changes) — cancellable
game.vsat.HOOKS.AFTER_APPLY         // (token, state, changes)
```

## How states are evaluated

A state's `predicate(actor, ctx)` is called whenever any of its `triggers` fire. The triggers are Foundry hooks like `updateActor`, `createCombatant`, `deleteActiveEffect`, etc. The engine over-evaluates intentionally: when *any* trigger fires for an actor, *all* states are re-evaluated and the highest-priority match wins.

States can be **persistent** (predicate is read on every trigger) or **ephemeral** (auto-clears after `durationMs`). Ephemeral states are how the CPR shim represents "currently rolling X" — the shim fires our internal `systemEvent` hook on roll completion, which marks the state active for ~2 seconds and then auto-clears.

## Snapshot / restore

Before our first swap on a token, we read its current `texture.src` (and other fields we may mutate) into `tokenDocument.flags.vebjorns-state-aware-tokens.snapshot`. When all states clear, we restore from snapshot. This means each individual token of an actor restores to its own original art (e.g., `private-1.webm`, `private-2.webm`, `private-3.webm` each go back to their unique idle image — no cross-contamination).

## Coexistence with other token-management modules

Detected at apply time:

- **Token Variants Art** — checks `flags.token-variants.defaultImg`
- **Visage** — checks `flags.visage.activeStack` / `flags.visage.tokenSnapshot`
- **Active Token Lighting (ATL)** — checks `flags.ATL.originals`

When any of these are managing a token, our `defer` policy (default) skips image fields and applies only non-image fields (light, etc.). This avoids corrupting their snapshot/rollback flow.

## Cyberpunk Red Core integration

CPR fires no custom hooks for its rolls. The shim dynamically imports CPR's roll module (`/systems/cyberpunk-red-core/src/modules/rolls/cpr-rolls.js`) and uses libWrapper to wrap `CPRRoll.prototype.roll`. When a roll completes, the shim inspects `roll instanceof CPRAttackRoll`, the `weaponType` property, etc. to classify the roll into one of the `cpr.rolling.*` states. The state is active for 2 seconds (1.5 for skill rolls) and auto-clears.

CPR wound state is read directly from `actor.system.derivedStats.currentWoundState` — CPR doesn't represent wound states as Foundry status effects, so `actor.statuses` won't contain them.

## License

MIT.

## Roadmap

**v0.1.1** — light-field UI (per-state torch/glow configuration); custom-state UI: Compound (`A AND B`), HP threshold (`< 25%`), Status effect (`actor.statuses.has("prone")`).

**v0.2** — per-token override UI; alpha/scale/tint mutations; pack switcher with curated alternatives.

**v0.3** — additional system shims (dnd5e, pf2e); custom-state arbitrary-JS-expression for power users (sandboxed).
