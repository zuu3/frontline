import { AttackExecution } from "../src/core/execution/AttackExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { TileRef } from "../src/core/game/GameMap";
import { GameID } from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";

let game: Game;
let attacker: Player;
let defender: Player;
let defenderSpawn: TileRef;
let attackerSpawn: TileRef;

const gameID: GameID = "game_id";

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
      null,
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
  });

  test("with zero garrison, capital fall grants no troop plunder", () => {
    // Same rationale as above: relocate the capital to the tile the siege
    // captures first, neutralize background troop growth, and measure
    // total troops handed back to the attacker directly, rather than the
    // noisy net troops() balance.
    vi.spyOn(game.config(), "troopIncreaseRate").mockReturnValue(0);
    const addTroopsSpy = vi.spyOn(attacker, "addTroops");
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
  });
});
