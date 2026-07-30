export type PlanetKind = "rock" | "ocean" | "gas" | "ice" | "orbit";

export interface PlanetDef {
  name: string;
  kind: PlanetKind;
  auReal: number;
  kmReal: number;
  orbitDistance: number;
  radius: number;
  orbitSpeed: number;
  spinSpeed: number;
  tilt: number;
  day?: string;
  night?: string;
  clouds?: string;
  ring?: { texture: string; innerScale: number; outerScale: number; tint: string };
  fictional?: boolean;
}

const SCALE_DIST = 6;
const SCALE_RADIUS = 0.45;
const BASE_ORBIT_SPEED = 0.42;

// Sub-linear compression keeps real relative order/size ranking legible while
// staying navigable (Neptune isn't 30x further out than Mercury on screen).
const compressDistance = (au: number) => au ** 0.55 * SCALE_DIST;
const compressRadius = (km: number) => (km / 6371) ** 0.42 * SCALE_RADIUS;
// Kepler-ish ordering (inner planets visibly faster) without real-time periods.
const compressOrbitSpeed = (au: number) => BASE_ORBIT_SPEED / au ** 1.5;

export const SUN_RADIUS = 1.8; // Fixed, independent of the size formula so the Sun doesn't swallow Mercury's compressed orbit.

const real = (name: string, kind: PlanetKind, auReal: number, kmReal: number, spinSpeed: number, tilt: number, textures: Pick<PlanetDef, "day" | "night" | "clouds" | "ring">) => ({
  name, kind, auReal, kmReal,
  orbitDistance: compressDistance(auReal),
  radius: compressRadius(kmReal),
  orbitSpeed: compressOrbitSpeed(auReal),
  spinSpeed, tilt,
  ...textures,
});

export const PLANETS: PlanetDef[] = [
  real("Mercury", "rock", 0.39, 2440, 0.6, 0.001, { day: "textures/planets/mercury.jpg" }),
  real("Venus", "rock", 0.72, 6052, 0.15, 3.096, { day: "textures/planets/venus-atmosphere.jpg" }),
  real("Earth", "ocean", 1.0, 6371, 1.0, 0.409, { day: "textures/planets/earth-day.jpg", night: "textures/planets/earth-night.jpg", clouds: "textures/planets/earth-clouds.jpg" }),
  real("Mars", "rock", 1.52, 3390, 0.97, 0.439, { day: "textures/planets/mars.jpg" }),
  real("Jupiter", "gas", 5.2, 69911, 2.4, 0.055, { day: "textures/planets/jupiter.jpg" }),
  real("Saturn", "gas", 9.58, 58232, 2.2, 0.467, {
    day: "textures/planets/saturn.jpg",
    // No dedicated Uranus ring asset exists in the free pack; Saturn's alpha map is reused with a
    // cooler tint for Uranus below to represent its real (much fainter) ring system.
    ring: { texture: "textures/planets/saturn-ring.png", innerScale: 1.3, outerScale: 2.3, tint: "#d8c9a8" },
  }),
  real("Uranus", "ice", 19.2, 25362, 1.4, 1.706, {
    day: "textures/planets/uranus.jpg",
    ring: { texture: "textures/planets/saturn-ring.png", innerScale: 1.5, outerScale: 1.9, tint: "#8fb6c9" },
  }),
  real("Neptune", "ice", 30.1, 24622, 1.5, 0.494, { day: "textures/planets/neptune.jpg" }),
];

export const ORBIT_INDEX = PLANETS.length; // The fictional "Orbit" world sits just past Neptune.

export const ORBIT_PLANET: PlanetDef = {
  name: "Orbit",
  kind: "orbit",
  auReal: 0,
  kmReal: 0,
  orbitDistance: PLANETS[PLANETS.length - 1].orbitDistance + 6,
  radius: 0.62,
  orbitSpeed: 0.05,
  spinSpeed: 0.3,
  tilt: 0.42,
  fictional: true,
};

export const ALL_BODIES: PlanetDef[] = [...PLANETS, ORBIT_PLANET];
