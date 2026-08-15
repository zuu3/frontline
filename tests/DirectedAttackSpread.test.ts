import { AttackExecution } from "../src/core/execution/AttackExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { TileRef } from "../src/core/game/GameMap";
import { GameID } from "../src/core/Schemas";
import { setup } from "./util/Setup";

// Regression test for the "thin tunnel then diamond balloon" bug: a
// directed attack toward a click point far across a big territory used to
// let the manhattan-distance-to-click term dominate the tile priority
// queue outright (it's unbounded, so on a big map it dwarfs the
// terrain/adjacency terms), meaning almost the whole tile budget went to
// extending a single tile-wide corridor toward the click point instead of
// letting the border grow broadly with a lean. Capping that term
// (Config.directedAttackBiasMaxDistance) keeps it comparable in size to
// the terrain/adjacency terms so blobby growth wins again once a border
// tile is farther from the click than the cap.
//
// Tests the priority formula directly (spying on the private toConquer
// heap's enqueue calls) rather than an emergent multi-tick shape, which
// only compounds visibly over a very large number of ticks and is slow
// and noisy to assert on.
describe("Directed attack priority — distance-to-click cap", () => {
  test("priority credit stops growing past directedAttackBiasMaxDistance", async () => {
    const gameID: GameID = "game_id";
    const game: Game = await setup("big_plains", {
      infiniteGold: true,
      instantBuild: true,
      infiniteTroops: true,
    });

    const attackerInfo = new PlayerInfo(
      "attacker",
      PlayerType.Human,
      null,
      "attacker_id",
    );
    game.addPlayer(attackerInfo);

    const spawnTile = game.ref(20, 100);
    game.addExecution(
      new SpawnExecution(gameID, game.player(attackerInfo.id).info(), spawnTile),
    );
    game.executeNextTick();
    game.executeNextTick();

    const attacker: Player = game.player(attackerInfo.id);

    // Two tiles the attacker owns, both far past the 40-tile cap from the
    // click point but at very different distances from it (50 vs 200) —
    // each has an adjacent unclaimed neighbor directly further from the
    // click, isolating exactly the distance term under test.
    const clickTile = game.ref(20, 100); // click point, arbitrary fixed cell
    const nearOwned = game.ref(70, 100); // distance to click: 50
    const farOwned = game.ref(190, 100); // distance to click: 170 (map is 200 wide)
    attacker.conquer(nearOwned);
    attacker.conquer(farOwned);
    const nearNeighbor = game.ref(71, 100); // one further from click: 51
    const farNeighbor = game.ref(191, 100); // one further from click: 171

    const execution = new AttackExecution(
      100_000,
      attacker,
      game.terraNullius().id(),
      null,
      true,
      clickTile,
    );
    execution.init(game, game.ticks());

    const heap = (execution as unknown as { toConquer: { enqueue: (t: TileRef, p: number) => void } })
      .toConquer;
    const calls: { tile: TileRef; priority: number }[] = [];
    const originalEnqueue = heap.enqueue.bind(heap);
    heap.enqueue = (tile: TileRef, priority: number) => {
      calls.push({ tile, priority });
      originalEnqueue(tile, priority);
    };

    (execution as unknown as { addNeighbors: (t: TileRef) => void }).addNeighbors(
      nearOwned,
    );
    (execution as unknown as { addNeighbors: (t: TileRef) => void }).addNeighbors(
      farOwned,
    );

    const nearPriority = calls.find((c) => c.tile === nearNeighbor)?.priority;
    const farPriority = calls.find((c) => c.tile === farNeighbor)?.priority;

    expect(nearPriority).toBeDefined();
    expect(farPriority).toBeDefined();

    // Both distances (51, 201) are past the 40-tile cap, so both get the
    // SAME capped bias credit (40 * 0.2 = 8) — the only remaining
    // difference between the two priorities is terrain/adjacency/random
    // noise (roughly ±10-15 here), not the raw 150-tile gap in distance
    // (which at the old uncapped weight would separate them by 30).
    expect(Math.abs(nearPriority! - farPriority!)).toBeLessThan(15);
  });
});
