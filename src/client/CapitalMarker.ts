import { Cell } from "../core/game/Game";
import type { TransformHandler } from "./TransformHandler";
import type { GameView } from "./view";

// Plain DOM overlay (no WebGL pass) showing where the local player's
// capital (spawnTile) currently is. Re-reads spawnTile every frame, so it
// also follows a capital-fall relocation with no extra wiring.
export function mountCapitalMarker(
  gameView: GameView,
  transformHandler: TransformHandler,
): () => void {
  const style = document.createElement("style");
  style.textContent = `
    @keyframes capital-marker-ring-pulse {
      0%, 100% { transform: scale(1); opacity: 0.6; }
      50% { transform: scale(1.5); opacity: 0.1; }
    }
  `;
  document.head.appendChild(style);

  // Zero-size anchor pinned to the tile's screen position; ring and icon
  // are positioned relative to it so each can center/offset independently.
  const anchor = document.createElement("div");
  anchor.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:0",
    "height:0",
    "pointer-events:none",
    "z-index:40",
    "display:none",
  ].join(";");

  const ring = document.createElement("div");
  ring.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    "width:24px",
    "height:24px",
    "margin-left:-12px",
    "margin-top:-12px",
    "border-radius:50%",
    "background:radial-gradient(circle, rgba(255,205,60,0.9) 0%, rgba(255,205,60,0) 70%)",
    "animation:capital-marker-ring-pulse 1.8s ease-in-out infinite",
  ].join(";");

  const icon = document.createElement("div");
  icon.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    "transform:translate(-50%,-130%)",
    "font-size:20px",
    "line-height:1",
    "filter:drop-shadow(0 1px 3px rgba(0,0,0,.8)) drop-shadow(0 0 4px rgba(255,205,60,.7))",
  ].join(";");
  icon.textContent = "👑";

  anchor.appendChild(ring);
  anchor.appendChild(icon);
  document.body.appendChild(anchor);

  let rafId: number;
  const tick = () => {
    const player = gameView.myPlayer();
    const tile = player?.spawnTile();
    if (tile === undefined) {
      anchor.style.display = "none";
    } else {
      const screen = transformHandler.worldToScreenCoordinates(
        new Cell(gameView.x(tile), gameView.y(tile)),
      );
      anchor.style.display = "block";
      anchor.style.left = `${screen.x}px`;
      anchor.style.top = `${screen.y}px`;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    anchor.remove();
    style.remove();
  };
}
