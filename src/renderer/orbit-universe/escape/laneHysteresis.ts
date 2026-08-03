export type Lane = -1 | 0 | 1;

const LEFT_ENTER = 0.38;
const LEFT_EXIT = 0.44;
const RIGHT_ENTER = 0.62;
const RIGHT_EXIT = 0.56;

/**
 * Hysteresis band around the palm-x -> lane mapping. Entering a side lane from center requires
 * crossing the outer threshold (0.38 / 0.62), but LEAVING a side lane requires crossing back
 * past a looser inner threshold (0.44 / 0.56). Without this gap, a hand resting near a lane
 * boundary flickers the ship between lanes every frame.
 */
export function nextHandLane(currentLane: Lane, palmX: number): Lane {
  if (currentLane === -1) {
    if (palmX > RIGHT_ENTER) return 1;
    if (palmX > LEFT_EXIT) return 0;
    return -1;
  }
  if (currentLane === 1) {
    if (palmX < LEFT_ENTER) return -1;
    if (palmX < RIGHT_EXIT) return 0;
    return 1;
  }
  if (palmX < LEFT_ENTER) return -1;
  if (palmX > RIGHT_ENTER) return 1;
  return 0;
}
