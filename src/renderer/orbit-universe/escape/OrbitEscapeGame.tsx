import { useEffect, useRef, type MutableRefObject } from "react";
import { drawEscape, type EscapeState } from "./escapeState";

export function OrbitEscapeGame({ game, onEnded }: { game: MutableRefObject<EscapeState>; onEnded: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);
  const phase = useRef(0);

  useEffect(() => {
    const loop = () => {
      const el = canvas.current;
      if (el) {
        const box = el.getBoundingClientRect(), ratio = devicePixelRatio;
        if (el.width !== Math.floor(box.width * ratio) || el.height !== Math.floor(box.height * ratio)) {
          el.width = Math.floor(box.width * ratio);
          el.height = Math.floor(box.height * ratio);
        }
        const ctx = el.getContext("2d")!;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, box.width, box.height);
        phase.current += 0.013;
        const { justEnded } = drawEscape(ctx, box.width, box.height, game.current, phase.current);
        if (justEnded) onEnded();
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [game, onEnded]);

  return <canvas className="orbit-escape-canvas" ref={canvas} />;
}
