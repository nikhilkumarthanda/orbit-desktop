import { useRef, type MutableRefObject } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { Stars } from "@react-three/drei";
import * as THREE from "three";
import { damp } from "maath/easing";
import { assetUrl } from "../asset-url";
import type { CameraState } from "./cameraState";

export function Starfield({ camera }: { camera: MutableRefObject<CameraState> }) {
  const texture = useLoader(THREE.TextureLoader, assetUrl("textures/skybox/milkyway.jpg"));
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const intensity = useRef(0.16);

  useFrame((_, delta) => {
    const target = camera.current.tier === "galaxy" ? 1 : 0.16;
    damp(intensity, "current", target, 0.8, delta);
    if (material.current) material.current.opacity = intensity.current;
  });

  return (
    <>
      <mesh scale={[-1, 1, 1]}>
        <sphereGeometry args={[400, 48, 32]} />
        <meshBasicMaterial ref={material} map={texture} side={THREE.BackSide} transparent opacity={intensity.current} depthWrite={false} />
      </mesh>
      <Stars radius={300} depth={60} count={4000} factor={3} saturation={0} fade speed={0.4} />
    </>
  );
}
