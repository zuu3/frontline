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
