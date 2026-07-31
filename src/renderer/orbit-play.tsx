import React, { useEffect, useRef, useState } from "react";
import type { NormalizedLandmark, Results } from "@mediapipe/hands";
import type { OrbitPlayMode } from "../shared/contracts";
import "./orbit-play.css";
import { OrbitUniverse } from "./orbit-universe/OrbitUniverse";
import { createCameraState, nextNavStep, radiusRangeFor, stepsToOrbit, type CameraState } from "./orbit-universe/cameraState";
import { ALL_BODIES, ORBIT_INDEX } from "./orbit-universe/planets";
import { OrbitEscapeGame } from "./orbit-universe/escape/OrbitEscapeGame";
import { createEscapeState, steerEscape as steerEscapeState, dashEscape as dashEscapeState, type EscapeState } from "./orbit-universe/escape/escapeState";
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
  const gauntlet=useRef<GauntletState>(createGauntletState());
  const camera=useRef<CameraState>(createCameraState());
  const nav=useRef<NavGestureState>({lastAngle:0,lastMidpoint:null,trackedHands:0,pinchActive:false,pinchStartY:0,pinchStartTime:0,lastPinchY:0});
  const escape=useRef<EscapeState>(createEscapeState());
  const escapeNow=useRef(false);
  const stabilizers=useRef<[GestureStabilizer,GestureStabilizer]>([new GestureStabilizer(),new GestureStabilizer()]);
  const sceneNow=useRef<PlayScene>("system");
  const [active,setActive]=useState(false),[mode,setMode]=useState<OrbitPlayMode>("playground"),[gesture,setGesture]=useState("Waiting for hands"),[message,setMessage]=useState("Camera off · all tracking is local"),[immersive,setImmersive]=useState(false),[effect,setEffect]=useState("IDLE");
  const [scene,setScene]=useState<PlayScene>("system");
  const [orbitReady,setOrbitReady]=useState(false),[escapeActive,setEscapeActiveState]=useState(false);
  const [cameraVisible,setCameraVisible]=useState(false);

  const setEscapeActive=(value:boolean)=>{escapeNow.current=value;setEscapeActiveState(value)};
  const escapeInputActive=()=>escapeNow.current;

  const handleEscapeEnd=()=>{setEffect("RUN ENDED");setMessage("Press Enter or click Restart · beat your best")};
  const startEscape=()=>{
    escape.current={...escape.current,running:true,over:false,lane:0,targetLane:0,distance:0,score:0,speed:.006,multiplier:1,dash:1,obstacles:[],lastSpawn:0};
    setEffect("ORBIT ESCAPE");setGesture("Run started");setMessage("Steer with A/D or your hand · Space to phase dash");
  };
  const steerEscape=(direction:-1|1)=>steerEscapeState(escape.current,direction);
  const dashEscape=()=>{if(dashEscapeState(escape.current))setEffect("PHASE DASH")};

  const chooseScene=(next:PlayScene)=>{
    sceneNow.current=next;setScene(next);setEffect(next==="system"?"SOLAR SYSTEM":"ENERGY STABLE");
    escape.current.running=false;
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
    else if(event==="suited"){setEffect("GAUNTLET READY");setMessage("Open palm to fire · bring both hands together to charge a fireball · hold fist 2s to power down")}
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
      if(escapeNow.current&&escape.current.running){
        const hand=detected[0];
        if(hand){escape.current.targetLane=hand.palm.x<.38?-1:hand.palm.x>.62?1:0;if(hand.pinching)dashEscape()}
      }else if(sceneNow.current==="energy")updateGauntletScene(detected);
      else updateCamera(detected);
      if(performance.now()-lastGestureUpdate.current>120){lastGestureUpdate.current=performance.now();setGesture(`${detected.length} hand${detected.length>1?"s":""} · ${detected.map(hand=>hand.gesture).join(" + ")}`)}
    }else if(performance.now()-gauntlet.current.ball.lastSeen>260){handsNow.current=[];setGesture("Tracking hands…")}
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
  useEffect(()=>{const changed=()=>setImmersive(Boolean(document.fullscreenElement));const keydown=(event:KeyboardEvent)=>{if(event.key==="Escape"&&stream.current){void stop();return}if(escapeInputActive()){if(event.key==="ArrowLeft"||event.key.toLowerCase()==="a")steerEscape(-1);if(event.key==="ArrowRight"||event.key.toLowerCase()==="d")steerEscape(1);if(event.code==="Space"){event.preventDefault();dashEscape()}if(event.key==="Enter")startEscape()}};document.addEventListener("fullscreenchange",changed);document.addEventListener("keydown",keydown);drawWorld();return()=>{document.removeEventListener("fullscreenchange",changed);document.removeEventListener("keydown",keydown);void stop()}},[]);

  return <div ref={root} className={`orbit-play ${active?"is-active":""} ${effect==="SUPERNOVA"?"is-bursting":""}`}>
    <canvas className="energy-world" ref={world}/>
    {scene==="system"&&!escapeActive&&<OrbitUniverse camera={camera} onOrbitReadyChange={setOrbitReady}/>}
    {escapeActive&&<OrbitEscapeGame game={escape} onEnded={handleEscapeEnd}/>}
    <video ref={video} muted playsInline aria-hidden="true" className={cameraVisible&&scene==="energy"?"camera-visible":""}/>
    <canvas className="hand-overlay" ref={overlay}/>
    <header><div><small>ORBIT PLAY · REAL SOLAR SYSTEM</small><h1>{scene==="system"?"A real universe in your hands.":"Shape the impossible."}</h1><p>{scene==="system"?"Fly from the Milky Way down to every real planet, and find Orbit at the edge of the system.":"Move the field. Rotate both hands. Pinch and pull, then clap to release."}</p></div><span className={active?"camera-live":""}>● {active?"CAMERA ACTIVE · LOCAL ONLY":"CAMERA OFF"}</span></header>
    <div className="play-controls">
      <div className="scene-switch"><button className={scene==="system"?"selected":""} onClick={()=>chooseScene("system")}>Solar system</button><button className={scene==="energy"?"selected":""} onClick={()=>chooseScene("energy")}>Energy lab</button></div>
      <div className="mode-switch"><button className={mode==="playground"?"selected":""} disabled={active} onClick={()=>setMode("playground")}>Play</button><button className={mode==="desktop"?"selected":""} disabled={active} onClick={()=>setMode("desktop")}>Desktop</button></div>
      {active?<button className="play-stop" onClick={()=>void stop()}>Stop</button>:<button className="play-start" onClick={()=>void start()}>Enter Orbit Play</button>}
      {scene==="system"&&orbitReady&&!escapeActive&&<button className="escape-start" onClick={()=>{setEscapeActive(true);startEscape()}}>Play Orbit Escape</button>}
      {escapeActive&&<button className="play-stop" onClick={()=>{escape.current.running=false;setEscapeActive(false)}}>Exit Escape</button>}
      {scene==="energy"&&<button className="play-immersive" onClick={()=>setCameraVisible(v=>!v)}>{cameraVisible?"Hide camera":"Show camera"}</button>}
      <button className="play-immersive" onClick={()=>void toggleImmersive()}>{immersive?"Exit full screen":"Full screen"}</button>
    </div>
    <div className="gesture-readout"><small>{effect}</small><b>{gesture}</b><span>{message}</span></div>
    <div className="play-hint">{escapeActive?<><span>A / D OR HAND TO STEER</span><i/><span>SPACE OR PINCH TO DASH</span></>:scene==="energy"?(effect==="GAUNTLET READY"?<><span>OPEN PALM TO FIRE</span><i/><span>HANDS TOGETHER FOR FIREBALL</span><i/><span>HOLD FIST 2S TO POWER DOWN</span></>:effect==="SUIT ENGAGED"||effect==="POWERING DOWN"?<><span>{effect}…</span></>:<><span>MOVE TOGETHER</span><i/><span>ROTATE</span><i/><span>PINCH + PULL</span><i/><span>CLAP TO BURST</span><i/><span>FIST + PUSH TO SUIT UP</span></>):<><span>ROTATE VIEW</span><i/><span>PINCH + DRAG UP/DOWN TO ZOOM</span><i/><span>QUICK PINCH TO ADVANCE</span></>}</div>
    <aside className="play-safety"><b>LOCAL CAMERA</b><span>Only hand landmarks appear; the camera image stays hidden. Frames are never recorded or uploaded. Press Esc or hold both fists for 2 seconds to stop.</span></aside>
  </div>;
}
