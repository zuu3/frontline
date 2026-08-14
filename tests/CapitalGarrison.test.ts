import { AttackExecution } from "../src/core/execution/AttackExecution";
import { Executor } from "../src/core/execution/ExecutionManager";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { TileRef } from "../src/core/game/GameMap";
import {
  GameID,
  StampedIntent,
  StampedIntentSchema,
} from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";

let game: Game;
let attacker: Player;
let defender: Player;
let defenderSpawn: TileRef;
let attackerSpawn: TileRef;

const gameID: GameID = "game_id";
// Must match GAME_ID_REGEX (8 alphanumerics) so StampedIntentSchema.parse
// accepts it in the intent round-trip test below.
const DEFENDER_CLIENT_ID = "defendr1";

describe("Capital Garrison", () => {
  beforeEach(async () => {
    // TestConfig (setup()'s default) stubs attackLogic() to always return
    // {1,1,1} so game-tick tests stay deterministic — that stub would make
    // every assertion below vacuous, so use UseRealAttackLogic, which
    // delegates to Config.prototype.attackLogic (see tests/Disconnected.test.ts
    // for the same pattern).
    game = await setup(
      "ocean_and_land",
      {
        infiniteGold: true,
        instantBuild: true,
        infiniteTroops: true,
      },
      [],
      undefined,
      UseRealAttackLogic,
    );
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
      DEFENDER_CLIENT_ID,
      "defender_id",
    );
    game.addPlayer(defenderInfo);

    attackerSpawn = game.ref(0, 10);
    defenderSpawn = game.ref(0, 15);

    game.addExecution(
      new SpawnExecution(
        gameID,
        game.player(attackerInfo.id).info(),
        attackerSpawn,
      ),
      new SpawnExecution(
        gameID,
        game.player(defenderInfo.id).info(),
        defenderSpawn,
      ),
    );
    game.executeNextTick();
    game.executeNextTick();

    attacker = game.player(attackerInfo.id);
    defender = game.player(defenderInfo.id);
  });

  test("garrison strengthens defense at the capital tile but not elsewhere", () => {
    // 300 (not a large round number like 10000) keeps both the capital and
    // border troop/attackTroops ratios below attackLogic's internal
    // within(...) clamp ceilings — at attackTroops=100, a bigger troop
    // count pushes both sides to the same clamped max, which would make
    // the two results equal for a reason unrelated to the bug being tested.
    defender.setTroops(300);
    defender.setGarrisonRatio(0.5);

    // Both calls use the SAME tileToConquer, attacker, and defender troop
    // count — the only thing that changes between them is whether that
    // tile equals defender.spawnTile(). Comparing two different real map
    // tiles instead would confound the result with terrain type and the
    // attacker's supply-line distance penalty, which have nothing to do
    // with garrison; moving the capital via setSpawnTile() isolates the
    // capital-vs-border branch cleanly.
    const capitalResult = game
      .config()
      .attackLogic(game, 100, attacker, defender, defenderSpawn);

    defender.setSpawnTile(attackerSpawn);
    const borderResult = game
      .config()
      .attackLogic(game, 100, attacker, defender, defenderSpawn);

    // More defending troops means more attacker losses and fewer tiles
    // conquered per tick, so the capital-tile numbers must both be
    // strictly greater than the border-tile numbers.
    expect(capitalResult.attackerTroopLoss).toBeGreaterThan(
      borderResult.attackerTroopLoss,
    );
    expect(capitalResult.tilesPerTickUsed).toBeGreaterThan(
      borderResult.tilesPerTickUsed,
    );
  });

  test("with zero garrison, capital and border tiles use identical defender troop counts", () => {
    defender.setTroops(300);
    defender.setGarrisonRatio(0);

    const capitalResult = game
      .config()
      .attackLogic(game, 100, attacker, defender, defenderSpawn);

    defender.setSpawnTile(attackerSpawn);
    const borderResult = game
      .config()
      .attackLogic(game, 100, attacker, defender, defenderSpawn);

    expect(capitalResult.attackerTroopLoss).toBeCloseTo(
      borderResult.attackerTroopLoss,
      5,
    );
    expect(capitalResult.tilesPerTickUsed).toBeCloseTo(
      borderResult.tilesPerTickUsed,
      5,
    );
  });

  // AttackExecution's priority queue (seeded with a fixed PseudoRandom(123)
  // every instance, so this is deterministic, not flaky) happens to conquer
  // border tile 210 first out of defender's 10-tile "ocean_and_land" test
  // territory. That matters because AttackExecution.handleDeadDefender()
  // eliminates any defender under 100 tiles as soon as a single tile is
  // captured (mg.conquerPlayer(...), see the "conquered_no_gold" event) --
  // which, on this tiny map, happens on the very first capture. Left at its
  // default spawn tile (240, an interior tile captured later, if ever),
  // the capital would never actually fall within the siege this test runs,
  // so handleCapitalFall() -- the method under test -- would never
  // execute. Relocating the capital to 210 makes the very first (and,
  // thanks to that early-elimination rule, only) tile captured be the
  // capital tile, so the capture reliably exercises the code path.
  const CAPTURED_FIRST_TILE = 210;

  // Records every troop removal the defender takes, along with the troop
  // count immediately before it, while still applying the removal for real.
  // Lets the plunder tests below assert the exact plundered amount.
  function spyOnDefenderRemoveTroops(): {
    troopsBefore: number;
    amount: number;
  }[] {
    const removals: { troopsBefore: number; amount: number }[] = [];
    const original = defender.removeTroops.bind(defender);
    vi.spyOn(defender, "removeTroops").mockImplementation((amount: number) => {
      removals.push({ troopsBefore: defender.troops(), amount });
      return original(amount);
    });
    return removals;
  }

  test("capital fall plunders the surviving garrison to the attacker", () => {
    // Two more confounds make a naive before/after troops() comparison
    // useless here: (1) Config.troopIncreaseRate adds background
    // population growth every tick to every living player regardless of
    // combat, which at the 1,000,000 starting balance infiniteTroops gives
    // a human player dwarfs any plunder amount within a couple of ticks --
    // stub it to 0; and (2) once the defender is eliminated, the
    // pre-existing AttackExecution.retreat() path returns whatever is left
    // of the attacker's committed 100 troops, independent of plunder. That
    // committed pool starts at exactly 100 and (with only one outgoing
    // attack in flight) can only shrink from combat losses, so that
    // pre-existing mechanic can never hand back more than 100 troops in
    // total. Spying on addTroops and summing every call lets us prove the
    // plunder fired by showing the total exceeds that 100 ceiling.
    vi.spyOn(game.config(), "troopIncreaseRate").mockReturnValue(0);
    const addTroopsSpy = vi.spyOn(attacker, "addTroops");
    const removals = spyOnDefenderRemoveTroops();
    defender.setSpawnTile(CAPTURED_FIRST_TILE);
    defender.setTroops(1000);
    defender.setGarrisonRatio(0.5);

    game.addExecution(new AttackExecution(100, attacker, defender.id()));

    do {
      game.executeNextTick();
    } while (attacker.outgoingAttacks().length > 0);

    const totalTroopsAdded = addTroopsSpy.mock.calls.reduce(
      (sum, [n]) => sum + n,
      0,
    );
    expect(totalTroopsAdded).toBeGreaterThan(100);

    // Exact-amount check. The plunder is the final removeTroops() the
    // defender takes (handleCapitalFall runs last in the tick that captures
    // the capital, and the defender is eliminated immediately after), so
    // assert on that call rather than on a sum, which cannot tell plunder
    // apart from ordinary combat losses.
    //
    // The expected amount is recomputed from the defender's troop count as
    // observed *outside* the code under test, immediately before the
    // plunder call. It cannot be hardcoded: the siege erodes the defender's
    // troops for several ticks before the capital tile falls, so the
    // garrison at fall time is well below the 500 it started at. Rebuilding
    // the formula from the observed pre-plunder count still fails loudly if
    // handleCapitalFall uses troops() instead of garrisonedTroops(), or
    // drops the fraction multiply -- both would be 4x this value.
    const plunderFraction = game.config().capitalFallGoldPlunderFraction();
    const plunder = removals[removals.length - 1];
    const expectedPlunder = Math.round(
      Math.round(plunder.troopsBefore * 0.5) * plunderFraction,
    );
    expect(expectedPlunder).toBeGreaterThan(0);
    expect(plunder.amount).toBe(expectedPlunder);
    // The attacker must receive exactly what the defender lost -- a
    // duplication bug (troops conjured on the attacker's side) passes the
    // threshold assertion above but fails this one.
    expect(addTroopsSpy.mock.calls.map(([n]) => n)).toContain(expectedPlunder);
  });

  test("with zero garrison, capital fall grants no troop plunder", () => {
    // Same rationale as above: relocate the capital to the tile the siege
    // captures first, neutralize background troop growth, and measure
    // total troops handed back to the attacker directly, rather than the
    // noisy net troops() balance.
    vi.spyOn(game.config(), "troopIncreaseRate").mockReturnValue(0);
    const addTroopsSpy = vi.spyOn(attacker, "addTroops");
    const removals = spyOnDefenderRemoveTroops();
    defender.setSpawnTile(CAPTURED_FIRST_TILE);
    defender.setTroops(1000);
    defender.setGarrisonRatio(0);

    game.addExecution(new AttackExecution(100, attacker, defender.id()));

    do {
      game.executeNextTick();
    } while (attacker.outgoingAttacks().length > 0);

    const totalTroopsAdded = addTroopsSpy.mock.calls.reduce(
      (sum, [n]) => sum + n,
      0,
    );
    expect(totalTroopsAdded).toBeLessThanOrEqual(100);

    // Same final-removeTroops-call anchor as the test above: with an empty
    // garrison the plunder call must be for exactly 0, not merely "small".
    expect(removals[removals.length - 1].amount).toBe(0);
  });

  test("set_garrison_ratio intent applies through the real execution path", () => {
    // The other tests all call setGarrisonRatio() directly, which would stay
    // green if the intent wiring broke. This one goes through the schema and
    // the Executor switch, so a dropped union member or a mistyped case
    // string fails here.
    const executor = new Executor(game, gameID, DEFENDER_CLIENT_ID);
    const intent = StampedIntentSchema.parse({
      type: "set_garrison_ratio",
      ratio: 0.3,
      clientID: DEFENDER_CLIENT_ID,
    }) as StampedIntent;

    expect(defender.garrisonRatio()).not.toBe(0.3);

    // Two ticks: the first only init()s the freshly added execution, the
    // second runs its tick() (same pattern as tests/core/execution/
    // SpawnExecution.test.ts).
    game.addExecution(executor.createExec(intent));
    game.executeNextTick();
    game.executeNextTick();

    expect(defender.garrisonRatio()).toBe(0.3);
  });
});
