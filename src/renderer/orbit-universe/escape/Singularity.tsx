import { useMemo, useRef } from "react";
import { extend, useFrame, useThree, type ThreeElement } from "@react-three/fiber";
import { shaderMaterial } from "@react-three/drei";
import { Effect, BlendFunction } from "postprocessing";
import * as THREE from "three";
import { Uniform, Vector3, Vector2 } from "three";

const SINGULARITY_POSITION = new Vector3(10, 6, -74);

const DiskMaterial = shaderMaterial(
  { uTime: 0, uColorA: new THREE.Color("#eaf6ff"), uColorB: new THREE.Color("#4fb3ff") },
  /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  /* glsl */ `
    uniform float uTime;
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    varying vec2 vUv;

    float hash(float n) { return fract(sin(n) * 43758.5453123); }

    void main() {
      float angle = atan(vUv.y - 0.5, vUv.x - 0.5);
      float radius = length(vUv - 0.5) * 2.0;
      float swirl = angle * 2.0 + uTime * 1.6 - radius * 6.0;
      float bands = hash(floor(swirl * 3.0)) * 0.5 + 0.5;
      float edgeFade = smoothstep(1.0, 0.35, radius) * smoothstep(0.2, 0.45, radius);
      vec3 color = mix(uColorB, uColorA, bands);
      gl_FragColor = vec4(color, edgeFade * (0.55 + bands * 0.45));
    }
  `,
);

extend({ DiskMaterial });
declare module "@react-three/fiber" {
  interface ThreeElements {
    diskMaterial: ThreeElement<typeof DiskMaterial>;
  }
}

const LENS_FRAGMENT_SHADER = /* glsl */ `
  uniform vec2 uCenter;
  uniform float uRadius;
  uniform float uStrength;

  void mainUv(inout vec2 uv) {
    vec2 toCenter = uv - uCenter;
    float dist = length(toCenter);
    float falloff = smoothstep(uRadius, 0.0, dist);
    float warp = falloff * falloff * falloff * uStrength;
    uv -= normalize(toCenter + 0.0001) * warp;
  }
`;

class GravitationalLensEffect extends Effect {
  constructor() {
    super("GravitationalLensEffect", LENS_FRAGMENT_SHADER, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, InstanceType<typeof Uniform>>([
        ["uCenter", new Uniform(new Vector2(0.5, 0.5))],
        ["uRadius", new Uniform(0.05)],
        ["uStrength", new Uniform(0.016)],
      ]),
    });
  }
}

export function useGravitationalLens() {
  return useMemo(() => new GravitationalLensEffect(), []);
}

export function GravitationalLens({ effect }: { effect: GravitationalLensEffect }) {
  const { camera } = useThree();
  const projected = useMemo(() => new Vector3(), []);
  useFrame(() => {
    projected.copy(SINGULARITY_POSITION).project(camera);
    const center = effect.uniforms.get("uCenter");
    const radius = effect.uniforms.get("uRadius");
    if (!center || !radius) return;
    if (projected.z > 1) {
      radius.value = 0;
      return;
    }
    center.value.set(projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5);
    const distanceFade = THREE.MathUtils.clamp(1 - projected.z, 0, 1);
    radius.value = 0.05 * distanceFade;
  });
  return null;
}

export function Singularity() {
  const disk = useRef<InstanceType<typeof DiskMaterial>>(null);
  const horizon = useRef<THREE.Mesh>(null);

  useFrame(({ clock }, delta) => {
    if (disk.current) disk.current.uTime = clock.elapsedTime;
    if (horizon.current) horizon.current.rotation.y += delta * 0.05;
  });

  return (
    <group position={SINGULARITY_POSITION.toArray()}>
      <mesh ref={horizon}>
        <sphereGeometry args={[2.1, 32, 32]} />
        <meshBasicMaterial color="#020204" />
      </mesh>
      <mesh rotation-x={Math.PI / 2.4}>
        <ringGeometry args={[2.3, 5.2, 64]} />
        <diskMaterial ref={disk} transparent depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      <pointLight color="#8fd6ff" intensity={5} distance={16} />
    </group>
  );
}
