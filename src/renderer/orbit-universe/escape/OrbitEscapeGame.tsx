import { useEffect, useState, type MutableRefObject } from "react";
import { Canvas } from "@react-three/fiber";
import { EscapeScene } from "./EscapeScene";
import type { EscapeState } from "./escapeState";

type Hud = { score: number; best: number; multiplier: number; dash: number; running: boolean; over: boolean };

export function OrbitEscapeGame({ game, onEnded }: { game: MutableRefObject<EscapeState>; onEnded: () => void }) {
  const [hud, setHud] = useState<Hud>({ score: 0, best: game.current.best, multiplier: 1, dash: 1, running: false, over: false });

  useEffect(() => {
    const id = window.setInterval(() => {
      const g = game.current;
      setHud({ score: Math.floor(g.score), best: g.best, multiplier: g.multiplier, dash: g.dash, running: g.running, over: g.over });
    }, 100);
    return () => window.clearInterval(id);
  }, [game]);

  return (
    <div className="orbit-escape-overlay">
      <Canvas
        style={{ position: "absolute", inset: 0, zIndex: 1, background: "#000104" }}
        dpr={[1, 1.75]}
        gl={{ antialias: true }}
        camera={{ fov: 55, near: 0.1, far: 500, position: [0, 2.5, 6.5] }}
      >
        <EscapeScene game={game} onEnded={onEnded} />
      </Canvas>
      <div className="escape-hud">
        <div className="escape-hud-score"><b>SCORE {String(hud.score).padStart(6, "0")}</b><span>BEST {String(hud.best).padStart(6, "0")}</span></div>
        <div className="escape-hud-multiplier">× {hud.multiplier.toFixed(2)}</div>
        <div className="escape-hud-dash"><i style={{ width: `${hud.dash * 100}%` }} /></div>
        {!hud.running && (
          <div className="escape-hud-title">
            <h2>{hud.over ? "SIGNAL LOST" : "ORBIT ESCAPE"}</h2>
            <p>{hud.over ? "ENTER TO RUN AGAIN" : "A / D TO STEER · SPACE TO PHASE DASH"}</p>
          </div>
        )}
      </div>
    </div>
  );
}
