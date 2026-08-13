# Capital Garrison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player reserve a ratio of their troops as a capital garrison that's excluded from ordinary border combat but joins the fight when an enemy reaches the exact capital tile, and gets partially plundered (same fraction as gold) if the capital still falls.

**Architecture:** The garrison is never a separately stored troop pool — it's `troops() * garrisonRatio` computed live wherever needed (Approach A from the design spec). `garrisonRatio` is the only new persisted state, added to `PlayerImpl`/`Player` and synced client↔server via a new intent, the same shape as the existing `EmbargoIntent`/`TogglePauseIntent`. Combat math in `Config.attackLogic()` branches on whether the contested tile is the defender's capital: off-capital, defender's troop pool for the calculation excludes the garrison; on-capital, it's included.

**Tech Stack:** TypeScript, Zod schemas, Lit web components (client HUD), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-capital-garrison-design.md`

## Global Constraints

- Repo lives in Proxmox LXC container CT107 at `/root/OpenFrontIO`, not on the host filesystem directly. Every shell command in this plan must be run as `pct exec 107 -- bash -c "cd /root/OpenFrontIO && <command>"`. Every file edit must happen on a locally pulled copy (`pct pull 107 <container-path> <local-path>`), then pushed back (`pct push 107 <local-path> <container-path>`) — there is no direct filesystem access to the container from this plan's execution environment.
- `garrisonMaxRatio()` cap is **0.5** (50%), confirmed by the user — do not use a different value.
- Troop plunder on Capital Fall reuses the existing `capitalFallGoldPlunderFraction()` (currently `0.25`) — do not add a separate config value for it, per the approved spec.
- After every task's code changes: run `npx tsc --noEmit -p tsconfig.json` (must be silent) and the task's own test file with `npx vitest run <path>` before committing. After the LAST task, run the full suite (`npx vitest run`) and confirm all files pass — the suite was last confirmed green at 230 files / 2716 tests before this feature; it should grow by the number of new tests added here and nothing should regress.
- This session's `.in-game` HUD elements (canvas, ControlPanel, radial menu, etc.) are explicitly exempt from the project's brand-color redesign rules (`DESIGN.md`) — keep using the existing HUD's own established colors/classes (e.g. `accent-aquarius`, `bg-white/5`) when touching `ControlPanel.ts`, don't introduce brand red there.
- Git commits happen inside the container: `pct exec 107 -- bash -c "cd /root/OpenFrontIO && git add <files> && git commit -m '...'"`.

---

### Task 1: Config — `garrisonMaxRatio()`

**Files:**
- Modify: `src/core/configuration/Config.ts` (near `capitalFallGoldPlunderFraction()`, currently ~line 649)

**Interfaces:**
- Produces: `Config.garrisonMaxRatio(): number` — used by Task 2's clamp and inherited by every `Config` subclass (including `tests/util/TestConfig.ts`, which extends `Config` and gets this for free).

- [ ] **Step 1: Add the method**

Pull the file, then add this method directly above `capitalFallGoldPlunderFraction()`:

```typescript
  // Max fraction of a player's troops that can be reserved as a capital
  // garrison. Capped below 1 so a fully-garrisoned player's border is still
  // meaningfully weaker than an ungarrisoned one — see
  // docs/superpowers/specs/2026-08-14-capital-garrison-design.md.
  garrisonMaxRatio(): number {
    return 0.5;
  }
```

- [ ] **Step 2: Push, typecheck**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add src/core/configuration/Config.ts
git commit -m "feat: add garrisonMaxRatio config knob"
```

---

### Task 2: Player data model — `garrisonRatio`, `activeTroops`, `garrisonedTroops`

**Files:**
- Modify: `src/core/game/Game.ts` (the `Player` interface, ~line 606-609, right after `removeTroops`)
- Modify: `src/core/game/PlayerImpl.ts` (constructor field block ~line 108-111; method block ~line 1211-1227)
- Test: `tests/PlayerImpl.test.ts`

**Interfaces:**
- Consumes: `Config.garrisonMaxRatio()` (Task 1).
- Produces (added to the `Player` interface, so every implementer — `PlayerImpl`, and later `PlayerView` in Task 8 — must have these):
  - `garrisonRatio(): number`
  - `setGarrisonRatio(ratio: number): void` — clamps to `[0, config.garrisonMaxRatio()]`.
  - `garrisonedTroops(): number` — `Math.round(troops() * garrisonRatio())`.
  - `activeTroops(): number` — `troops() - garrisonedTroops()`.

- [ ] **Step 1: Write the failing test**

Append to `tests/PlayerImpl.test.ts` (inside the existing `describe("PlayerImpl", ...)` block, using the existing `player`/`game` from `beforeEach`):

```typescript
  test("garrisonRatio defaults to 0 and derives active/garrisoned troops", () => {
    player.setTroops(1000);
    expect(player.garrisonRatio()).toBe(0);
    expect(player.garrisonedTroops()).toBe(0);
    expect(player.activeTroops()).toBe(1000);
  });

  test("setGarrisonRatio splits troops proportionally", () => {
    player.setTroops(1000);
    player.setGarrisonRatio(0.3);
    expect(player.garrisonRatio()).toBe(0.3);
    expect(player.garrisonedTroops()).toBe(300);
    expect(player.activeTroops()).toBe(700);
  });

  test("setGarrisonRatio clamps to [0, garrisonMaxRatio()]", () => {
    player.setGarrisonRatio(-1);
    expect(player.garrisonRatio()).toBe(0);

    player.setGarrisonRatio(0.99);
    expect(player.garrisonRatio()).toBe(game.config().garrisonMaxRatio());
  });

  test("activeTroops + garrisonedTroops always sums to troops (within rounding)", () => {
    player.setTroops(999);
    player.setGarrisonRatio(0.33);
    const sum = player.activeTroops() + player.garrisonedTroops();
    expect(Math.abs(sum - player.troops())).toBeLessThanOrEqual(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/PlayerImpl.test.ts
```
Expected: FAIL — `player.setGarrisonRatio is not a function` (or similar; the methods don't exist yet).

- [ ] **Step 3: Add the interface methods**

In `src/core/game/Game.ts`, in the `Player` interface, right after the existing line:
```typescript
  removeTroops(troops: number): number;
```
add:
```typescript
  garrisonRatio(): number;
  setGarrisonRatio(ratio: number): void;
  garrisonedTroops(): number;
  activeTroops(): number;
```

- [ ] **Step 4: Implement on PlayerImpl**

In `src/core/game/PlayerImpl.ts`, add the field next to the other private fields in the constructor block (right after `private _troops: bigint;` ~line 111):
```typescript
  private _garrisonRatio: number = 0;
```

Then, right after the existing `removeTroops` method (~line 1227, immediately before `captureUnit`), add:
```typescript
  garrisonRatio(): number {
    return this._garrisonRatio;
  }

  setGarrisonRatio(ratio: number): void {
    const max = this.mg.config().garrisonMaxRatio();
    this._garrisonRatio = Math.max(0, Math.min(ratio, max));
  }

  garrisonedTroops(): number {
    return Math.round(this.troops() * this._garrisonRatio);
  }

  activeTroops(): number {
    return this.troops() - this.garrisonedTroops();
  }
```

`this.mg` is already a constructor-injected `GameImpl` available throughout the class (see `this.mg.config()` used elsewhere, e.g. in `toFullUpdate`'s `deathStats` lookup) — no new import needed.

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/PlayerImpl.test.ts
```
Expected: PASS, all 4 new tests plus every pre-existing test in the file.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: clean. (This will surface any other `Player` implementers that now need the 4 new methods — there should be none besides `PlayerImpl` until Task 8 adds them to `PlayerView`; if tsc flags another implementer, add matching stub methods there before proceeding.)

- [ ] **Step 7: Commit**

```bash
git add src/core/game/Game.ts src/core/game/PlayerImpl.ts tests/PlayerImpl.test.ts
git commit -m "feat: add garrisonRatio/activeTroops/garrisonedTroops to Player"
```

---

### Task 3: Network schema — `SetGarrisonRatioIntent`

**Files:**
- Modify: `src/core/Schemas.ts`

**Interfaces:**
- Produces: `SetGarrisonRatioIntentSchema` (zod), `SetGarrisonRatioIntent` type, added to the `Intent` union and the `IntentSchema` discriminated union. Task 4 consumes `intent.ratio: number` from this.

- [ ] **Step 1: Add the schema**

Right after `EmbargoAllIntentSchema` (~line 509, before `DonateGoldIntentSchema`):
```typescript
export const SetGarrisonRatioIntentSchema = z.object({
  type: z.literal("set_garrison_ratio"),
  ratio: z.number().min(0).max(1),
});
```

- [ ] **Step 2: Add the type export**

Next to the other `export type X = z.infer<...>` lines (~line 63-87), add:
```typescript
export type SetGarrisonRatioIntent = z.infer<
  typeof SetGarrisonRatioIntentSchema
>;
```

- [ ] **Step 3: Add to the `Intent` union**

In the `Intent` union type (~line 31-53), add a line:
```typescript
  | SetGarrisonRatioIntent
```
(anywhere in the union list; put it next to `EmbargoAllIntent` for locality with its sibling in this schema file).

- [ ] **Step 4: Add to the discriminated union**

In `IntentSchema = z.discriminatedUnion("type", [...])` (~line 592-618), add:
```typescript
  SetGarrisonRatioIntentSchema,
```
next to `EmbargoAllIntentSchema`.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/Schemas.ts
git commit -m "feat: add set_garrison_ratio intent schema"
```

---

### Task 4: Server execution — `SetGarrisonRatioExecution`

**Files:**
- Create: `src/core/execution/SetGarrisonRatioExecution.ts`
- Modify: `src/core/execution/ExecutionManager.ts`

**Interfaces:**
- Consumes: `Player` (Task 2's `setGarrisonRatio`), `SetGarrisonRatioIntent` (Task 3).
- Produces: `SetGarrisonRatioExecution` class, wired into `Executor.createExec()`'s switch.

- [ ] **Step 1: Create the execution class**

Mirror `src/core/execution/EmbargoExecution.ts`'s shape exactly (single-tick, no target resolution needed since this only touches the acting player):

```typescript
import { Execution, Game, Player } from "../game/Game";

export class SetGarrisonRatioExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private readonly ratio: number,
  ) {}

  init(_mg: Game, _ticks: number): void {}

  tick(_ticks: number): void {
    this.player.setGarrisonRatio(this.ratio);
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
```

- [ ] **Step 2: Wire into ExecutionManager**

In `src/core/execution/ExecutionManager.ts`, add the import next to the other execution imports (alphabetically, near `EmbargoExecution`):
```typescript
import { SetGarrisonRatioExecution } from "./SetGarrisonRatioExecution";
```

Then in the `switch (intent.type)` block, add a case next to `"embargo_all"` (~line 107):
```typescript
      case "set_garrison_ratio":
        return new SetGarrisonRatioExecution(player, intent.ratio);
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: clean.

- [ ] **Step 4: Manual sanity check via existing test harness**

There's no per-execution unit test convention in this codebase for simple setter executions (`EmbargoExecution` itself has none) — coverage for this comes from Task 2's `PlayerImpl` tests (the setter itself) and Task 7's end-to-end `AttackExecution` test (which exercises `garrisonRatio` through real gameplay). Skip a dedicated test file here, consistent with the existing pattern.

- [ ] **Step 5: Commit**

```bash
git add src/core/execution/SetGarrisonRatioExecution.ts src/core/execution/ExecutionManager.ts
git commit -m "feat: add SetGarrisonRatioExecution"
```

---

### Task 5: Client transport — send the intent

**Files:**
- Modify: `src/client/Transport.ts`

**Interfaces:**
- Produces: `SendGarrisonRatioIntentEvent` (client `GameEvent`), consumed by Task 9's UI slider.

- [ ] **Step 1: Add the event class**

Next to `PauseGameIntentEvent` (~line 38):
```typescript
export class SendGarrisonRatioIntentEvent implements GameEvent {
  constructor(public readonly ratio: number) {}
}
```

- [ ] **Step 2: Register the listener**

In `Transport`'s constructor, next to the `PauseGameIntentEvent` registration (~line 260):
```typescript
    this.eventBus.on(SendGarrisonRatioIntentEvent, (e) =>
      this.onSendGarrisonRatioIntent(e),
    );
```

- [ ] **Step 3: Add the handler**

Next to `onPauseGameIntent` (~line 596):
```typescript
  private onSendGarrisonRatioIntent(event: SendGarrisonRatioIntentEvent) {
    this.sendIntent({
      type: "set_garrison_ratio",
      ratio: event.ratio,
    });
  }
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/client/Transport.ts
git commit -m "feat: wire SendGarrisonRatioIntentEvent through Transport"
```

---

### Task 6: Combat integration — `attackLogic` capital-vs-border split

**Files:**
- Modify: `src/core/configuration/Config.ts` (`attackLogic()`, ~line 685-825)
- Test: `tests/CapitalGarrison.test.ts` (new)

**Interfaces:**
- Consumes: `defender.spawnTile()`, `defender.troops()`, `defender.activeTroops()` (Task 2).
- Produces: no new public interface — this changes `attackLogic()`'s internal math only. `AttackExecution` (unchanged in this task) keeps calling it the same way.

- [ ] **Step 1: Write the failing test**

Create `tests/CapitalGarrison.test.ts`:

```typescript
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { TileRef } from "../src/core/game/GameMap";
import { GameID } from "../src/core/Schemas";
import { setup } from "./util/Setup";

let game: Game;
let attacker: Player;
let defender: Player;
let defenderSpawn: TileRef;
let attackerSpawn: TileRef;

const gameID: GameID = "game_id";

describe("Capital Garrison", () => {
  beforeEach(async () => {
    game = await setup("ocean_and_land", {
      infiniteGold: true,
      instantBuild: true,
      infiniteTroops: true,
    });
    const attackerInfo = new PlayerInfo(
      "attacker dude",
      PlayerType.Human,
      null,
      "attacker_id",
    );
    game.addPlayer(attackerInfo);
    const defenderInfo = new PlayerInfo(
      "defender dude",
      PlayerType.Human,
      null,
      "defender_id",
    );
    game.addPlayer(defenderInfo);

    attackerSpawn = game.ref(0, 10);
    defenderSpawn = game.ref(0, 15);

    game.addExecution(
      new SpawnExecution(gameID, game.player(attackerInfo.id).info(), attackerSpawn),
      new SpawnExecution(gameID, game.player(defenderInfo.id).info(), defenderSpawn),
    );
    game.executeNextTick();
    game.executeNextTick();

    attacker = game.player(attackerInfo.id);
    defender = game.player(defenderInfo.id);
  });

  test("garrison strengthens defense at the capital tile but not elsewhere", () => {
    defender.setTroops(10000);
    defender.setGarrisonRatio(0.5);

    const capitalResult = game
      .config()
      .attackLogic(game, 100, attacker, defender, defenderSpawn);
    const borderResult = game
      .config()
      .attackLogic(game, 100, attacker, defender, attackerSpawn);

    // Same attacker troop count, same defender, only the tile differs — the
    // capital tile's calculation sees defender.troops() (5000 active +
    // 5000 garrisoned = 10000), the border tile's sees activeTroops() only
    // (5000). More defending troops means more attacker losses and fewer
    // tiles conquered per tick, so the capital-tile numbers must both be
    // strictly greater than the border-tile numbers.
    expect(capitalResult.attackerTroopLoss).toBeGreaterThan(
      borderResult.attackerTroopLoss,
    );
    expect(capitalResult.tilesPerTickUsed).toBeGreaterThan(
      borderResult.tilesPerTickUsed,
    );
  });

  test("with zero garrison, capital and border tiles use identical defender troop counts", () => {
    defender.setTroops(10000);
    defender.setGarrisonRatio(0);

    const capitalResult = game
      .config()
      .attackLogic(game, 100, attacker, defender, defenderSpawn);
    const borderResult = game
      .config()
      .attackLogic(game, 100, attacker, defender, attackerSpawn);

    expect(capitalResult.attackerTroopLoss).toBeCloseTo(
      borderResult.attackerTroopLoss,
      5,
    );
    expect(capitalResult.tilesPerTickUsed).toBeCloseTo(
      borderResult.tilesPerTickUsed,
      5,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/CapitalGarrison.test.ts
```
Expected: FAIL on the first test — `capitalResult.attackerTroopLoss` equals `borderResult.attackerTroopLoss` right now (attackLogic doesn't yet special-case the capital tile), so `toBeGreaterThan` fails.

- [ ] **Step 3: Implement the split in `attackLogic`**

In `src/core/configuration/Config.ts`, inside `attackLogic()`, find the `if (defender.isPlayer())` block that computes `defenderTroopLoss`, `currentAttackerLoss`, `altAttackerLoss`, `attackerTroopLoss`, and the `tilesPerTickUsed` return value (~line 780-822). Add one line right after the block's opening `if (defender.isPlayer()) {` (before `defenseSig` is computed):

```typescript
      const effectiveDefenderTroops =
        tileToConquer === defender.spawnTile()
          ? defender.troops()
          : defender.activeTroops();
```

Then replace every remaining bare `defender.troops()` reference **inside this same `if (defender.isPlayer())` block** with `effectiveDefenderTroops`. There are exactly three:
1. `const defenderTroopLoss = defender.troops() / defender.numTilesOwned();` → `effectiveDefenderTroops / defender.numTilesOwned()`
2. `within(defender.troops() / attackTroops, 0.6, 2)` (inside `currentAttackerLoss`) → `within(effectiveDefenderTroops / attackTroops, 0.6, 2)`
3. `within(defender.troops() / (5 * attackTroops), 0.2, 1.5)` (inside the `tilesPerTickUsed` return expression) → `within(effectiveDefenderTroops / (5 * attackTroops), 0.2, 1.5)`

Do **not** touch `defender.numTilesOwned()` calls, `defender.isDisconnected()`, `defender.isTraitor()`, or anything outside this `if (defender.isPlayer())` block (e.g. the earlier Defense Post / fallout blocks use `defender` for unrelated checks, not `.troops()`).

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/CapitalGarrison.test.ts
```
Expected: PASS, both tests.

- [ ] **Step 5: Run the broader combat test suite to check for regressions**

```bash
npx vitest run tests/Attack.test.ts tests/core/game/GameImpl.test.ts
```
Expected: PASS — these tests never call `setGarrisonRatio`, so `garrisonRatio` stays at its default `0`, making `activeTroops() === troops()` and `effectiveDefenderTroops === defender.troops()` in every case — identical behavior to before this task.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/configuration/Config.ts tests/CapitalGarrison.test.ts
git commit -m "feat: garrison strengthens capital-tile defense in attackLogic"
```

---

### Task 7: Capital Fall — plunder the surviving garrison

**Files:**
- Modify: `src/core/execution/AttackExecution.ts` (`handleCapitalFall()`, ~line 382-403)
- Modify: `resources/lang/en.json`, `resources/lang/ko.json` (extend the capital-fall event message with a troops param)
- Test: `tests/CapitalGarrison.test.ts` (extend from Task 6)

**Interfaces:**
- Consumes: `target.garrisonedTroops()` (Task 2), `target.removeTroops()` / `this._owner.addTroops()` (pre-existing `Player` methods).

- [ ] **Step 1: Write the failing test**

Append to `tests/CapitalGarrison.test.ts`, inside the same `describe` block:

```typescript
  test("capital fall plunders the surviving garrison to the attacker", async () => {
    defender.setTroops(1000);
    defender.setGarrisonRatio(0.5);
    const attackerTroopsBeforeAttack = attacker.troops();

    const { AttackExecution } = await import(
      "../src/core/execution/AttackExecution"
    );
    game.addExecution(new AttackExecution(100, attacker, defender.id()));

    do {
      game.executeNextTick();
    } while (attacker.outgoingAttacks().length > 0);

    // The attacker only ever spends troops starting an attack (100, taken
    // up front) — nothing else in this flow adds troops back except the
    // new garrison-plunder code. Any increase over (before - 100) proves
    // the plunder fired.
    expect(attacker.troops()).toBeGreaterThan(attackerTroopsBeforeAttack - 100);
  });

  test("with zero garrison, capital fall grants no troop plunder", async () => {
    defender.setTroops(1000);
    defender.setGarrisonRatio(0);
    const attackerTroopsBeforeAttack = attacker.troops();

    const { AttackExecution } = await import(
      "../src/core/execution/AttackExecution"
    );
    game.addExecution(new AttackExecution(100, attacker, defender.id()));

    do {
      game.executeNextTick();
    } while (attacker.outgoingAttacks().length > 0);

    expect(attacker.troops()).toBeLessThanOrEqual(attackerTroopsBeforeAttack);
  });
```

Note: `AttackExecution` is dynamically imported here only because the top of the file doesn't otherwise need it; if a static import is already present after Task 6 leaves the file unchanged, switch this to a normal top-level `import { AttackExecution } from "../src/core/execution/AttackExecution";` instead — either works, prefer the static import for consistency with the rest of the test suite.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/CapitalGarrison.test.ts
```
Expected: FAIL on "capital fall plunders the surviving garrison" — `attacker.troops()` is not greater than `attackerTroopsBeforeAttack - 100` yet, since nothing plunders troops today.

- [ ] **Step 3: Implement the plunder**

In `src/core/execution/AttackExecution.ts`, inside `handleCapitalFall()`, right after the existing gold-plunder block (after `if (plundered > 0n) { this._owner.addGold(plundered, capitalTile); }`) and before the `this.mg.displayMessage(...)` calls, add:

```typescript
    const troopPlunderFraction = plunderFraction; // same fraction as gold, per spec
    const troopPlunder = Math.round(
      target.garrisonedTroops() * troopPlunderFraction,
    );
    const plunderedTroops = target.removeTroops(troopPlunder);
    if (plunderedTroops > 0) {
      this._owner.addTroops(plunderedTroops);
    }
```

Then update the `capital_captured` message right below (the `capital_fallen` message — the defender-facing "you lost your capital" message — only interpolates `{ name: this._owner.displayName() }`, no gold or troops, so it needs no change). Find:
```typescript
    this.mg.displayMessage(
      "events_display.capital_captured",
      MessageType.CAPITAL_CAPTURED,
      this._owner.id(),
      plundered,
      { name: target.displayName(), gold: renderNumber(plundered) },
    );
```
and change the params object to add the new `troops` key:
```typescript
      { name: target.displayName(), gold: renderNumber(plundered), troops: renderTroops(plunderedTroops) },
```
`renderTroops` is already imported at the top of this file (it's used for other messages elsewhere) — no new import needed.

- [ ] **Step 4: Update the `capital_captured` locale string**

Only `capital_captured` needs editing (`capital_fallen` doesn't interpolate gold/troops at all — leave it untouched). Pull `resources/lang/en.json`, find (in the `events_display` object):
```json
    "capital_captured": "You captured {name}'s capital and plundered {gold} gold!",
```
and change it to:
```json
    "capital_captured": "You captured {name}'s capital and plundered {gold} gold and {troops} troops!",
```

In `resources/lang/ko.json`, find:
```json
    "capital_captured": "{name}의 수도를 함락하고 {gold} 금을 약탈했습니다!",
```
and change it to:
```json
    "capital_captured": "{name}의 수도를 함락하고 {gold} 금과 병력 {troops}를 약탈했습니다!",
```

Push both files back to the container.

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/CapitalGarrison.test.ts
```
Expected: PASS, all 4 tests (2 from Task 6, 2 new).

- [ ] **Step 6: JSON validity + typecheck**

```bash
python3 -c "import json; json.load(open('resources/lang/en.json')); json.load(open('resources/lang/ko.json')); print('ok')"
npx tsc --noEmit -p tsconfig.json
```
Expected: `ok`, then clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/core/execution/AttackExecution.ts resources/lang/en.json resources/lang/ko.json tests/CapitalGarrison.test.ts
git commit -m "feat: plunder surviving garrison troops on capital fall"
```

---

### Task 8: Client sync — `garrisonRatio` over the wire

**Files:**
- Modify: `src/core/game/GameUpdates.ts` (`PlayerUpdate` interface, ~line 223-257)
- Modify: `src/core/game/GameUpdateUtils.ts` (`diffPlayerUpdate`, `applyStateUpdate`)
- Modify: `src/core/game/PlayerImpl.ts` (`toFullUpdate()`, ~line 320-345)
- Modify: `src/client/render/types/Renderer.ts` (`PlayerState` interface, ~line 61-87)
- Modify: `src/client/view/PlayerView.ts` (`stateFromUpdate()`, ~line 71-100; add getters near `troops()` ~line 515)

**Interfaces:**
- Consumes: `PlayerImpl.garrisonRatio()` (Task 2).
- Produces: `PlayerView.garrisonRatio()`, `PlayerView.activeTroops()`, `PlayerView.garrisonedTroops()` — consumed by Task 9's UI.

- [ ] **Step 1: Add `garrisonRatio` to `PlayerUpdate`**

In `src/core/game/GameUpdates.ts`, add to the `PlayerUpdate` interface, next to `troops?: number;`:
```typescript
  garrisonRatio?: number;
```

- [ ] **Step 2: Emit it from `toFullUpdate()`**

In `src/core/game/PlayerImpl.ts`, in `toFullUpdate()`'s returned object, add next to `troops: this.troops(),`:
```typescript
      garrisonRatio: this.garrisonRatio(),
```

- [ ] **Step 3: Add it to the diff fast-path and diff builder**

In `src/core/game/GameUpdateUtils.ts`'s `diffPlayerUpdate()`:
- Add `prev.garrisonRatio === next.garrisonRatio &&` to the big fast-path `if (...)` condition at the top (next to `prev.isLobbyCreator === next.isLobbyCreator &&`).
- Add `setIfDifferent("garrisonRatio", prev.garrisonRatio === next.garrisonRatio);` next to `setIfDifferent("isLobbyCreator", ...)`.

- [ ] **Step 4: Add it to `applyStateUpdate`**

In the same file's `applyStateUpdate()`, add:
```typescript
  if (pu.garrisonRatio !== undefined) target.garrisonRatio = pu.garrisonRatio;
```
next to the `if (pu.troops !== undefined) target.troops = pu.troops;` line.

- [ ] **Step 5: Add `garrisonRatio` to `PlayerState`**

In `src/client/render/types/Renderer.ts`, add to the `PlayerState` interface, next to `troops: number;`:
```typescript
  garrisonRatio: number;
```

- [ ] **Step 6: Populate it in `stateFromUpdate`**

In `src/client/view/PlayerView.ts`'s `stateFromUpdate()`, add next to `troops: pu.troops!,`:
```typescript
    garrisonRatio: pu.garrisonRatio ?? 0,
```
(defaulted, matching the pattern used by other optional fields like `inDoomsdayClock`, since this is a genuinely new field older archived game records won't have).

- [ ] **Step 7: Add the `PlayerView` getters**

In `src/client/view/PlayerView.ts`, right after the existing `troops(): number { return this.state.troops; }` (~line 515-517), add:
```typescript
  garrisonRatio(): number {
    return this.state.garrisonRatio;
  }

  garrisonedTroops(): number {
    return Math.round(this.troops() * this.state.garrisonRatio);
  }

  activeTroops(): number {
    return this.troops() - this.garrisonedTroops();
  }
```

- [ ] **Step 8: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: clean.

- [ ] **Step 9: Run the wire-diffing test suite**

```bash
npx vitest run tests/PlayerUpdateDiff.test.ts
```
Expected: PASS unmodified. This file has no exhaustive `PlayerUpdate` key enumeration (confirmed: no `isLobbyCreator`/`Object.keys` style check exists in it) — it only diffs specific known fields, so a new optional field needs no changes there.

- [ ] **Step 10: Run the full core test suite for regressions**

```bash
npx vitest run tests/PlayerImpl.test.ts tests/CapitalGarrison.test.ts tests/PlayerUpdateDiff.test.ts
```
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add src/core/game/GameUpdates.ts src/core/game/GameUpdateUtils.ts src/core/game/PlayerImpl.ts src/client/render/types/Renderer.ts src/client/view/PlayerView.ts
git commit -m "feat: sync garrisonRatio to the client over PlayerUpdate"
```

---

### Task 9: UI — garrison slider and split troop display

**Files:**
- Modify: `src/client/hud/layers/ControlPanel.ts`

**Interfaces:**
- Consumes: `PlayerView.garrisonRatio()`, `.activeTroops()`, `.garrisonedTroops()` (Task 8); `SendGarrisonRatioIntentEvent` (Task 5).

- [ ] **Step 1: Add state fields**

Next to the existing `@state() private _troops: number;` (~line 37-38), add:
```typescript
  @state()
  private _activeTroops: number;

  @state()
  private _garrisonedTroops: number;

  @state()
  private _garrisonRatio: number = 0;
```

- [ ] **Step 2: Populate them in `tick()`**

Right after the existing `this._troops = player.troops();` line (~line 117), add:
```typescript
    this._activeTroops = player.activeTroops();
    this._garrisonedTroops = player.garrisonedTroops();
    this._garrisonRatio = player.garrisonRatio();
```

- [ ] **Step 3: Switch the attack-ratio troop preview to `activeTroops()`**

There are two places the attack-ratio label shows a computed troop count from `this.game?.myPlayer()?.troops()` (desktop, ~line 528, inside the label showing `${(this.attackRatio * 100).toFixed(0)}% (${renderTroops(...)})`). Change:
```typescript
              (this.game?.myPlayer()?.troops() ?? 0) * this.attackRatio,
```
to:
```typescript
              (this.game?.myPlayer()?.activeTroops() ?? 0) * this.attackRatio,
```
(Only the desktop label shows the computed troop count; the mobile label only shows the percentage, so there's nothing to change there.)

- [ ] **Step 4: Add the slider input handler**

Next to `handleRatioSliderInput`/`handleRatioSliderPointerUp` (~line 315-323), add:
```typescript
  private handleGarrisonSliderInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const value = Number(input.value);
    this._garrisonRatio = value / 100;
    this.eventBus.emit(new SendGarrisonRatioIntentEvent(this._garrisonRatio));
  }

  private handleGarrisonSliderPointerUp(e: Event) {
    (e.target as HTMLInputElement).blur();
  }
```

Add the import at the top of the file, next to the existing `Controller`/`AttackRatioEvent` imports:
```typescript
import { SendGarrisonRatioIntentEvent } from "../../Transport";
```

- [ ] **Step 5: Add Row 3 to `renderDesktop()`**

Right after the existing "Row 2: attack ratio | slider" `</div>` block, before the closing `` ` `` of `renderDesktop()` (~line 542, right after the attack-ratio `<input>`'s closing tags), add a new row using the same structural pattern as Row 2 but with a garrison icon/label and `accent-white` instead of `accent-aquarius` (visually distinct from the attack-ratio slider, still within the HUD's existing non-brand palette — no red, per Global Constraints):

```typescript
      <!-- Row 3: capital garrison | slider -->
      <div class="flex items-center gap-1.5" translate="no">
        <div
          class="flex items-center gap-1 shrink-0 border border-gray-600 rounded-md px-1 py-0.5 text-sm font-bold text-white cursor-pointer w-[8rem]"
        >
          <span aria-hidden="true">🏰</span>
          <span
            >${(this._garrisonRatio * 100).toFixed(0)}%
            (${renderTroops(this._garrisonedTroops)})</span
          >
        </div>
        <input
          type="range"
          min="0"
          max=${String(
            Math.round(
              (this.game?.config().garrisonMaxRatio() ?? 0.5) * 100,
            ),
          )}
          .value=${String(Math.round(this._garrisonRatio * 100))}
          @input=${(e: Event) => this.handleGarrisonSliderInput(e)}
          @pointerup=${(e: Event) => this.handleGarrisonSliderPointerUp(e)}
          class="flex-1 h-1.5 accent-white cursor-pointer"
        />
      </div>
```

- [ ] **Step 6: Add the equivalent compact row to `renderMobile()`**

Mirror the same structure the attack-ratio row uses in `renderMobile()` (~line 545-598), appended as a new `<div class="flex gap-2 items-center">` block after the existing one, keeping the same compact icon+percentage+slider layout:

```typescript
      <div class="flex gap-2 items-center mt-1">
        <div
          class="flex flex-col items-center shrink-0 gap-0.5 w-8"
          translate="no"
        >
          <span aria-hidden="true" class="text-xs">🏰</span>
          <span class="text-white text-xs font-bold tabular-nums"
            >${(this._garrisonRatio * 100).toFixed(0)}%</span
          >
        </div>
        <div class="flex-1" translate="no">
          <input
            type="range"
            min="0"
            max=${String(
              Math.round(
                (this.game?.config().garrisonMaxRatio() ?? 0.5) * 100,
              ),
            )}
            .value=${String(Math.round(this._garrisonRatio * 100))}
            @input=${(e: Event) => this.handleGarrisonSliderInput(e)}
            @pointerup=${(e: Event) => this.handleGarrisonSliderPointerUp(e)}
            class="w-full h-1.5 accent-white cursor-pointer"
          />
        </div>
      </div>
```

- [ ] **Step 7: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: clean.

- [ ] **Step 8: Visual verification (manual, no automated test — this is a pure HUD layout change)**

Restart the dev server (`pkill -9 -f "OpenFrontIO"`, then `nohup npm run dev:host > /root/dev.log 2>&1 &`), start a solo game against bots, and confirm:
- Row 3 appears below the attack-ratio row on desktop, and the equivalent compact row appears on mobile width.
- Dragging the garrison slider changes the `🏰 X% (Y)` readout live.
- The attack-ratio row's troop-count preview drops when garrison ratio is raised (since it now reads `activeTroops()`).
- No `.in-game` color other than the pre-existing HUD palette appears (no red).

This step has no code artifact — it's a manual confirmation gate before committing. If a screenshot tool is available in this environment (this session's history built one at `/root/screenshot-tool`), use it; otherwise describe what you observed.

- [ ] **Step 9: Commit**

```bash
git add src/client/hud/layers/ControlPanel.ts
git commit -m "feat: add capital garrison slider and split troop readout to ControlPanel"
```

---

### Task 10: Docs — Help modal, changelog, news

**Files:**
- Modify: `src/client/HelpModal.ts` (FrontLine Mechanics grid, ~line 1154-1186)
- Modify: `resources/lang/en.json`, `resources/lang/ko.json`
- Modify: `resources/changelog.md`
- Modify: `resources/news.json`

**Interfaces:** None — pure content, following the exact pattern already established this session for the other 4 mechanics cards (Directed Attacks, Supply Lines & Forward Base, Oil Rig, Capital Fall).

- [ ] **Step 1: Add the 5th mechanics card**

In `src/client/HelpModal.ts`, inside the `grid grid-cols-1 md:grid-cols-2 gap-4` div (~line 1154), add a 5th card after the existing Capital Fall card:
```typescript
              <div class="bg-white/5 rounded-xl border border-white/10 p-4">
                <div class="font-bold text-white mb-1">
                  ${translateText("help_modal.mechanic_capital_garrison")}
                </div>
                <p class="text-white/60 text-sm">
                  ${translateText("help_modal.mechanic_capital_garrison_desc")}
                </p>
              </div>
```

- [ ] **Step 2: Add the translation keys**

Pull `resources/lang/en.json`. Find `"mechanic_capital_fall_desc"` (added earlier this session) and insert immediately after it, alphabetically correct since `"capital_garrison"` sorts after `"capital_fall"` and before `"directed_attack"`:
```json
    "mechanic_capital_garrison": "Capital Garrison",
    "mechanic_capital_garrison_desc": "Reserve a share of your troops as a capital garrison (up to 50%). Garrisoned troops sit out of border combat everywhere else, but join the fight if an enemy reaches your exact capital tile — and if it still falls, the attacker plunders the same fraction of your garrison they plunder in gold.",
```
Verify the result stays alphabetically sorted (this project has an `EnJsonSorted.test.ts` that enforces it) by checking the key immediately after your insertion is still `"mechanic_directed_attack"`.

Do the same in `resources/lang/ko.json` at the equivalent position (find `mechanic_capital_fall_desc`, insert after), with a natural Korean translation, e.g.:
```json
    "mechanic_capital_garrison": "수도 비축",
    "mechanic_capital_garrison_desc": "병력의 일부(최대 50%)를 수도 비축 병력으로 지정할 수 있습니다. 비축 병력은 국경 전투에는 참여하지 않지만, 적이 정확한 수도 타일까지 도달하면 방어에 합류합니다. 그래도 수도가 함락되면, 골드와 같은 비율로 비축 병력도 공격자에게 약탈당합니다.",
```

Push both files, then validate:
```bash
python3 -c "import json; json.load(open('resources/lang/en.json')); json.load(open('resources/lang/ko.json')); print('ok')"
```

- [ ] **Step 3: Add a changelog entry**

Pull `resources/changelog.md`. In the `## Alpha — New Gameplay` section (added earlier this session), add a bullet after **Capital markers**:
```markdown
- **Capital Garrison** — reserve up to 50% of your troops as a capital garrison. They sit out of border combat everywhere else, but defend your exact capital tile if it's attacked — and if the capital still falls, the attacker plunders the same fraction of your garrison they plunder in gold.
```

- [ ] **Step 4: Add a news entry**

Pull `resources/news.json`. Add a new object to the array, following the exact shape of the existing `frontline-capital-markers-2026` entry:
```json
  {
    "id": "frontline-capital-garrison-2026",
    "title": "New: Capital Garrison",
    "description": "Reserve up to 50% of your troops to defend your capital tile specifically — safe from border combat, but still at risk (like your gold) if the capital falls.",
    "url": null,
    "type": "announcement"
  },
```

- [ ] **Step 5: Push all four files, typecheck, run the doc-adjacent tests**

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run tests/client/components/NewsBox.test.ts
```
Expected: both clean/passing. (`EnJsonSorted.test.ts` and any translation-completeness test will run as part of the full suite in the final step below — no need to isolate them here if the alphabetical placement in Step 2 was done correctly.)

- [ ] **Step 6: Commit**

```bash
git add src/client/HelpModal.ts resources/lang/en.json resources/lang/ko.json resources/changelog.md resources/news.json
git commit -m "docs: document Capital Garrison in Help, changelog, and news"
```

---

## Final Verification

After Task 10's commit, run the complete suite once more to confirm nothing anywhere regressed:

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
```

Expected: clean typecheck; all test files pass, total test count higher than the pre-feature baseline (230 files / 2716 tests) by however many new tests were added across Tasks 2, 6, and 7 (4 + 2 + 2 = 8 new tests, so expect ~2724 tests, same 230 files since no new file was added beyond the one `tests/CapitalGarrison.test.ts`, making it 231 files).

Then restart the dev server and do one more manual pass: garrison a mid-value ratio (e.g. 30%), start a bot game, verify the slider, readout, and attack-ratio troop preview all behave as designed — this is the same check as Task 9 Step 8, repeated here as a final end-to-end confirmation once every task has landed.
