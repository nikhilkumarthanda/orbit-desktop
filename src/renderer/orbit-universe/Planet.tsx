import { useMemo, useRef, useState, type MutableRefObject } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { assetUrl } from "../asset-url";
import { bodyPosition, type CameraState } from "./cameraState";
import { ALL_BODIES, ORBIT_INDEX, type PlanetDef } from "./planets";

function generateOrbitTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const surface = ctx.createRadialGradient(180, 96, 10, 240, 128, 300);
  surface.addColorStop(0, "#edf0e7");
  surface.addColorStop(0.16, "#7786a8");
  surface.addColorStop(0.68, "#7786a8");
  surface.addColorStop(1, "#090b18");
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 0.42;
  for (let band = 0; band < 9; band++) {
    const y = ((band + 1) / 10) * canvas.height;
    ctx.strokeStyle = band % 2 ? "#c1c6ba" : "#252d48";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(canvas.width * 0.3, y - 14, canvas.width * 0.7, y + 12, canvas.width, y);
    ctx.stroke();
  }
  return new THREE.CanvasTexture(canvas);
}

function OrbitRing({ def }: { def: NonNullable<PlanetDef["ring"]> }) {
  const texture = useLoader(THREE.TextureLoader, assetUrl(def.texture));
  texture.anisotropy = 8;
  return (
    <mesh rotation-x={Math.PI / 2.3}>
      <ringGeometry args={[def.innerScale, def.outerScale, 96]} />
      <meshBasicMaterial map={texture} color={def.tint} transparent side={THREE.DoubleSide} opacity={0.85} depthWrite={false} />
    </mesh>
  );
}

function EarthSurface({ def }: { def: PlanetDef }) {
  const [day, night, clouds] = useLoader(THREE.TextureLoader, [assetUrl(def.day!), assetUrl(def.night!), assetUrl(def.clouds!)]);
  day.colorSpace = THREE.SRGBColorSpace;
  night.colorSpace = THREE.SRGBColorSpace;
  clouds.colorSpace = THREE.SRGBColorSpace;
  [day, night, clouds].forEach((t) => (t.anisotropy = 8));
  const cloudMesh = useRef<THREE.Mesh>(null);
  useFrame((_, delta) => {
    if (cloudMesh.current) cloudMesh.current.rotation.y += delta * def.spinSpeed * 0.09;
  });
  return (
    <>
      <mesh>
        <sphereGeometry args={[def.radius, 64, 48]} />
        <meshStandardMaterial map={day} emissiveMap={night} emissive="#ffe9b0" emissiveIntensity={0.55} roughness={0.85} metalness={0} />
      </mesh>
      <mesh ref={cloudMesh}>
        <sphereGeometry args={[def.radius * 1.012, 48, 36]} />
        <meshStandardMaterial map={clouds} transparent opacity={0.42} depthWrite={false} />
      </mesh>
    </>
  );
}

function TexturedSurface({ def }: { def: PlanetDef }) {
  const texture = useLoader(THREE.TextureLoader, assetUrl(def.day!));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return (
    <mesh>
      <sphereGeometry args={[def.radius, 56, 40]} />
      <meshStandardMaterial map={texture} roughness={0.95} metalness={0} />
    </mesh>
  );
}

function ProceduralSurface({ def }: { def: PlanetDef }) {
  const texture = useMemo(() => generateOrbitTexture(), []);
  return (
    <>
      <mesh>
        <sphereGeometry args={[def.radius, 56, 40]} />
        <meshStandardMaterial map={texture} roughness={0.8} metalness={0.05} emissive="#3a4470" emissiveIntensity={0.12} />
      </mesh>
      <mesh>
        <sphereGeometry args={[def.radius * 1.35, 32, 24]} />
        <meshBasicMaterial color="#8fb3ff" transparent opacity={0.14} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    </>
  );
}

export function Planet({ index, camera }: { index: number; camera: MutableRefObject<CameraState> }) {
  const def = ALL_BODIES[index];
  const group = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const [selected, setSelected] = useState(false);

  const orbitLineObject = useMemo(() => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * def.orbitDistance, 0, Math.sin(a) * def.orbitDistance));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: "#5a6480", transparent: true, opacity: 0.16 });
    return new THREE.LineLoop(geometry, material);
  }, [def.orbitDistance]);

  useFrame(({ clock }, delta) => {
    if (group.current) group.current.position.copy(bodyPosition(index, clock.elapsedTime));
    if (spin.current) spin.current.rotation.y += delta * def.spinSpeed * 0.25;
    const isSelected = camera.current.tier !== "galaxy" && camera.current.focusIndex === index;
    if (isSelected !== selected) setSelected(isSelected);
    const material = orbitLineObject.material as THREE.LineBasicMaterial;
    material.opacity = isSelected ? 0.55 : 0.16;
    material.color.set(isSelected ? "#cfe0ff" : "#5a6480");
  });

  return (
    <>
      <primitive object={orbitLineObject} />
      <group ref={group}>
        <group ref={spin} rotation-z={def.tilt}>
          {index === ORBIT_INDEX ? <ProceduralSurface def={def} /> : def.night && def.clouds ? <EarthSurface def={def} /> : <TexturedSurface def={def} />}
          {def.ring && <OrbitRing def={def.ring} />}
        </group>
        {selected && (
          <Html center distanceFactor={12} style={{ pointerEvents: "none" }}>
            <div className="orbit-planet-label">{def.name.toUpperCase()}</div>
          </Html>
        )}
      </group>
    </>
  );
}
