import { Suspense, useRef, type MutableRefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { Starfield } from "./Starfield";
import { Sun } from "./Sun";
import { Planet } from "./Planet";
import { CameraController } from "./CameraController";
import { ALL_BODIES, ORBIT_INDEX } from "./planets";
import type { CameraState } from "./cameraState";

function ArrivalWatcher({ camera, onOrbitReadyChange }: { camera: MutableRefObject<CameraState>; onOrbitReadyChange: (ready: boolean) => void }) {
  const ready = useRef(false);
  useFrame(() => {
    const state = camera.current;
    const atOrbit = state.tier === "planet" && state.focusIndex === ORBIT_INDEX && Math.abs(state.radius - state.targetRadius) < 0.35;
    if (atOrbit !== ready.current) {
      ready.current = atOrbit;
      onOrbitReadyChange(atOrbit);
    }
  });
  return null;
}

export function OrbitUniverse({ camera, onOrbitReadyChange }: { camera: MutableRefObject<CameraState>; onOrbitReadyChange: (ready: boolean) => void }) {
  return (
    <Canvas
      style={{ position: "absolute", inset: 0, zIndex: 1, background: "#000104" }}
      dpr={[1, 1.75]}
      gl={{ antialias: true }}
      camera={{ fov: 52, near: 0.05, far: 900 }}
    >
      <ambientLight intensity={0.35} />
      <Suspense fallback={null}>
        <Starfield camera={camera} />
        <Sun />
        {ALL_BODIES.map((_, index) => (
          <Planet key={index} index={index} camera={camera} />
        ))}
      </Suspense>
      <CameraController camera={camera} />
      <ArrivalWatcher camera={camera} onOrbitReadyChange={onOrbitReadyChange} />
      <EffectComposer>
        <Bloom intensity={0.55} luminanceThreshold={0.5} luminanceSmoothing={0.25} mipmapBlur radius={0.55} />
      </EffectComposer>
    </Canvas>
  );
}
