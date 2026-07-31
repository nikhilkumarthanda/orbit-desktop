import { useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { Stars, useGLTF } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { damp, damp3 } from "maath/easing";
import { assetUrl } from "../../asset-url";
import { tickEscape, type EscapeState } from "./escapeState";

const LANE_SPACING = 3.4;
const FAR_Z = 46;
const MAX_OBSTACLES = 24;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function Ship({ game }: { game: MutableRefObject<EscapeState> }) {
  const group = useRef<THREE.Group>(null);
  const engineGlow = useRef<THREE.PointLight>(null);
  const { scene } = useGLTF(assetUrl("models/ship.glb"));
  const model = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse((child) => { if (child instanceof THREE.Mesh) { child.castShadow = false; child.receiveShadow = false } });
    return clone;
  }, [scene]);

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
      <group rotation-y={Math.PI} scale={0.55}>
        <primitive object={model} />
      </group>
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
useGLTF.preload(assetUrl("models/ship.glb"));

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

function ObstacleSlot({ index, game }: { index: number; game: MutableRefObject<EscapeState> }) {
  const group = useRef<THREE.Group>(null);
  const debrisRef = useRef<THREE.Group>(null);
  const iceRef = useRef<THREE.Group>(null);
  const riftGroup = useRef<THREE.Group>(null);
  const debrisGltf = useGLTF(assetUrl("models/debris.glb"));
  const iceGltf = useGLTF(assetUrl("models/ice-crystal.glb"));
  const debrisModel = useMemo(() => debrisGltf.scene.clone(true), [debrisGltf.scene]);
  const iceModel = useMemo(() => iceGltf.scene.clone(true), [iceGltf.scene]);

  useFrame((_, delta) => {
    const g = group.current;
    const obstacle = game.current.obstacles[index];
    if (!g) return;
    if (!obstacle) { g.visible = false; return }
    g.visible = true;
    g.position.set(obstacle.lane * LANE_SPACING, 0, -FAR_Z * obstacle.z);
    if (debrisRef.current) { debrisRef.current.visible = obstacle.kind === "debris"; debrisRef.current.rotation.y += delta * 1.4; debrisRef.current.rotation.x += delta * 0.7 }
    if (iceRef.current) { iceRef.current.visible = obstacle.kind === "ice"; iceRef.current.rotation.y += delta * 0.5 }
    if (riftGroup.current) { riftGroup.current.visible = obstacle.kind === "rift"; riftGroup.current.rotation.z += delta * 0.9 }
  });

  return (
    <group ref={group}>
      <group ref={debrisRef} scale={0.85}>
        <primitive object={debrisModel} />
      </group>
      <group ref={iceRef} scale={0.9}>
        <primitive object={iceModel} />
        <pointLight color="#8fe4ff" intensity={1.2} distance={4} />
      </group>
      <group ref={riftGroup}>
        <mesh rotation-x={Math.PI / 2}>
          <torusGeometry args={[1.1, 0.22, 10, 24]} />
          <meshStandardMaterial color="#173a5e" emissive="#4fb3ff" emissiveIntensity={1.6} />
        </mesh>
        <pointLight color="#4fb3ff" intensity={3.5} distance={6} />
      </group>
    </group>
  );
}
useGLTF.preload(assetUrl("models/debris.glb"));
useGLTF.preload(assetUrl("models/ice-crystal.glb"));

function AnomalyGlow() {
  const halo = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, "rgba(200,230,255,0.95)"); g.addColorStop(0.35, "rgba(120,180,255,0.4)"); g.addColorStop(1, "rgba(20,40,90,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(canvas);
  }, []);
  return (
    <group position={[10, 6, -FAR_Z * 1.6]}>
      <mesh>
        <sphereGeometry args={[2.2, 24, 24]} />
        <meshBasicMaterial color="#eaf6ff" toneMapped={false} />
      </mesh>
      <sprite scale={[26, 26, 1]}>
        <spriteMaterial map={halo} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
    </group>
  );
}

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

export function EscapeScene({ game, onEnded }: { game: MutableRefObject<EscapeState>; onEnded: () => void }) {
  const milkyWay = useLoader(THREE.TextureLoader, assetUrl("textures/skybox/milkyway.jpg"));
  milkyWay.colorSpace = THREE.SRGBColorSpace;

  useFrame(() => {
    const { justEnded } = tickEscape(game.current);
    if (justEnded) onEnded();
  });

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 8, 4]} intensity={2.4} color="#fff3e0" />
      <directionalLight position={[-5, -3, 6]} intensity={0.6} color="#8fb8ff" />
      <mesh scale={[-1, 1, 1]}>
        <sphereGeometry args={[300, 32, 24]} />
        <meshBasicMaterial map={milkyWay} side={THREE.BackSide} depthWrite={false} />
      </mesh>
      <Stars radius={200} depth={50} count={3000} factor={2.5} saturation={0} fade speed={0.3} />
      <AnomalyGlow />
      <Ship game={game} />
      <ExhaustTrail game={game} />
      {Array.from({ length: MAX_OBSTACLES }, (_, i) => (
        <ObstacleSlot key={i} index={i} game={game} />
      ))}
      <ChaseCamera game={game} />
      <EffectComposer>
        <Bloom intensity={0.7} luminanceThreshold={0.35} luminanceSmoothing={0.2} mipmapBlur radius={0.6} />
      </EffectComposer>
    </>
  );
}
