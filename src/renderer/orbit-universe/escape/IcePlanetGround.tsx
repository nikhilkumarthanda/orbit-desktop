import { useRef, type MutableRefObject } from "react";
import { extend, useFrame, type ThreeElement } from "@react-three/fiber";
import { shaderMaterial } from "@react-three/drei";
import * as THREE from "three";
import type { EscapeState } from "./escapeState";

const IceGroundMaterial = shaderMaterial(
  {
    uTime: 0,
    uScroll: 0,
    uCrackColor: new THREE.Color("#7fe0ff"),
    uBaseColorA: new THREE.Color("#0d1013"),
    uBaseColorB: new THREE.Color("#181c22"),
  },
  /* glsl */ `
    varying vec2 vWorld;
    void main() {
      vWorld = position.xz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  /* glsl */ `
    uniform float uTime;
    uniform float uScroll;
    uniform vec3 uCrackColor;
    uniform vec3 uBaseColorA;
    uniform vec3 uBaseColorB;
    varying vec2 vWorld;

    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return fract(sin(p) * 43758.5453123);
    }

    vec2 voronoi(vec2 p) {
      vec2 ip = floor(p);
      vec2 fp = fract(p);
      float f1 = 8.0, f2 = 8.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(float(i), float(j));
          vec2 o = hash2(ip + g);
          vec2 r = g + o - fp;
          float d = dot(r, r);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
      }
      return vec2(sqrt(f1), sqrt(f2));
    }

    void main() {
      // Local +Y is the far/deep end of the strip (see IcePlanetGround.tsx for the
      // world-space mapping). Cells elongated along depth (low Z frequency) put crack
      // boundaries mostly *along* depth too — exactly the "rail track" orientation that
      // radiates toward the horizon at this shallow chase-camera angle (a perspective
      // effect, not aliasing). Elongating the other way (low X frequency, higher Z
      // frequency) keeps boundaries mostly transverse instead, so they foreshorten into
      // fractured ice bands rather than radiating spokes.
      vec2 p = vec2(vWorld.x * 0.05, (vWorld.y + uScroll) * 0.16);
      vec2 f = voronoi(p);
      float edge = f.y - f.x;
      float aa = clamp(fwidth(edge) * 2.5, 0.015, 0.4);
      float crack = smoothstep(0.0, aa, edge);
      float cellId = fract(sin(dot(floor(p), vec2(41.3, 289.1))) * 4375.5453);
      vec3 base = mix(uBaseColorA, uBaseColorB, cellId);
      // Fixed-direction fake diffuse so fractured plates read with some depth without full PBR.
      float fakeDiffuse = 0.55 + 0.35 * cellId;
      base *= fakeDiffuse;
      vec3 color = mix(uCrackColor * 1.5, base, crack);
      float pulse = 0.5 + 0.5 * sin(uTime * 1.4 + cellId * 6.28);
      color += uCrackColor * (1.0 - crack) * pulse * 0.4;
      float depth = clamp((vWorld.y + 8.0) / 55.0, 0.0, 1.0);
      float fade = 1.0 - depth;
      gl_FragColor = vec4(color * fade, 1.0);
    }
  `,
);

extend({ IceGroundMaterial });
declare module "@react-three/fiber" {
  interface ThreeElements {
    iceGroundMaterial: ThreeElement<typeof IceGroundMaterial>;
  }
}

export function IcePlanetGround({ game }: { game: MutableRefObject<EscapeState> }) {
  const materialRef = useRef<InstanceType<typeof IceGroundMaterial>>(null);
  useFrame(({ clock }) => {
    if (materialRef.current) {
      materialRef.current.uTime = clock.elapsedTime;
      materialRef.current.uScroll = game.current.distance * 55;
    }
  });
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, -0.62, -20]}>
      <planeGeometry args={[60, 140, 1, 1]} />
      <iceGroundMaterial ref={materialRef} />
    </mesh>
  );
}
