import { useRef } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import * as THREE from "three";
import { assetUrl } from "../asset-url";
import { SUN_RADIUS } from "./planets";

export function Sun() {
  const texture = useLoader(THREE.TextureLoader, assetUrl("textures/planets/sun.jpg"));
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (mesh.current) mesh.current.rotation.y += delta * 0.03;
  });

  return (
    <group>
      <pointLight color="#fff4d6" intensity={420} distance={0} decay={2} />
      <mesh ref={mesh}>
        <sphereGeometry args={[SUN_RADIUS, 64, 48]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[SUN_RADIUS * 1.18, 32, 24]} />
        <meshBasicMaterial color="#ffb35c" transparent opacity={0.18} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    </group>
  );
}
