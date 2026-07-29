import React, { useEffect, useRef, useState } from "react";
import type { NormalizedLandmark, Results } from "@mediapipe/hands";
import type { OrbitPlayMode } from "../shared/contracts";
import "./orbit-play.css";

type GestureName = "No hand"|"Point"|"Pinch"|"Drag"|"Scroll"|"Open palm"|"Fist";
type Dot = { x:number;y:number;vx:number;vy:number;h:number };
type HandsTracker = { setOptions(options:Record<string,unknown>):void;onResults(callback:(results:Results)=>void):void;send(input:{image:HTMLVideoElement}):Promise<void>;close():Promise<void> };
declare global { interface Window { Hands: new(options:{locateFile:(file:string)=>string})=>HandsTracker } }
const HAND_CONNECTIONS:[number,number][]=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
let handsScript:Promise<void>|null=null;
const mediaPipeAsset=(file:string)=>new URL(`./mediapipe/hands/${file}`,document.baseURI).href;
const loadHands=()=>handsScript??=new Promise((resolve,reject)=>{if(window.Hands)return resolve();const script=document.createElement("script");script.src=mediaPipeAsset("hands.js");script.onload=()=>resolve();script.onerror=()=>reject(new Error("Orbit Play hand model could not load"));document.head.append(script)});
const distance=(a:NormalizedLandmark,b:NormalizedLandmark)=>Math.hypot(a.x-b.x,a.y-b.y);
const raised=(lm:NormalizedLandmark[],tip:number,pip:number)=>lm[tip].y<lm[pip].y;

function classify(lm:NormalizedLandmark[], pinching:boolean):GestureName {
  const fingers=[raised(lm,8,6),raised(lm,12,10),raised(lm,16,14),raised(lm,20,18)];
  const count=fingers.filter(Boolean).length;
  if(distance(lm[4],lm[8])<0.055)return pinching?"Drag":"Pinch";
  if(count===0)return "Fist";
  if(fingers[0]&&fingers[1]&&!fingers[2]&&!fingers[3])return "Scroll";
  if(fingers[0]&&count===1)return "Point";
  if(count===4)return "Open palm";
  return "Point";
}

export function OrbitPlay(){
  const video=useRef<HTMLVideoElement>(null),overlay=useRef<HTMLCanvasElement>(null),world=useRef<HTMLCanvasElement>(null);
  const stream=useRef<MediaStream|null>(null),tracker=useRef<HandsTracker|null>(null),raf=useRef(0),processing=useRef(false);
  const dots=useRef<Dot[]>([]),pinching=useRef(false),lastPoint=useRef({x:.5,y:.5}),lastScrollY=useRef(.5),fistSince=useRef(0),lastClick=useRef(0);
  const [active,setActive]=useState(false),[mode,setMode]=useState<OrbitPlayMode>("playground"),[gesture,setGesture]=useState<GestureName>("No hand"),[message,setMessage]=useState("Camera off · all tracking is local");

  const stop=async()=>{
    cancelAnimationFrame(raf.current);stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;
    await tracker.current?.close();tracker.current=null;pinching.current=false;processing.current=false;
    await window.orbit.orbitPlayStop();setActive(false);setGesture("No hand");setMessage("Camera off · all tracking is local");
  };
  const drawWorld=(point?:{x:number;y:number},pinch=false)=>{
    const canvas=world.current;if(!canvas)return;const box=canvas.getBoundingClientRect();
    if(canvas.width!==Math.floor(box.width*devicePixelRatio)){canvas.width=Math.floor(box.width*devicePixelRatio);canvas.height=Math.floor(box.height*devicePixelRatio)}
    const ctx=canvas.getContext("2d")!;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);ctx.fillStyle="rgba(3,6,16,.24)";ctx.fillRect(0,0,box.width,box.height);
    if(!dots.current.length)dots.current=Array.from({length:84},(_,i)=>({x:Math.random()*box.width,y:Math.random()*box.height,vx:(Math.random()-.5)*.5,vy:(Math.random()-.5)*.5,h:185+i%70}));
    const px=(point?.x??.5)*box.width,py=(point?.y??.5)*box.height;
    dots.current.forEach(dot=>{const dx=px-dot.x,dy=py-dot.y,d=Math.max(18,Math.hypot(dx,dy));const force=(pinch?-1:1)*Math.min(1,1500/(d*d));dot.vx+=dx/d*force;dot.vy+=dy/d*force;dot.vx*=.97;dot.vy*=.97;dot.x=(dot.x+dot.vx+box.width)%box.width;dot.y=(dot.y+dot.vy+box.height)%box.height;ctx.beginPath();ctx.fillStyle=`hsla(${dot.h},95%,68%,${.35+Math.min(.55,60/d)})`;ctx.arc(dot.x,dot.y,pinch?3.2:2.1,0,Math.PI*2);ctx.fill()});
    ctx.beginPath();ctx.strokeStyle=pinch?"#ffcf70":"#6df2ff";ctx.lineWidth=2;ctx.arc(px,py,pinch?18:11,0,Math.PI*2);ctx.stroke();
  };
  const onResults=(results:Results)=>{
    processing.current=false;const canvas=overlay.current,vid=video.current;if(!canvas||!vid)return;
    const box=canvas.getBoundingClientRect();canvas.width=box.width*devicePixelRatio;canvas.height=box.height*devicePixelRatio;
    const ctx=canvas.getContext("2d")!;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);ctx.clearRect(0,0,box.width,box.height);
    const lm=results.multiHandLandmarks?.[0];if(!lm){setGesture("No hand");drawWorld();return}
    const next=classify(lm,pinching.current);setGesture(next);
    ctx.strokeStyle="rgba(109,242,255,.7)";ctx.lineWidth=2;
    HAND_CONNECTIONS.forEach(([a,b])=>{ctx.beginPath();ctx.moveTo(lm[a].x*box.width,lm[a].y*box.height);ctx.lineTo(lm[b].x*box.width,lm[b].y*box.height);ctx.stroke()});
    lm.forEach((p,i)=>{ctx.beginPath();ctx.fillStyle=i===8?"#ffcf70":"#8ff8ff";ctx.arc(p.x*box.width,p.y*box.height,i===8?5:3,0,Math.PI*2);ctx.fill()});
    const point={x:1-lm[8].x,y:lm[8].y};drawWorld(point,next==="Pinch"||next==="Drag");
    if(next==="Fist"){if(!fistSince.current)fistSince.current=Date.now();if(Date.now()-fistSince.current>850){setMessage("Emergency stop detected");void stop();return}}else fistSince.current=0;
    if(mode==="desktop"){
      if(next==="Point"||next==="Pinch"||next==="Drag")void window.orbit.orbitPlayAction({action:"move",x:point.x,y:point.y});
      const nowPinching=next==="Pinch"||next==="Drag";
      if(nowPinching&&!pinching.current&&Date.now()-lastClick.current>350){pinching.current=true;lastClick.current=Date.now();void window.orbit.orbitPlayAction({action:"down",x:point.x,y:point.y})}
      if(!nowPinching&&pinching.current){pinching.current=false;void window.orbit.orbitPlayAction({action:"up",x:point.x,y:point.y})}
      if(next==="Scroll"){const delta=(lastScrollY.current-lm[8].y)*900;lastScrollY.current=lm[8].y;if(Math.abs(delta)>2)void window.orbit.orbitPlayAction({action:"scroll",deltaY:delta})}else lastScrollY.current=lm[8].y;
    }
    lastPoint.current=point;
  };
  const start=async()=>{
    try{
      setMessage("Requesting camera permission…");
      stream.current=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:960},height:{ideal:540}},audio:false});
      if(!video.current)return;video.current.srcObject=stream.current;await video.current.play();
      await loadHands();const hands=new window.Hands({locateFile:mediaPipeAsset});tracker.current=hands;
      hands.setOptions({selfieMode:true,maxNumHands:1,modelComplexity:1,minDetectionConfidence:.72,minTrackingConfidence:.72});hands.onResults(onResults);
      const status=await window.orbit.orbitPlayStart(mode);if(!status.supported)throw new Error(status.message);
      setActive(true);setMessage(mode==="desktop"?"Desktop control active · hold a fist to stop":"Playground active · frames never leave this Mac");
      const loop=async()=>{if(video.current&&tracker.current&&!processing.current&&video.current.readyState>=2){processing.current=true;try{await tracker.current.send({image:video.current})}catch{processing.current=false}}raf.current=requestAnimationFrame(loop)};void loop();
    }catch(error){await stop();setMessage(error instanceof Error?error.message:"Camera permission was denied")}
  };
  useEffect(()=>()=>{void stop()},[]);
  return <div className="orbit-play">
    <header><div><small>PHASE 8 · LOCAL VISUAL INTELLIGENCE</small><h1>Orbit Play</h1><p>Control a reactive world—or your Mac—with deliberate hand gestures.</p></div><span className={active?"camera-live":""}>● {active?"CAMERA ACTIVE":"CAMERA OFF"}</span></header>
    <div className="play-toolbar"><div><button className={mode==="playground"?"selected":""} disabled={active} onClick={()=>setMode("playground")}>Playground</button><button className={mode==="desktop"?"selected":""} disabled={active} onClick={()=>setMode("desktop")}>Desktop control</button></div>{active?<button className="play-stop" onClick={()=>void stop()}>Stop Orbit Play</button>:<button className="play-start" onClick={()=>void start()}>Start Orbit Play</button>}</div>
    <div className="play-stage"><canvas ref={world}/><video ref={video} muted playsInline/><canvas ref={overlay}/><div className="gesture-readout"><small>GESTURE</small><b>{gesture}</b><span>{message}</span></div></div>
    <div className="gesture-guide">{[["☝","Point","Move"],["🤏","Pinch","Click / grab"],["✌","Two fingers","Scroll"],["🖐","Open palm","Interact"],["✊","Hold fist","Emergency stop"]].map(([icon,name,action])=><article key={name}><i>{icon}</i><b>{name}</b><span>{action}</span></article>)}</div>
    <aside className="play-safety"><b>Local by design</b><span>No frames are recorded or uploaded. Desktop mode can move, click, drag, scroll, and toggle media only; sending, deleting, purchasing, and typing are blocked.</span></aside>
  </div>;
}
