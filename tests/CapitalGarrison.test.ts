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
});
