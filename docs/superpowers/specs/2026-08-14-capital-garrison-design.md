# Capital Garrison — Design Spec

## Summary

Players can set a **garrison ratio** (0% to a configured cap) that reserves a
share of their current troops as a defensive reserve tied to their capital
tile. Garrisoned troops are excluded from ordinary border combat everywhere
else on the map, but join the fight when an enemy attack reaches the exact
capital tile — making Capital Fall harder to pull off the more a player
garrisons. If the capital still falls, the attacker plunders the same
fraction of whatever garrison remains as they already do with gold.

This complements the existing Capital Fall mechanic: right now capturing the
capital tile uses identical combat math to any other border tile, so there's
no way to make your capital specifically harder to take. Garrison gives
players that lever, at the direct cost of weaker troops everywhere else on
their border.

## Goals / Non-Goals

**Goals:**
- A ratio-based reserve (like the existing attack-ratio slider), not a
  banked/deposited pool — no new stateful pool to keep in sync with troop
  growth, donations, nuke damage, etc.
- Garrisoned troops measurably strengthen capital-tile defense specifically,
  not the whole border.
- Capital Fall plunders the surviving garrison the same way it plunders gold.
- Player-adjustable via a slider next to the existing attack-ratio slider.

**Non-Goals:**
- No new building/unit type (rejected in favor of a ratio slider during
  brainstorming — see approaches below).
- No change to population growth, city caps, or troops() as the source of
  truth for anything outside combat math.
- No change to Defense Post mechanics (orthogonal, still range-based).

## Approach

Chosen: **ratio is always a live-derived value**, not a separately stored
troop pool.

```
garrisonedTroops() = round(troops() * garrisonRatio)
```

No new `bigint` pool on `PlayerImpl`, no per-tick reconciliation logic.
Every existing code path that mutates `troops()` (population growth,
`donateTroops`, nuke casualties, disband, etc.) automatically keeps the
garrison in proportion with zero additional wiring. This was chosen over a
real banked pool (Approach B, rejected: needs a tick-based transfer loop and
two pools to keep consistent under every troop-mutating code path) and over
a placeable building (Approach C, rejected: user explicitly wants a ratio
slider, not a build-menu item).

## Data Model

`PlayerImpl` (`src/core/game/PlayerImpl.ts`):
- New field `_garrisonRatio: number` (0 by default).
- `garrisonRatio(): number` — getter.
- `setGarrisonRatio(ratio: number): void` — clamps to
  `[0, config.garrisonMaxRatio()]`.
- `garrisonedTroops(): number` — `Math.round(this.troops() * this._garrisonRatio)`.
- `activeTroops(): number` — `this.troops() - this.garrisonedTroops()`. This
  is the number combat math and the attack-ratio slider should use
  everywhere except the capital-tile-specific calculation.

`Config` (`src/core/configuration/Config.ts`):
- New `garrisonMaxRatio(): number`. Default recommendation: `0.5` — capping
  at 50% keeps a garrisoning player's border meaningfully weaker rather than
  making border combat trivial for attackers while the capital turtles.
  (Tunable; not user-specified, flagged here for review.)
- Reuses the existing `capitalFallGoldPlunderFraction()` for troop plunder —
  no new config value needed, per the "same fraction as gold" decision.

## Network Sync

New intent, following the existing simple-setter pattern used by
`EmbargoIntent` / `DonateGoldIntent`:

- `SetGarrisonRatioIntentSchema` in `src/core/Schemas.ts` — `{ type:
  "set_garrison_ratio", ratio: number }`.
- New `SetGarrisonRatioExecution` in `src/core/execution/` — validates
  range, calls `player.setGarrisonRatio(ratio)`. Single-tick, no ongoing
  state (mirrors `EmbargoExecution`'s shape).
- Client sends this intent when the new slider (see UI) changes, the same
  way other slider-driven settings intents fire on input.
- Server-authoritative: `attackLogic` and Capital Fall both read
  `player.garrisonRatio()` server-side, so a malicious client can't lie
  about its own garrison.

## Combat Integration

`Config.attackLogic()` (`src/core/configuration/Config.ts`), the function
that already computes `attackerTroopLoss` / `defenderTroopLoss` /
`tilesPerTickUsed` per contested tile:

- Every existing reference to `defender.troops()` inside this function
  becomes conditional on whether `tileToConquer === defender.spawnTile()`:
  - **Capital tile**: use `defender.troops()` unchanged (full pool,
    garrison included — this is the one place garrison "joins the fight").
  - **Any other tile**: use `defender.activeTroops()` instead (garrison
    excluded).
- This touches all four `defender.troops()` call sites in the current
  formula: `defenderTroopLoss`, `currentAttackerLoss`'s
  `defender.troops() / attackTroops` ratio, `altAttackerLoss`'s
  `defenderTroopLoss` term, and `tilesPerTickUsed`'s
  `defender.troops() / (5 * attackTroops)` ratio.
- `AttackExecution.tick()`'s `targetPlayer.removeTroops(defenderTroopLoss)`
  call is unchanged — `removeTroops` reduces the single underlying
  `_troops` pool regardless of the garrison/active split, since the split
  is virtual (derived), not a separate ledger. Losses at the capital tile
  naturally draw down `troops()`, which shrinks `garrisonedTroops()`
  proportionally too — consistent with "garrison actively fights and can be
  worn down."

Everywhere else in the codebase that reads `player.troops()` for UI display,
attack-ratio sizing, population caps, etc. is **unchanged** — those stay
keyed to the full pool. Only the two `attackLogic` combat-math call sites
and the attack-ratio troop-sizing calc (see UI section) need to switch to
`activeTroops()`.

## Capital Fall Integration

`AttackExecution.handleCapitalFall()` (`src/core/execution/AttackExecution.ts`):

- After the existing gold-plunder block, add the same shape for troops:
  ```
  const troopPlunder = round(target.garrisonedTroops() * plunderFraction)
  target.removeTroops(troopPlunder)
  this._owner.addTroops(troopPlunder)
  ```
- Reuses `plunderFraction` already computed from
  `capitalFallGoldPlunderFraction()` — no new config read.
- Message copy (`events_display.capital_captured` /
  `events_display.capital_fallen`) gets the troop count added alongside the
  existing gold amount, mirroring the existing interpolation params.

## UI

`src/client` control panel (wherever the existing attack-ratio slider
lives):
- New slider directly below it: **"Capital Garrison"**, range 0 to
  `garrisonMaxRatio()`, same visual treatment as the attack-ratio slider.
  Sends `SetGarrisonRatioIntent` on change.
- Troop readout splits into two lines: **"Active Troops: X"** /
  **"Capital Garrison: Y"** (X = `activeTroops()`, Y = `garrisonedTroops()`),
  replacing the single combined "Troops:" line.
- The attack-ratio slider's troop math (currently
  `myPlayer.troops() * attackRatio` when sizing an outgoing attack in
  `ClientGameRunner.ts` / wherever `SendAttackIntentEvent` troop count is
  computed) switches to `myPlayer.activeTroops() * attackRatio` — you can
  never commit garrisoned troops to an outgoing attack.

Help modal: add a `mechanic_capital_garrison` card to the existing
"FrontLine Mechanics" grid (added this session), same pattern as the other
four cards. Changelog/news entry once shipped, same pattern as prior
features this session.

## Error Handling / Edge Cases

- Ratio clamped both client-side (slider min/max) and server-side
  (`setGarrisonRatio`) — never trust the client value alone.
- `troops() === 0`: `garrisonedTroops()` and `activeTroops()` both
  naturally resolve to 0, no division-by-zero risk (ratio is a
  multiplication, not a division).
- Player with no capital (`spawnTile() === undefined`, e.g. mid-relocation
  after an earlier Capital Fall): `attackLogic`'s
  `tileToConquer === defender.spawnTile()` check is simply always false in
  that window, so garrison contributes nothing until the new capital tile
  is set — consistent with "garrison only defends the capital tile."
- Multiple simultaneous attacks converging on the capital tile in the same
  tick: no special handling needed — `troops()` (which includes garrison)
  is already the shared pool every concurrent attack draws down against, so
  this falls out of the existing single-pool model for free.

## Testing

- `Config.test.ts` (or wherever `attackLogic` is unit-tested): compare
  `defenderTroopLoss`/`attackerTroopLoss` for the same attacker troop count
  against (a) a non-capital tile and (b) the capital tile, at 0% and 50%
  garrison ratio — confirms garrison is inert off-capital and active
  on-capital.
- `AttackExecution` capital-fall test: garrison at a known ratio, capture
  the capital, assert the attacker's `troops()` increased by
  `plunderFraction * garrisonedTroops()` and the defender's dropped by the
  same, mirroring the existing gold-plunder assertion.
- `PlayerImpl` test: `setGarrisonRatio` clamps below 0 and above
  `garrisonMaxRatio()`; `activeTroops() + garrisonedTroops() === troops()`
  holds after rounding (accept off-by-one from `Math.round`, assert within
  1).
- Existing `AttackExecution`/`Config` combat tests must still pass
  unmodified at garrison ratio 0 (the default), confirming zero behavior
  change for players who never touch the slider.
