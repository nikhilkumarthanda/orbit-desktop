import { useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { EscapeState } from "./escapeState";

const LANE_SPACING = 3.4;
const GUIDE_LENGTH = 130;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function LaneStrip({ laneIndex, game }: { laneIndex: -1 | 0 | 1; game: MutableRefObject<EscapeState> }) {
  const material = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (!material.current) return;
    const closeness = 1 - clamp(Math.abs(game.current.lane - laneIndex), 0, 1);
    const pulse = closeness > 0.6 ? 0.4 + closeness * 0.5 + Math.sin(clock.elapsedTime * 4) * 0.1 : 0.2 + closeness * 0.2;
    material.current.opacity = pulse;
    material.current.color.set(closeness > 0.6 ? "#bdf3ff" : "#5fb8d6");
  });
  return (
    <mesh rotation-x={-Math.PI / 2} position={[laneIndex * LANE_SPACING, -0.6, -GUIDE_LENGTH / 2 + 4]}>
      <planeGeometry args={[0.06, GUIDE_LENGTH, 1, 1]} />
      <meshBasicMaterial ref={material} color="#5fb8d6" transparent opacity={0.22} toneMapped={false} />
    </mesh>
  );
}

export function LaneGuides({ game }: { game: MutableRefObject<EscapeState> }) {
  return (
    <>
      <LaneStrip laneIndex={-1} game={game} />
      <LaneStrip laneIndex={0} game={game} />
      <LaneStrip laneIndex={1} game={game} />
    </>
  );
}
