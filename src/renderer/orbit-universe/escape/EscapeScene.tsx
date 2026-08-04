import { useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { Stars, useGLTF } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { damp, damp3 } from "maath/easing";
import { assetUrl } from "../../asset-url";
import { tickEscape, type EscapeState } from "./escapeState";
import { IcePlanetGround } from "./IcePlanetGround";
import { LaneGuides } from "./LaneGuides";
import { Singularity, GravitationalLens, useGravitationalLens } from "./Singularity";

const LANE_SPACING = 3.4;
const FAR_Z = 46;
const MAX_OBSTACLES = 24;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const HULL_MATERIAL = new THREE.MeshStandardMaterial({ color: "#1b1f26", metalness: 0.75, roughness: 0.32, emissive: "#0a2530", emissiveIntensity: 0.25 });
const DARK_MATERIAL = new THREE.MeshStandardMaterial({ color: "#0d0f13", metalness: 0.8, roughness: 0.28 });
const CANOPY_MATERIAL = new THREE.MeshStandardMaterial({ color: "#bdf3ff", emissive: "#4fd6ff", emissiveIntensity: 1.1, metalness: 0.1, roughness: 0.15, transparent: true, opacity: 0.88 });
const TRIM_MATERIAL = new THREE.MeshBasicMaterial({ color: "#7fe0ff", toneMapped: false });

/** Procedural, not a loaded asset -- a sleek dark hull with cyan trim reads correctly against
 *  this scene's cinematic ice/singularity palette, where the earlier CC0 low-poly kit ship
 *  (bright yellow/tan blocks) read as a mismatched toy. */
function ShipHull() {
  return (
    <group scale={0.62}>
      <mesh rotation-x={Math.PI / 2} position={[0, 0, 0.05]} material={HULL_MATERIAL}>
        <cylinderGeometry args={[0.12, 0.32, 1.5, 8]} />
      </mesh>
      <mesh position={[0, 0, -0.73]} rotation-x={-Math.PI / 2} material={DARK_MATERIAL}>
        <coneGeometry args={[0.12, 0.32, 8]} />
      </mesh>
      <mesh position={[0, 0.13, -0.1]} scale={[1, 0.7, 1.3]} material={CANOPY_MATERIAL}>
        <sphereGeometry args={[0.13, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[side * 0.32, -0.02, 0.28]} rotation-z={side * 0.12} rotation-y={side * 0.16} material={DARK_MATERIAL}>
            <boxGeometry args={[0.46, 0.03, 0.5]} />
          </mesh>
          <mesh position={[side * 0.55, -0.02, 0.5]} material={TRIM_MATERIAL}>
            <boxGeometry args={[0.04, 0.035, 0.36]} />
          </mesh>
        </group>
      ))}
      {[-0.16, 0.16].map((x) => (
        <mesh key={x} position={[x, 0, 0.6]} rotation-x={Math.PI / 2} material={DARK_MATERIAL}>
          <cylinderGeometry args={[0.11, 0.09, 0.22, 10]} />
        </mesh>
      ))}
    </group>
  );
}

function Ship({ game }: { game: MutableRefObject<EscapeState> }) {
  const group = useRef<THREE.Group>(null);
  const engineGlow = useRef<THREE.PointLight>(null);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const targetX = game.current.lane * LANE_SPACING;
    damp(g.position, "x", targetX, 0.18, delta);
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, (targetX - g.position.x) * -0.25, 6, delta);
    const dashing = game.current.dash < 0.22;
    if (engineGlow.current) engineGlow.current.intensity = dashing ? 9 : 4;
  });
  return (
    <group ref={group} position={[0, 0, 0]}>
      <ShipHull />
      {[[-0.2, 0, 0.62], [0.2, 0, 0.62], [0, 0.18, 0.68]].map(([x, y, z], i) => (
        <mesh key={i} position={[x, y, z]}>
          <sphereGeometry args={[0.09, 10, 10]} />
          <meshBasicMaterial color="#8fe4ff" toneMapped={false} />
        </mesh>
      ))}
      <pointLight ref={engineGlow} color="#6fd7ff" position={[0, 0, 0.7]} distance={4} intensity={4} />
    </group>
  );
}

type Exhaust = { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number };

function ExhaustTrail({ game }: { game: MutableRefObject<EscapeState> }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const particles = useRef<Exhaust[]>(
    Array.from({ length: 40 }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 999, life: 1 })),
  );
  const spawnCursor = useRef(0);
  const spawnTimer = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((_, delta) => {
    if (game.current.running) {
      spawnTimer.current += delta;
      if (spawnTimer.current > 0.03) {
        spawnTimer.current = 0;
        const shipX = game.current.lane * LANE_SPACING;
        const p = particles.current[spawnCursor.current];
        spawnCursor.current = (spawnCursor.current + 1) % particles.current.length;
        p.x = shipX + (Math.random() - 0.5) * 0.15;
        p.y = (Math.random() - 0.5) * 0.15;
        p.z = 0.6;
        p.vx = (Math.random() - 0.5) * 0.3;
        p.vy = (Math.random() - 0.5) * 0.3;
        p.vz = 3 + Math.random() * 1.5;
        p.age = 0;
        p.life = 0.5 + Math.random() * 0.3;
      }
    }
    const mesh = meshRef.current;
    if (!mesh) return;
    particles.current.forEach((p, i) => {
      p.age += delta;
      const t = clamp(p.age / p.life, 0, 1);
      if (t >= 1) {
        dummy.position.set(0, -9999, 0);
        dummy.scale.setScalar(0.0001);
      } else {
        dummy.position.set(p.x + p.vx * p.age, p.y + p.vy * p.age, p.z + p.vz * p.age);
        dummy.scale.setScalar((1 - t) * 0.16);
      }
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, particles.current.length]}>
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial color="#bdeeff" transparent opacity={0.55} toneMapped={false} />
    </instancedMesh>
  );
}

const ringLabelTextures = new Map<number, THREE.Texture>();
function ringLabelTexture(value: number): THREE.Texture {
  let tex = ringLabelTextures.get(value);
  if (tex) return tex;
  const canvas = document.createElement("canvas");
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "700 60px Inter, sans-serif";
  ctx.fillStyle = "#eaf9ff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "#7fe0ff";
  ctx.shadowBlur = 20;
  ctx.fillText(`×${value}`, 64, 68);
  tex = new THREE.CanvasTexture(canvas);
  ringLabelTextures.set(value, tex);
  return tex;
}
const RING_VALUES = [2, 3, 4, 5];

function ObstacleSlot({ index, game }: { index: number; game: MutableRefObject<EscapeState> }) {
  const group = useRef<THREE.Group>(null);
  const wreckageRef = useRef<THREE.Group>(null);
  const fragmentRef = useRef<THREE.Group>(null);
  const riftGroup = useRef<THREE.Group>(null);
  const slabRef = useRef<THREE.Group>(null);
  const collapsingRef = useRef<THREE.Group>(null);
  const sweepRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Group>(null);
  const ringLabelRefs = useRef<Record<number, THREE.Sprite | null>>({});
  const debrisGltf = useGLTF(assetUrl("models/debris.glb"));
  const iceGltf = useGLTF(assetUrl("models/ice-crystal.glb"));
  const wreckageModel = useMemo(() => debrisGltf.scene.clone(true), [debrisGltf.scene]);
  const fragmentModel = useMemo(() => iceGltf.scene.clone(true), [iceGltf.scene]);

  useFrame((_, delta) => {
    const g = group.current;
    const obstacle = game.current.obstacles[index];
    if (!g) return;
    if (!obstacle) { g.visible = false; return }
    g.visible = true;
    g.position.set(obstacle.lane * LANE_SPACING, 0, -FAR_Z * obstacle.z);
    if (wreckageRef.current) { wreckageRef.current.visible = obstacle.kind === "wreckage"; wreckageRef.current.rotation.y += delta * 1.4; wreckageRef.current.rotation.x += delta * 0.7 }
    if (fragmentRef.current) { fragmentRef.current.visible = obstacle.kind === "fragment"; fragmentRef.current.rotation.y += delta * 0.5 }
    if (riftGroup.current) { riftGroup.current.visible = obstacle.kind === "rift"; riftGroup.current.rotation.z += delta * 0.9 }
    if (slabRef.current) slabRef.current.visible = obstacle.kind === "slab";
    if (collapsingRef.current) collapsingRef.current.visible = obstacle.kind === "collapsing";
    if (sweepRef.current) sweepRef.current.visible = obstacle.kind === "sweep";
    if (ringRef.current) {
      ringRef.current.visible = obstacle.kind === "ring";
      ringRef.current.rotation.z += delta * 0.4;
      RING_VALUES.forEach((v) => { const sprite = ringLabelRefs.current[v]; if (sprite) sprite.visible = obstacle.kind === "ring" && obstacle.ringValue === v });
    }
  });

  return (
    <group ref={group}>
      <group ref={wreckageRef} scale={0.85}>
        <primitive object={wreckageModel} />
      </group>
      <group ref={fragmentRef} scale={0.9}>
        <primitive object={fragmentModel} />
        <pointLight color="#8fe4ff" intensity={1.2} distance={4} />
      </group>
      <group ref={riftGroup}>
        <mesh rotation-x={Math.PI / 2}>
          <torusGeometry args={[1.1, 0.22, 10, 24]} />
          <meshStandardMaterial color="#173a5e" emissive="#4fb3ff" emissiveIntensity={1.6} />
        </mesh>
        <pointLight color="#4fb3ff" intensity={3.5} distance={6} />
      </group>
      <group ref={slabRef}>
        <mesh>
          <boxGeometry args={[1.5, 1.6, 0.3]} />
          <meshStandardMaterial color="#0c1116" emissive="#173241" emissiveIntensity={0.6} />
        </mesh>
      </group>
      <group ref={collapsingRef}>
        <mesh rotation-x={-Math.PI / 2} position={[0, -0.3, 0]}>
          <circleGeometry args={[1.3, 24]} />
          <meshStandardMaterial color="#1a0d0d" emissive="#ff5d3d" emissiveIntensity={0.9} side={THREE.DoubleSide} />
        </mesh>
        <pointLight color="#ff6a44" intensity={2.4} distance={5} />
      </group>
      <group ref={sweepRef}>
        <mesh>
          <boxGeometry args={[7.5, 0.4, 0.4]} />
          <meshStandardMaterial color="#221407" emissive="#ff9d3d" emissiveIntensity={1.1} />
        </mesh>
      </group>
      <group ref={ringRef}>
        <mesh rotation-x={Math.PI / 2}>
          <torusGeometry args={[1.35, 0.05, 12, 32]} />
          <meshBasicMaterial color="#bdf3ff" toneMapped={false} transparent opacity={0.85} />
        </mesh>
        {RING_VALUES.map((v) => (
          <sprite key={v} ref={(el) => { ringLabelRefs.current[v] = el }} position={[0, 1.9, 0]} scale={[1.1, 1.1, 1]}>
            <spriteMaterial map={ringLabelTexture(v)} transparent depthWrite={false} />
          </sprite>
        ))}
      </group>
    </group>
  );
}
useGLTF.preload(assetUrl("models/debris.glb"));
useGLTF.preload(assetUrl("models/ice-crystal.glb"));

function ChaseCamera({ game }: { game: MutableRefObject<EscapeState> }) {
  const shake = useRef(0);
  useFrame(({ camera }, delta) => {
    const shipX = game.current.lane * LANE_SPACING;
    const dashing = game.current.dash < 0.22;
    shake.current = THREE.MathUtils.damp(shake.current, dashing ? 0.12 : 0, 4, delta);
    const jitterX = (Math.random() - 0.5) * shake.current;
    const jitterY = (Math.random() - 0.5) * shake.current;
    damp3(camera.position, [shipX * 0.55 + jitterX, 2.5 + jitterY, 6.5], 0.35, delta);
    const look = new THREE.Vector3(shipX * 0.7, 0.3, -10);
    camera.lookAt(look);
  });
  return null;
}

export function EscapeScene({ game, onEnded, pausedRef }: { game: MutableRefObject<EscapeState>; onEnded: () => void; pausedRef?: MutableRefObject<boolean> }) {
  const milkyWay = useLoader(THREE.TextureLoader, assetUrl("textures/skybox/milkyway.jpg"));
  milkyWay.colorSpace = THREE.SRGBColorSpace;
  const lens = useGravitationalLens();

  useFrame(() => {
    if (pausedRef?.current) return;
    const { justEnded } = tickEscape(game.current);
    if (justEnded) onEnded();
  });

  return (
    <>
      <ambientLight intensity={0.32} color="#3a4a5c" />
      <directionalLight position={[6, 8, 4]} intensity={1.6} color="#dce8ff" />
      <directionalLight position={[-5, -3, 6]} intensity={0.5} color="#4f7fb8" />
      <mesh scale={[-1, 1, 1]}>
        <sphereGeometry args={[300, 32, 24]} />
        <meshBasicMaterial map={milkyWay} side={THREE.BackSide} depthWrite={false} />
      </mesh>
      <Stars radius={200} depth={50} count={3000} factor={2.5} saturation={0} fade speed={0.3} />
      <IcePlanetGround game={game} />
      <LaneGuides game={game} />
      <Singularity />
      <Ship game={game} />
      <ExhaustTrail game={game} />
      {Array.from({ length: MAX_OBSTACLES }, (_, i) => (
        <ObstacleSlot key={i} index={i} game={game} />
      ))}
      <ChaseCamera game={game} />
      <EffectComposer>
        <Bloom intensity={0.7} luminanceThreshold={0.35} luminanceSmoothing={0.2} mipmapBlur radius={0.6} />
        <primitive object={lens} />
        <GravitationalLens effect={lens} />
      </EffectComposer>
    </>
  );
}
