import { useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { damp, dampAngle } from "maath/easing";
import { bodyPosition, type CameraState } from "./cameraState";

const ELEVATION = 0.34; // Fixed 3/4-view tilt; not gesture-controlled, keeps navigation to azimuth + zoom only.
const ORIGIN = new THREE.Vector3(0, 0, 0);

export function CameraController({ camera }: { camera: MutableRefObject<CameraState> }) {
  const { camera: threeCamera } = useThree();
  const focusWorld = useRef(new THREE.Vector3(0, 0, 0));

  useFrame(({ clock }, delta) => {
    const state = camera.current;
    state.tier = state.targetTier;
    state.focusIndex = state.targetFocusIndex;

    const desiredFocus = state.tier === "galaxy" || state.focusIndex < 0 ? ORIGIN : bodyPosition(state.focusIndex, clock.elapsedTime);
    damp(focusWorld.current, "x", desiredFocus.x, 0.9, delta);
    damp(focusWorld.current, "y", desiredFocus.y, 0.9, delta);
    damp(focusWorld.current, "z", desiredFocus.z, 0.9, delta);

    dampAngle(state, "azimuth", state.targetAzimuth, 0.5, delta);
    damp(state, "radius", state.targetRadius, 0.7, delta);

    const cosEl = Math.cos(ELEVATION);
    threeCamera.position.set(
      focusWorld.current.x + Math.cos(state.azimuth) * state.radius * cosEl,
      focusWorld.current.y + Math.sin(ELEVATION) * state.radius,
      focusWorld.current.z + Math.sin(state.azimuth) * state.radius * cosEl,
    );
    threeCamera.lookAt(focusWorld.current);
  });

  return null;
}
