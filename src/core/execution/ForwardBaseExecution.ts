import { Execution, Game, Unit } from "../game/Game";

// Purely passive: existing (owned, active) instances are read directly off
// player.units(UnitType.ForwardBase) by the supply-line distance calc in
// Config.attackLogic(). No combat, no per-tick behavior — this Execution
// only exists because ConstructionExecution requires one per structure type.
export class ForwardBaseExecution implements Execution {
  private mg: Game;
  private active: boolean = true;

  constructor(private base: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.base.isActive()) {
      this.active = false;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
