import React, { useEffect, useRef, useState } from "react";
import type { NormalizedLandmark, Results } from "@mediapipe/hands";
import type { OrbitPlayMode } from "../shared/contracts";
import "./orbit-play.css";

type GestureName = "No hand"|"Point"|"Pinch"|"Drag"|"Scroll"|"Open palm"|"Fist";
type HandState = { landmarks:NormalizedLandmark[];point:{x:number;y:number};gesture:GestureName;pinching:boolean };
type Spark = { angle:number;radius:number;speed:number;size:number;alpha:number;hue:number };
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
  const root=useRef<HTMLDivElement>(null),video=useRef<HTMLVideoElement>(null),overlay=useRef<HTMLCanvasElement>(null),world=useRef<HTMLCanvasElement>(null);
  const stream=useRef<MediaStream|null>(null),tracker=useRef<HandsTracker|null>(null),raf=useRef(0),processing=useRef(false),handsNow=useRef<HandState[]>([]);
  const sparks=useRef<Spark[]>([]),pinching=useRef(false),lastScrollY=useRef(.5),fistSince=useRef(0),lastClick=useRef(0),phase=useRef(0);
  const [active,setActive]=useState(false),[mode,setMode]=useState<OrbitPlayMode>("playground"),[gesture,setGesture]=useState("Waiting for hands"),[message,setMessage]=useState("Camera off · all tracking is local"),[immersive,setImmersive]=useState(false);

  const stop=async()=>{
    cancelAnimationFrame(raf.current);stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;
    await tracker.current?.close();tracker.current=null;pinching.current=false;processing.current=false;handsNow.current=[];
    await window.orbit.orbitPlayStop();setActive(false);setGesture("Waiting for hands");setMessage("Camera off · all tracking is local");
  };
  const toggleImmersive=async()=>{
    if(!document.fullscreenElement){await root.current?.requestFullscreen();setImmersive(true)}
    else{await document.exitFullscreen();setImmersive(false)}
  };
  const drawWorld=()=>{
    const canvas=world.current;if(!canvas)return;const box=canvas.getBoundingClientRect(),ratio=devicePixelRatio;
    if(canvas.width!==Math.floor(box.width*ratio)||canvas.height!==Math.floor(box.height*ratio)){canvas.width=Math.floor(box.width*ratio);canvas.height=Math.floor(box.height*ratio)}
    const ctx=canvas.getContext("2d")!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,box.width,box.height);
    const hands=handsNow.current,center={x:box.width*.5,y:box.height*.5};phase.current+=.012;
    const separation=hands.length>1?Math.hypot(hands[0].point.x-hands[1].point.x,hands[0].point.y-hands[1].point.y):.34;
    const openness=hands.length>1?Math.max(.72,Math.min(1.55,separation*2.1)):1;
    const pinchCharge=hands.filter(hand=>hand.pinching).length;
    const base=Math.min(box.width,box.height)*.205;
    const radius=base*openness*(1+pinchCharge*.07)+Math.sin(phase.current*2)*3;
    if(!sparks.current.length)sparks.current=Array.from({length:320},(_,i)=>({angle:Math.random()*Math.PI*2,radius:.55+Math.random()*.75,speed:.0015+Math.random()*.008,size:.4+Math.random()*2.4,alpha:.18+Math.random()*.78,hue:24+Math.random()*28+(i%7===0?150:0)}));

    const atmosphere=ctx.createRadialGradient(center.x,center.y,0,center.x,center.y,radius*2.8);
    atmosphere.addColorStop(0,"rgba(255,174,69,.25)");atmosphere.addColorStop(.38,"rgba(255,82,24,.09)");atmosphere.addColorStop(1,"rgba(1,3,10,0)");
    ctx.fillStyle=atmosphere;ctx.fillRect(0,0,box.width,box.height);

    for(let ring=0;ring<5;ring++){
      ctx.save();ctx.translate(center.x,center.y);ctx.rotate(phase.current*(ring%2?-.42:.62)+ring);
      ctx.scale(1,.62+ring*.035);ctx.beginPath();ctx.strokeStyle=`rgba(255,${105+ring*20},45,${.14-ring*.018})`;ctx.lineWidth=1.3+ring*.35;
      ctx.setLineDash([4+ring*3,10+ring*5]);ctx.arc(0,0,radius*(1.02+ring*.055),0,Math.PI*2);ctx.stroke();ctx.restore();
    }
    sparks.current.forEach((spark,index)=>{
      spark.angle+=spark.speed*(pinchCharge?2.1:1);let radial=radius*spark.radius;
      let x=center.x+Math.cos(spark.angle+Math.sin(phase.current+index)*.05)*radial;
      let y=center.y+Math.sin(spark.angle)*radial*(.72+.16*Math.sin(index));
      hands.forEach(hand=>{const hx=hand.point.x*box.width,hy=hand.point.y*box.height,dx=hx-x,dy=hy-y,d=Math.max(24,Math.hypot(dx,dy));const pull=hand.pinching?Math.min(.24,260/(d*d)):Math.min(.07,90/(d*d));x+=dx*pull;y+=dy*pull});
      ctx.beginPath();ctx.fillStyle=`hsla(${spark.hue},100%,68%,${spark.alpha})`;ctx.shadowColor=spark.hue>100?"#70eaff":"#ff792f";ctx.shadowBlur=10;ctx.arc(x,y,spark.size*(pinchCharge?1.35:1),0,Math.PI*2);ctx.fill();
    });
    ctx.shadowBlur=0;
    const core=ctx.createRadialGradient(center.x-radius*.2,center.y-radius*.24,radius*.02,center.x,center.y,radius);
    core.addColorStop(0,"rgba(255,255,225,.98)");core.addColorStop(.12,"rgba(255,221,133,.94)");core.addColorStop(.42,"rgba(255,119,38,.55)");core.addColorStop(.78,"rgba(255,45,13,.16)");core.addColorStop(1,"rgba(255,75,20,0)");
    ctx.globalCompositeOperation="screen";ctx.fillStyle=core;ctx.beginPath();ctx.arc(center.x,center.y,radius,0,Math.PI*2);ctx.fill();ctx.globalCompositeOperation="source-over";

    hands.forEach((hand,index)=>{
      const x=hand.point.x*box.width,y=hand.point.y*box.height,hot=hand.pinching;
      const beam=ctx.createLinearGradient(x,y,center.x,center.y);beam.addColorStop(0,hot?"rgba(255,222,133,.58)":"rgba(107,239,255,.3)");beam.addColorStop(1,"rgba(255,107,36,0)");
      ctx.strokeStyle=beam;ctx.lineWidth=hot?2.2:1;ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo((x+center.x)/2,center.y+(index?1:-1)*radius*.35,center.x,center.y);ctx.stroke();
      ctx.beginPath();ctx.strokeStyle=hot?"#ffd98a":"#76efff";ctx.lineWidth=2;ctx.arc(x,y,hot?16:10,0,Math.PI*2);ctx.stroke();
    });
  };
  const onResults=(results:Results)=>{
    processing.current=false;const canvas=overlay.current,vid=video.current;if(!canvas||!vid)return;
    const box=canvas.getBoundingClientRect(),ratio=devicePixelRatio;canvas.width=box.width*ratio;canvas.height=box.height*ratio;
    const ctx=canvas.getContext("2d")!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,box.width,box.height);
    const landmarks=results.multiHandLandmarks??[];
    const nextHands=landmarks.slice(0,2).map(lm=>{const next=classify(lm,pinching.current);return {landmarks:lm,point:{x:lm[8].x,y:lm[8].y},gesture:next,pinching:next==="Pinch"||next==="Drag"}});
    handsNow.current=nextHands;
    setGesture(nextHands.length?`${nextHands.length} hand${nextHands.length>1?"s":""} · ${nextHands.map(hand=>hand.gesture).join(" + ")}`:"Waiting for hands");
    nextHands.forEach((hand,handIndex)=>{
      ctx.strokeStyle=handIndex?"rgba(255,190,105,.55)":"rgba(109,242,255,.55)";ctx.lineWidth=1.5;
      HAND_CONNECTIONS.forEach(([a,b])=>{ctx.beginPath();ctx.moveTo(hand.landmarks[a].x*box.width,hand.landmarks[a].y*box.height);ctx.lineTo(hand.landmarks[b].x*box.width,hand.landmarks[b].y*box.height);ctx.stroke()});
      hand.landmarks.forEach((p,i)=>{ctx.beginPath();ctx.fillStyle=i===8?"#fff0b5":handIndex?"#ffab65":"#77efff";ctx.arc(p.x*box.width,p.y*box.height,i===8?4:2,0,Math.PI*2);ctx.fill()});
    });
    const fist=nextHands.find(hand=>hand.gesture==="Fist");
    if(fist){if(!fistSince.current)fistSince.current=Date.now();if(Date.now()-fistSince.current>850){setMessage("Emergency stop detected");void stop();return}}else fistSince.current=0;
    const primary=nextHands[0];
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
      setMessage("Requesting camera permission…");
      stream.current=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:1280},height:{ideal:720}},audio:false});
      if(!video.current)return;video.current.srcObject=stream.current;await video.current.play();
      await loadHands();const hands=new window.Hands({locateFile:mediaPipeAsset});tracker.current=hands;
      hands.setOptions({selfieMode:true,maxNumHands:2,modelComplexity:1,minDetectionConfidence:.72,minTrackingConfidence:.72});hands.onResults(onResults);
      const status=await window.orbit.orbitPlayStart(mode);if(!status.supported)throw new Error(status.message);
      setActive(true);setMessage(mode==="desktop"?"Desktop control active · hold a fist to stop":"Two-hand energy field active · frames never leave this Mac");
      const loop=async()=>{drawWorld();if(video.current&&tracker.current&&!processing.current&&video.current.readyState>=2){processing.current=true;try{await tracker.current.send({image:video.current})}catch{processing.current=false}}raf.current=requestAnimationFrame(loop)};void loop();
    }catch(error){await stop();setMessage(error instanceof Error?error.message:"Camera permission was denied")}
  };
  useEffect(()=>{const changed=()=>setImmersive(Boolean(document.fullscreenElement));document.addEventListener("fullscreenchange",changed);drawWorld();return()=>{document.removeEventListener("fullscreenchange",changed);void stop()}},[]);

  return <div ref={root} className={`orbit-play ${active?"is-active":""}`}>
    <canvas className="energy-world" ref={world}/>
    <video ref={video} muted playsInline/>
    <canvas className="hand-overlay" ref={overlay}/>
    <div className="play-vignette"/>
    <header><div><small>ORBIT PLAY · LOCAL VISUAL INTELLIGENCE</small><h1>Shape the impossible.</h1><p>Move both hands around the energy field. Pinch to pull. Spread to expand.</p></div><span className={active?"camera-live":""}>● {active?"CAMERA ACTIVE":"CAMERA OFF"}</span></header>
    <div className="play-controls">
      <div className="mode-switch"><button className={mode==="playground"?"selected":""} disabled={active} onClick={()=>setMode("playground")}>Energy field</button><button className={mode==="desktop"?"selected":""} disabled={active} onClick={()=>setMode("desktop")}>Desktop control</button></div>
      {active?<button className="play-stop" onClick={()=>void stop()}>Stop</button>:<button className="play-start" onClick={()=>void start()}>Enter Orbit Play</button>}
      <button className="play-immersive" onClick={()=>void toggleImmersive()}>{immersive?"Exit full screen":"Full screen"}</button>
    </div>
    <div className="gesture-readout"><small>LIVE INPUT</small><b>{gesture}</b><span>{message}</span></div>
    <div className="play-hint"><span>OPEN HANDS</span><i/><span>EXPAND</span><i/><span>PINCH</span><i/><span>CHARGE</span></div>
    <aside className="play-safety"><b>LOCAL CAMERA</b><span>No frames are recorded, stored, or uploaded. Hold either fist to stop instantly.</span></aside>
  </div>;
}
