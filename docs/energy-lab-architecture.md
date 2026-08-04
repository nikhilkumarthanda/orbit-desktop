# Energy Lab / Orbit Gauntlet architecture

Energy Lab is a camera-first augmented-reality experience. The live video remains local; MediaPipe produces only stabilized hand landmarks for the effect engine.

```mermaid
flowchart TB
    Camera["Mirrored Mac camera"] --> Tracker["Local MediaPipe Hands"]
    Tracker --> Stabilizer["One Euro filtering + gesture debounce"]
    Stabilizer --> Machine["Gauntlet state machine"]
    Machine --> Ball["Palm-following energy sphere"]
    Machine --> Armor["Original procedural armor plates"]
    Machine --> Blast["Palm blast + particles"]
    Machine --> Audio["Procedural servo + hydraulic audio"]
    Ball --> Composite["Camera + effects compositor"]
    Armor --> Composite
    Blast --> Composite
```

```mermaid
stateDiagram-v2
    [*] --> EnergyBall
    EnergyBall --> SuitingUp: deliberate fist
    SuitingUp --> Gauntlet: assembly completes
    Gauntlet --> PalmBlast: palm opens
    PalmBlast --> Gauntlet: blast emitted
    Gauntlet --> PoweringDown: fist held 3 seconds
    PoweringDown --> EnergyBall: armor retracts
```

## Safety and lifecycle

- Camera frames never leave the renderer and are not recorded or uploaded.
- No cloud inference or paid API is used.
- `Esc` and the existing two-fist emergency stop remain authoritative.
- Animation and camera tracks stop when Orbit Play exits.
- Film assets and sampled movie audio are not used; the gauntlet and sounds are original procedural work.

## Milestones

1. Reliable camera-first interaction and deterministic state transitions.
2. Palm-anchored energy sphere with depth-aware motion and occlusion.
3. 3D articulated gauntlet plates aligned to hand landmarks.
4. Charged palm blast, recoil, lighting, particles, and screen-space impact.
5. Performance profiling, visual regression coverage, and Mac hardware polish.
