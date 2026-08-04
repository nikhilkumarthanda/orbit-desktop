import React, { useEffect, useRef, useState } from "react";
import type { NormalizedLandmark, Results } from "@mediapipe/hands";
import type { OrbitPlayMode } from "../shared/contracts";
import "./orbit-play.css";
import { OrbitUniverse } from "./orbit-universe/OrbitUniverse";
import { createCameraState, nextNavStep, radiusRangeFor, stepsToOrbit, type CameraState } from "./orbit-universe/cameraState";
import { ALL_BODIES, ORBIT_INDEX } from "./orbit-universe/planets";
import { OrbitEscapeGame } from "./orbit-universe/escape/OrbitEscapeGame";
import { createEscapeState, steerEscape as steerEscapeState, dashEscape as dashEscapeState, type EscapeState } from "./orbit-universe/escape/escapeState";
import { nextHandLane, type Lane } from "./orbit-universe/escape/laneHysteresis";
import { LocalScoreService } from "./orbit-universe/escape/localScoreService";
import { SupabaseScoreService } from "./orbit-universe/escape/supabaseScoreService";
import type { ScoreService } from "./orbit-universe/escape/scoreService";
import { GestureStabilizer, HAND_CONNECTIONS, type HandState, type Point } from "./orbit-universe/gestures/gestureStateMachine";
import { createGauntletState, updateGauntlet, type GauntletState } from "./energy-gauntlet/gauntletState";
import { drawGauntlet } from "./energy-gauntlet/drawGauntlet";
import { ensureAudioContext, playPowerDownSequence, playProjectileZap, playSuitUpSequence } from "./energy-gauntlet/gauntletAudio";

type PlayScene = "energy"|"system";
type NavGestureState = { lastAngle:number;lastMidpoint:Point|null;trackedHands:number;pinchActive:boolean;pinchStartY:number;pinchStartTime:number;lastPinchY:number };
type HandsTracker = { setOptions(options:Record<string,unknown>):void;onResults(callback:(results:Results)=>void):void;send(input:{image:HTMLVideoElement}):Promise<void>;close():Promise<void> };
declare global { interface Window { Hands: new(options:{locateFile:(file:string)=>string})=>HandsTracker } }

let handsScript:Promise<void>|null=null;
const mediaPipeAsset=(file:string)=>new URL(`./mediapipe/hands/${file}`,document.baseURI).href;
const loadHands=()=>handsScript??=new Promise((resolve,reject)=>{if(window.Hands)return resolve();const script=document.createElement("script");script.src=mediaPipeAsset("hands.js");script.onload=()=>resolve();script.onerror=()=>reject(new Error("Orbit Play hand model could not load"));document.head.append(script)});
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

export function OrbitPlay(){
  const root=useRef<HTMLDivElement>(null),video=useRef<HTMLVideoElement>(null),overlay=useRef<HTMLCanvasElement>(null),world=useRef<HTMLCanvasElement>(null);
  const stream=useRef<MediaStream|null>(null),tracker=useRef<HandsTracker|null>(null),raf=useRef(0),processing=useRef(false),handsNow=useRef<HandState[]>([]);
  const pinching=useRef(false),lastScrollY=useRef(.5),fistSince=useRef(0),lastClick=useRef(0),phase=useRef(0),lastGestureUpdate=useRef(0),lastGauntletTick=useRef(0);
  const lastHandPinchForDash=useRef(false),lastHandSeenAt=useRef(0),gestureDebugOn=useRef(false);
  const [gestureDebugEnabled,setGestureDebugEnabled]=useState(false),[gestureDebugText,setGestureDebugText]=useState("");
  const toggleGestureDebug=()=>{gestureDebugOn.current=!gestureDebugOn.current;setGestureDebugEnabled(gestureDebugOn.current);if(!gestureDebugOn.current)setGestureDebugText("")};
  const gauntlet=useRef<GauntletState>(createGauntletState());
  const camera=useRef<CameraState>(createCameraState());
  const nav=useRef<NavGestureState>({lastAngle:0,lastMidpoint:null,trackedHands:0,pinchActive:false,pinchStartY:0,pinchStartTime:0,lastPinchY:0});
  const escape=useRef<EscapeState>(createEscapeState());
  const escapeNow=useRef(false);
  // Lazy-initialized (not useRef(new SupabaseScoreService())): that form constructs a fresh
  // instance on every render (React only keeps the first, but still evaluates and discards the
  // rest), and this constructor has a real side effect -- it fires a network sign-in request --
  // so a naive useRef would spawn a new anonymous-auth attempt on every re-render.
  const scoreService=useRef<ScoreService>(null!);
  if(scoreService.current===null)scoreService.current=new SupabaseScoreService();
  const [postRunResult,setPostRunResult]=useState<{score:number;rank?:number}|null>(null);
  const startingEscape=useRef(false);
  const stabilizers=useRef<[GestureStabilizer,GestureStabilizer]>([new GestureStabilizer(),new GestureStabilizer()]);
  const sceneNow=useRef<PlayScene>("system");
  const [active,setActive]=useState(false),[mode,setMode]=useState<OrbitPlayMode>("playground"),[gesture,setGesture]=useState("Waiting for hands"),[message,setMessage]=useState("Camera off · all tracking is local"),[immersive,setImmersive]=useState(false),[effect,setEffect]=useState("IDLE");
  const [scene,setScene]=useState<PlayScene>("system");
  const [orbitReady,setOrbitReady]=useState(false),[escapeActive,setEscapeActiveState]=useState(false);
  const [cameraVisible,setCameraVisible]=useState(false);

  const setEscapeActive=(value:boolean)=>{escapeNow.current=value;setEscapeActiveState(value)};
  const escapeInputActive=()=>escapeNow.current;

  const handleEscapeEnd=()=>{
    setEffect("RUN ENDED");setMessage("Press Enter or click Play Again · beat your best");
    const g=escape.current;
    if(g.runId){
      const runId=g.runId,finalScore=Math.floor(g.score),durationMs=Date.now()-g.startedAt;
      void scoreService.current.finishRun(runId,finalScore,durationMs).then(result=>setPostRunResult({score:finalScore,rank:result.rank}));
    }
  };
  const startEscape=async()=>{
    // Re-entrancy guard: a keyboard Enter and a button click can both fire startEscape for the
    // same user action (e.g. Enter-activating a still-focused button), which previously raced
    // two simultaneous start-run calls against each other.
    if(startingEscape.current)return;
    startingEscape.current=true;
    try{
      setPostRunResult(null);
      let result;
      try{
        result=await scoreService.current.startRun();
      }catch(err){
        console.warn("Online scoring unavailable, falling back to local:",err);
        scoreService.current=new LocalScoreService();
        result=await scoreService.current.startRun();
      }
      const {runId,seed}=result;
      escape.current=createEscapeState(seed);
      escape.current.running=true;
      escape.current.runId=runId;
      escape.current.startedAt=Date.now();
      setEffect("ORBIT ESCAPE");setGesture("Run started");setMessage("Steer with A/D or your hand · Space to phase dash");
    } finally {
      startingEscape.current=false;
    }
  };
  const steerEscape=(direction:-1|1)=>steerEscapeState(escape.current,direction);
  const dashEscape=()=>{if(dashEscapeState(escape.current))setEffect("PHASE DASH")};

  const chooseScene=(next:PlayScene)=>{
    sceneNow.current=next;setScene(next);setEffect(next==="system"?"SOLAR SYSTEM":"ENERGY STABLE");
    if(next==="energy")setCameraVisible(true);
    const g=escape.current;
    if(g.running&&g.runId)void scoreService.current.abandonRun(g.runId);
    g.running=false;
    setEscapeActive(false);
    setMessage(next==="system"?"Rotate with both hands · pinch and drag up/down to zoom · quick pinch to travel":"Pull with two pinches, then clap to burst");
  };

  const stop=async()=>{
    cancelAnimationFrame(raf.current);stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;
    await tracker.current?.close();tracker.current=null;pinching.current=false;processing.current=false;handsNow.current=[];
    await window.orbit.orbitPlayStop();setActive(false);setGesture("Waiting for hands");setEffect("IDLE");setMessage("Camera off · all tracking is local");
    if(document.fullscreenElement===root.current)await document.exitFullscreen().catch(()=>undefined);
  };
  const toggleImmersive=async()=>{
    if(!document.fullscreenElement){await root.current?.requestFullscreen();setImmersive(true)}
    else{await document.exitFullscreen();setImmersive(false)}
  };
  const updateGauntletScene=(hands:HandState[])=>{
    const now=performance.now();
    const deltaMs=lastGauntletTick.current?clamp(now-lastGauntletTick.current,0,80):16;
    lastGauntletTick.current=now;
    const event=updateGauntlet(gauntlet.current,hands,now,deltaMs);
    if(event==="suiting-up"){playSuitUpSequence();setEffect("SUIT ENGAGED");setMessage("Plates assembling…")}
    else if(event==="suited"){setEffect("GAUNTLET READY");setMessage("Open your palm to fire · close and hold your fist 3s to release the gauntlet")}
    else if(event==="powering-down"){playPowerDownSequence();setEffect("POWERING DOWN");setMessage("Returning to energy field…")}
    else if(event==="ball"){setEffect("ENERGY STABLE");setMessage("Pull with two pinches, then clap to burst")}
    else if(event==="burst"){setEffect("SUPERNOVA");setMessage("Clap burst · energy field reforming");window.setTimeout(()=>setEffect("REFORMING"),650);window.setTimeout(()=>setEffect("ENERGY STABLE"),1900)}
    else if(event==="projectile")playProjectileZap();
  };

  const advanceFocus=()=>{
    const step=nextNavStep(camera.current.tier,camera.current.focusIndex);
    camera.current.targetTier=step.tier;camera.current.targetFocusIndex=step.focusIndex;camera.current.targetRadius=step.radius;
    const name=step.focusIndex===-1?(step.tier==="galaxy"?"the Milky Way":"the solar system"):ALL_BODIES[step.focusIndex].name;
    const remaining=stepsToOrbit(step.tier,step.focusIndex);
    setEffect(step.tier==="galaxy"?"GALACTIC VIEW":step.tier==="system"?"SYSTEM OVERVIEW":`${name.toUpperCase()} APPROACH`);
    setGesture(`Pinch · traveling to ${name}`);
    setMessage(step.focusIndex===ORBIT_INDEX?"Arrived at Orbit — hold steady, then press Play.":`${remaining} more ${remaining===1?"pinch":"pinches"} to reach Orbit · pinch+drag up/down to zoom`);
  };
  const ZOOM_TAP_MAX_MS=350,ZOOM_TAP_MAX_DRAG=.03,ZOOM_DEAD_ZONE=.006,ZOOM_SENSITIVITY=1.1;
  const updateCamera=(hands:HandState[])=>{
    const state=camera.current,gestureState=nav.current;
    const bothOpen=hands.length===2&&hands.every(hand=>hand.gesture==="Open palm");
    if(bothOpen){
      const ordered=[...hands].sort((a,b)=>a.palm.x-b.palm.x);
      const dx=ordered[1].palm.x-ordered[0].palm.x,dy=ordered[1].palm.y-ordered[0].palm.y,angle=Math.atan2(dy,dx);
      if(gestureState.trackedHands===2){
        let angleDelta=angle-gestureState.lastAngle;while(angleDelta>Math.PI)angleDelta-=Math.PI*2;while(angleDelta<-Math.PI)angleDelta+=Math.PI*2;
        if(Math.abs(angleDelta)>.008){state.targetAzimuth+=angleDelta*1.15;setEffect(angleDelta>0?"ROTATING CLOCKWISE":"ROTATING COUNTERCLOCKWISE");setGesture("Two palms · rotating view")}
      }
      gestureState.lastAngle=angle;gestureState.trackedHands=2;gestureState.pinchActive=false;
      return;
    }
    if(hands.length===0){gestureState.trackedHands=0;gestureState.pinchActive=false;return}
    const hand=hands[0];
    if(hand.pinching){
      if(!gestureState.pinchActive){
        gestureState.pinchActive=true;gestureState.pinchStartY=hand.palm.y;gestureState.pinchStartTime=performance.now();gestureState.lastPinchY=hand.palm.y;
      }else{
        const dragDelta=hand.palm.y-gestureState.lastPinchY;
        if(Math.abs(dragDelta)>ZOOM_DEAD_ZONE){
          const [min,max]=radiusRangeFor(state.tier,state.focusIndex);
          state.targetRadius=clamp(state.targetRadius+dragDelta*(max-min)*ZOOM_SENSITIVITY,min,max);
          setEffect(dragDelta<0?"ZOOMING IN":"ZOOMING OUT");setGesture(`Pinch · ${Math.round((1-(state.targetRadius-min)/(max-min))*100)}% in`);
        }
        gestureState.lastPinchY=hand.palm.y;
      }
    }else{
      if(gestureState.pinchActive){
        const heldMs=performance.now()-gestureState.pinchStartTime;
        const totalDrag=Math.abs(gestureState.lastPinchY-gestureState.pinchStartY);
        if(heldMs<ZOOM_TAP_MAX_MS&&totalDrag<ZOOM_TAP_MAX_DRAG)advanceFocus();
        gestureState.pinchActive=false;
      }
      if(gestureState.trackedHands===1&&gestureState.lastMidpoint&&hand.gesture==="Open palm"){
        const dragX=hand.palm.x-gestureState.lastMidpoint.x;
        if(Math.abs(dragX)>.004){state.targetAzimuth+=dragX*2.6;setEffect("PANNING VIEW");setGesture("Open palm · dragging view")}
      }
    }
    gestureState.lastMidpoint=hand.palm;gestureState.trackedHands=1;
  };

  const drawWorld=()=>{
    const canvas=world.current;if(!canvas)return;const box=canvas.getBoundingClientRect(),ratio=devicePixelRatio;
    if(canvas.width!==Math.floor(box.width*ratio)||canvas.height!==Math.floor(box.height*ratio)){canvas.width=Math.floor(box.width*ratio);canvas.height=Math.floor(box.height*ratio)}
    const ctx=canvas.getContext("2d")!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,box.width,box.height);
    phase.current+=.013;
    if(sceneNow.current==="system")return; // rendered by the 3D <OrbitUniverse> canvas
    drawGauntlet(ctx,box.width,box.height,gauntlet.current,handsNow.current,phase.current,performance.now(),cameraVisible);
  };
  const onResults=(results:Results)=>{
    processing.current=false;const canvas=overlay.current;if(!canvas)return;
    const box=canvas.getBoundingClientRect(),ratio=devicePixelRatio;canvas.width=box.width*ratio;canvas.height=box.height*ratio;
    const ctx=canvas.getContext("2d")!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,box.width,box.height);
    const landmarks=(results.multiHandLandmarks??[]).slice(0,2);
    if(landmarks.length){
      const pool=stabilizers.current,slotUsed=[false,false],timestamp=performance.now();
      const detected=landmarks.map(lm=>{
        const rawPalmX=(lm[0].x+lm[5].x+lm[9].x+lm[13].x+lm[17].x)/5;
        let slot=-1,best=Infinity;
        pool.forEach((s,i)=>{if(!slotUsed[i]){const d=Math.abs(s.lastPalm.x-rawPalmX);if(d<best){best=d;slot=i}}});
        if(slot===-1)slot=slotUsed[0]?1:0;
        slotUsed[slot]=true;
        return pool[slot].update(lm,timestamp);
      });
      handsNow.current=detected;
      lastHandSeenAt.current=performance.now();
      if(escapeNow.current&&escape.current.running){
        const hand=detected[0];
        if(hand){
          escape.current.targetLane=nextHandLane(escape.current.targetLane as Lane,hand.palm.x);
          if(hand.pinching&&!lastHandPinchForDash.current)dashEscape();
          lastHandPinchForDash.current=hand.pinching;
        }
      }else if(sceneNow.current==="energy")updateGauntletScene(detected);
      else updateCamera(detected);
      if(performance.now()-lastGestureUpdate.current>120){
        lastGestureUpdate.current=performance.now();
        setGesture(`${detected.length} hand${detected.length>1?"s":""} · ${detected.map(hand=>hand.gesture).join(" + ")}`);
        if(gestureDebugOn.current){
          setGestureDebugText(detected.map((hand,i)=>`H${i} raw=${hand.gesture} x=${hand.palm.x.toFixed(2)} pinch=${hand.pinching}`).join("  ·  ")+(escapeNow.current?`  ·  lane=${escape.current.targetLane}`:""));
        }
      }
    }else if(performance.now()-gauntlet.current.ball.lastSeen>260){
      handsNow.current=[];setGesture("Tracking hands…");
      // Short tracking-loss tolerance: a blip under ~250ms keeps the last commanded lane/dash
      // state as-is (nothing here resets it). Beyond that, a genuinely lost hand shouldn't
      // leave the ship committed to a stale lane forever, so it eases back to center.
      if(escapeNow.current&&escape.current.running&&performance.now()-lastHandSeenAt.current>250){
        escape.current.targetLane=0;
      }
    }
    handsNow.current.forEach((hand,handIndex)=>{
      ctx.strokeStyle=handIndex?"rgba(255,183,94,.64)":"rgba(99,235,255,.64)";ctx.lineWidth=1.7;
      HAND_CONNECTIONS.forEach(([a,b])=>{ctx.beginPath();ctx.moveTo(hand.landmarks[a].x*box.width,hand.landmarks[a].y*box.height);ctx.lineTo(hand.landmarks[b].x*box.width,hand.landmarks[b].y*box.height);ctx.stroke()});
      hand.landmarks.forEach((p,i)=>{ctx.beginPath();ctx.fillStyle=i===8?"#fff2ba":handIndex?"#ffad62":"#73efff";ctx.arc(p.x*box.width,p.y*box.height,i===8?4.5:2.2,0,Math.PI*2);ctx.fill()});
    });
    const deliberateStop=handsNow.current.length===2&&handsNow.current.every(hand=>hand.gesture==="Fist");
    if(deliberateStop){if(!fistSince.current)fistSince.current=Date.now();if(Date.now()-fistSince.current>2000){setMessage("Two-hand emergency stop detected");void stop();return}}else fistSince.current=0;
    const primary=handsNow.current[0];
    if(mode==="desktop"&&primary){
      if(["Point","Pinch","Drag"].includes(primary.gesture))void window.orbit.orbitPlayAction({action:"move",x:primary.point.x,y:primary.point.y});
      const nowPinching=primary.pinching;
      if(nowPinching&&!pinching.current&&Date.now()-lastClick.current>350){pinching.current=true;lastClick.current=Date.now();void window.orbit.orbitPlayAction({action:"down",x:primary.point.x,y:primary.point.y})}
      if(!nowPinching&&pinching.current){pinching.current=false;void window.orbit.orbitPlayAction({action:"up",x:primary.point.x,y:primary.point.y})}
      if(primary.gesture==="Scroll"){const delta=(lastScrollY.current-primary.landmarks[8].y)*900;lastScrollY.current=primary.landmarks[8].y;if(Math.abs(delta)>2)void window.orbit.orbitPlayAction({action:"scroll",deltaY:delta})}else lastScrollY.current=primary.landmarks[8].y;
    }
  };
  const start=async()=>{
    try{
      ensureAudioContext();
      if(!document.fullscreenElement)await root.current?.requestFullscreen();
      setMessage("Requesting camera permission…");
      stream.current=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:1280},height:{ideal:720}},audio:false});
      if(!video.current)return;video.current.srcObject=stream.current;await video.current.play();
      await loadHands();const hands=new window.Hands({locateFile:mediaPipeAsset});tracker.current=hands;
      hands.setOptions({selfieMode:true,maxNumHands:2,modelComplexity:1,minDetectionConfidence:.62,minTrackingConfidence:.62});hands.onResults(onResults);
      const status=await window.orbit.orbitPlayStart(mode);if(!status.supported)throw new Error(status.message);
      setActive(true);setEffect(sceneNow.current==="system"?"SOLAR SYSTEM":"ENERGY STABLE");setMessage(mode==="desktop"?"Desktop control active · press Esc or hold both fists to stop":sceneNow.current==="system"?"Rotate with both hands · pinch and drag up/down to zoom · quick pinch to travel":"Pull with two pinches, then clap to burst");
      const loop=async()=>{drawWorld();if(video.current&&tracker.current&&!processing.current&&video.current.readyState>=2){processing.current=true;try{await tracker.current.send({image:video.current})}catch{processing.current=false}}raf.current=requestAnimationFrame(loop)};void loop();
    }catch(error){await stop();setMessage(error instanceof Error?error.message:"Camera permission was denied")}
  };
  useEffect(()=>{const changed=()=>setImmersive(Boolean(document.fullscreenElement));const keydown=(event:KeyboardEvent)=>{if(event.key==="Escape"&&stream.current){void stop();return}if(escapeInputActive()){if(event.key==="ArrowLeft"||event.key.toLowerCase()==="a")steerEscape(-1);if(event.key==="ArrowRight"||event.key.toLowerCase()==="d")steerEscape(1);if(event.code==="Space"){event.preventDefault();dashEscape()}if(event.key==="Enter")void startEscape()}};document.addEventListener("fullscreenchange",changed);document.addEventListener("keydown",keydown);drawWorld();return()=>{document.removeEventListener("fullscreenchange",changed);document.removeEventListener("keydown",keydown);void stop()}},[]);
  useEffect(()=>{
    if(!escapeActive)return;
    const id=window.setInterval(()=>{
      const g=escape.current;
      if(g.running&&g.runId)void scoreService.current.submitCheckpoint(g.runId,Math.floor(g.score),g.distance);
    },1200);
    return()=>window.clearInterval(id);
  },[escapeActive]);

  return <div ref={root} className={`orbit-play ${active?"is-active":""} ${effect==="SUPERNOVA"?"is-bursting":""}`}>
    <canvas className="energy-world" ref={world}/>
    {scene==="system"&&!escapeActive&&<OrbitUniverse camera={camera} onOrbitReadyChange={setOrbitReady}/>}
    {escapeActive&&<OrbitEscapeGame game={escape} onEnded={handleEscapeEnd} scoreService={scoreService.current} postRunResult={postRunResult} onRestart={startEscape}/>}
    <video ref={video} muted playsInline aria-hidden="true" className={cameraVisible&&scene==="energy"?"camera-visible":""}/>
    <canvas className="hand-overlay" ref={overlay}/>
    <header><div><small>ORBIT PLAY · REAL SOLAR SYSTEM</small><h1>{scene==="system"?"A real universe in your hands.":"Shape the impossible."}</h1><p>{scene==="system"?"Fly from the Milky Way down to every real planet, and find Orbit at the edge of the system.":"Move the field. Rotate both hands. Pinch and pull, then clap to release."}</p></div><span className={active?"camera-live":""}>● {active?"CAMERA ACTIVE · LOCAL ONLY":"CAMERA OFF"}</span></header>
    <div className="play-controls">
      <div className="scene-switch"><button className={scene==="system"?"selected":""} onClick={()=>chooseScene("system")}>Solar system</button><button className={scene==="energy"?"selected":""} onClick={()=>chooseScene("energy")}>Energy lab</button></div>
      <div className="mode-switch"><button className={mode==="playground"?"selected":""} disabled={active} onClick={()=>setMode("playground")}>Play</button><button className={mode==="desktop"?"selected":""} disabled={active} onClick={()=>setMode("desktop")}>Desktop</button></div>
      {active?<button className="play-stop" onClick={()=>void stop()}>Stop</button>:<button className="play-start" onClick={()=>void start()}>Enter Orbit Play</button>}
      {scene==="system"&&orbitReady&&!escapeActive&&<button className="escape-start" onClick={()=>{setEscapeActive(true);void startEscape()}}>Play Orbit Escape</button>}
      {escapeActive&&<button className="play-stop" onClick={()=>{const g=escape.current;if(g.running&&g.runId)void scoreService.current.abandonRun(g.runId);g.running=false;setEscapeActive(false)}}>Exit Escape</button>}
      {scene==="energy"&&<button className="play-immersive" onClick={()=>setCameraVisible(v=>!v)}>{cameraVisible?"Hide camera":"Show camera"}</button>}
      <button className="play-immersive" onClick={()=>void toggleImmersive()}>{immersive?"Exit full screen":"Full screen"}</button>
    </div>
    <div className="gesture-readout">
      <small>{effect}</small><b>{gesture}</b><span>{message}</span>
      <button type="button" className="gesture-debug-toggle" onClick={toggleGestureDebug}>{gestureDebugEnabled?"Hide gesture debug":"Show gesture debug"}</button>
      {gestureDebugEnabled&&<code className="gesture-debug">{gestureDebugText||"…"}</code>}
    </div>
    <div className="play-hint">{escapeActive?<><span>A / D OR HAND TO STEER</span><i/><span>SPACE OR PINCH TO DASH</span></>:scene==="energy"?(effect==="GAUNTLET READY"?<><span>OPEN PALM TO FIRE</span><i/><span>HOLD FIST 3S TO RELEASE</span></>:effect==="SUIT ENGAGED"||effect==="POWERING DOWN"?<><span>{effect}…</span></>:<><span>OPEN PALM · ENERGY FOLLOWS</span><i/><span>CLOSE FIST TO SUIT UP</span><i/><span>PINCH + PULL TO SHAPE</span></>):<><span>ROTATE VIEW</span><i/><span>PINCH + DRAG UP/DOWN TO ZOOM</span><i/><span>QUICK PINCH TO ADVANCE</span></>}</div>
    <aside className="play-safety"><b>LOCAL CAMERA</b><span>Energy Lab mirrors your live camera while hand landmarks are processed locally. Frames are never recorded or uploaded. Press Esc or hold both fists for 2 seconds to stop.</span></aside>
  </div>;
}
