import React, { useEffect, useRef, useState } from "react";
import type { NormalizedLandmark, Results } from "@mediapipe/hands";
import type { OrbitPlayMode } from "../shared/contracts";
import "./orbit-play.css";

type GestureName = "Point"|"Pinch"|"Drag"|"Scroll"|"Open palm"|"Fist";
type Point = { x:number;y:number };
type HandState = { landmarks:NormalizedLandmark[];point:Point;palm:Point;gesture:GestureName;pinching:boolean };
type Spark = { angle:number;radius:number;speed:number;size:number;alpha:number;hue:number;burstX:number;burstY:number };
type EnergyState = { center:Point;scale:number;rotation:number;rotationVelocity:number;tension:number;burst:number;burstAt:number;lastSeparation:number;lastSeen:number };
type HandsTracker = { setOptions(options:Record<string,unknown>):void;onResults(callback:(results:Results)=>void):void;send(input:{image:HTMLVideoElement}):Promise<void>;close():Promise<void> };
declare global { interface Window { Hands: new(options:{locateFile:(file:string)=>string})=>HandsTracker } }

const HAND_CONNECTIONS:[number,number][]=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
let handsScript:Promise<void>|null=null;
const mediaPipeAsset=(file:string)=>new URL(`./mediapipe/hands/${file}`,document.baseURI).href;
const loadHands=()=>handsScript??=new Promise((resolve,reject)=>{if(window.Hands)return resolve();const script=document.createElement("script");script.src=mediaPipeAsset("hands.js");script.onload=()=>resolve();script.onerror=()=>reject(new Error("Orbit Play hand model could not load"));document.head.append(script)});
const distance=(a:NormalizedLandmark,b:NormalizedLandmark)=>Math.hypot(a.x-b.x,a.y-b.y);
const raised=(lm:NormalizedLandmark[],tip:number,pip:number)=>lm[tip].y<lm[pip].y;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const mix=(from:number,to:number,amount:number)=>from+(to-from)*amount;
const mixPoint=(from:Point,to:Point,amount:number)=>({x:mix(from.x,to.x,amount),y:mix(from.y,to.y,amount)});
const palmPoint=(lm:NormalizedLandmark[]):Point=>({x:(lm[0].x+lm[5].x+lm[9].x+lm[13].x+lm[17].x)/5,y:(lm[0].y+lm[5].y+lm[9].y+lm[13].y+lm[17].y)/5});

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
  const sparks=useRef<Spark[]>([]),pinching=useRef(false),lastScrollY=useRef(.5),fistSince=useRef(0),lastClick=useRef(0),phase=useRef(0),lastGestureUpdate=useRef(0);
  const energy=useRef<EnergyState>({center:{x:.5,y:.53},scale:1,rotation:0,rotationVelocity:0,tension:0,burst:0,burstAt:0,lastSeparation:.34,lastSeen:0});
  const [active,setActive]=useState(false),[mode,setMode]=useState<OrbitPlayMode>("playground"),[gesture,setGesture]=useState("Waiting for hands"),[message,setMessage]=useState("Camera off · all tracking is local"),[immersive,setImmersive]=useState(false),[effect,setEffect]=useState("IDLE");

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
  const triggerBurst=()=>{
    const now=performance.now(),state=energy.current;
    if(now-state.burstAt<2200)return;
    state.burst=1;state.burstAt=now;state.tension=0;state.rotationVelocity*=1.8;
    sparks.current.forEach(spark=>{const force=.8+Math.random()*1.25;spark.burstX=Math.cos(spark.angle)*force;spark.burstY=Math.sin(spark.angle)*force});
    setEffect("SUPERNOVA");setMessage("Clap burst · energy field reforming");
    window.setTimeout(()=>setEffect("REFORMING"),650);window.setTimeout(()=>setEffect("ENERGY STABLE"),1900);
  };
  const updateEnergy=(hands:HandState[])=>{
    const state=energy.current,now=performance.now();
    if(hands.length<2){state.tension*=.94;state.lastSeen=now;return}
    const ordered=[...hands].sort((a,b)=>a.palm.x-b.palm.x);
    const midpoint={x:(ordered[0].palm.x+ordered[1].palm.x)/2,y:(ordered[0].palm.y+ordered[1].palm.y)/2};
    const separation=Math.hypot(ordered[1].palm.x-ordered[0].palm.x,ordered[1].palm.y-ordered[0].palm.y);
    const angle=Math.atan2(ordered[1].palm.y-ordered[0].palm.y,ordered[1].palm.x-ordered[0].palm.x);
    let delta=angle-state.rotation;while(delta>Math.PI)delta-=Math.PI*2;while(delta<-Math.PI)delta+=Math.PI*2;
    state.rotationVelocity=mix(state.rotationVelocity,delta,.16);state.rotation+=state.rotationVelocity*.7;
    state.center=mixPoint(state.center,{x:clamp(midpoint.x,.2,.8),y:clamp(midpoint.y,.24,.82)},.13);
    state.scale=mix(state.scale,clamp(separation*2.45,.68,1.62),.12);
    const bothGrab=ordered.every(hand=>hand.pinching);
    if(bothGrab&&separation>.3){state.tension=clamp(state.tension+(separation-state.lastSeparation)*4.2+.012,0,1);setEffect(state.tension>.72?"MAXIMUM TENSION":"PULLING ENERGY")}
    else state.tension*=.955;
    const closingSpeed=state.lastSeparation-separation;
    const clap=state.tension>.42&&separation<.135&&closingSpeed>.025&&now-state.burstAt>2200;
    if(clap)triggerBurst();
    else if(!bothGrab&&Math.abs(delta)>.015)setEffect(delta>0?"ROTATING CLOCKWISE":"ROTATING COUNTERCLOCKWISE");
    else if(!bothGrab&&Math.hypot(midpoint.x-state.center.x,midpoint.y-state.center.y)>.035)setEffect("MOVING FIELD");
    state.lastSeparation=separation;state.lastSeen=now;
  };
  const drawWorld=()=>{
    const canvas=world.current;if(!canvas)return;const box=canvas.getBoundingClientRect(),ratio=devicePixelRatio;
    if(canvas.width!==Math.floor(box.width*ratio)||canvas.height!==Math.floor(box.height*ratio)){canvas.width=Math.floor(box.width*ratio);canvas.height=Math.floor(box.height*ratio)}
    const ctx=canvas.getContext("2d")!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,box.width,box.height);
    const hands=handsNow.current,state=energy.current;phase.current+=.013;
    const center={x:state.center.x*box.width,y:state.center.y*box.height};
    const pinchCharge=hands.filter(hand=>hand.pinching).length,base=Math.min(box.width,box.height)*.225;
    const pulse=1+Math.sin(phase.current*2.4)*.012+state.tension*.08;
    const radius=base*state.scale*pulse;
    if(!sparks.current.length)sparks.current=Array.from({length:460},(_,i)=>({angle:Math.random()*Math.PI*2,radius:.42+Math.random()*.88,speed:.0015+Math.random()*.009,size:.4+Math.random()*2.7,alpha:.2+Math.random()*.78,hue:18+Math.random()*35+(i%9===0?160:0),burstX:0,burstY:0}));

    const atmosphere=ctx.createRadialGradient(center.x,center.y,0,center.x,center.y,radius*3.1);
    atmosphere.addColorStop(0,`rgba(255,181,73,${.28+state.tension*.16})`);atmosphere.addColorStop(.34,"rgba(255,72,19,.1)");atmosphere.addColorStop(1,"rgba(1,3,10,0)");
    ctx.fillStyle=atmosphere;ctx.fillRect(0,0,box.width,box.height);
    for(let ring=0;ring<7;ring++){
      ctx.save();ctx.translate(center.x,center.y);ctx.rotate(state.rotation+phase.current*(ring%2?-.34:.5)+ring*.78);
      ctx.scale(1,.5+ring*.035);ctx.beginPath();ctx.strokeStyle=`rgba(255,${100+ring*18},45,${.2-ring*.02+state.tension*.08})`;ctx.lineWidth=1.1+ring*.35;
      ctx.setLineDash([3+ring*3,9+ring*5]);ctx.arc(0,0,radius*(.98+ring*.052),0,Math.PI*2);ctx.stroke();ctx.restore();
    }
    sparks.current.forEach((spark,index)=>{
      spark.angle+=spark.speed*(1+pinchCharge*.7+state.tension*2.5)+state.rotationVelocity*.025;
      const radial=radius*spark.radius*(1-state.tension*.13);
      let x=center.x+Math.cos(spark.angle+state.rotation+Math.sin(phase.current+index)*.055)*radial;
      let y=center.y+Math.sin(spark.angle+state.rotation)*radial*(.68+.18*Math.sin(index));
      if(state.burst>0){x+=spark.burstX*radius*state.burst*2.8;y+=spark.burstY*radius*state.burst*2.8}
      hands.forEach(hand=>{const hx=hand.point.x*box.width,hy=hand.point.y*box.height,dx=hx-x,dy=hy-y,d=Math.max(24,Math.hypot(dx,dy));const pull=hand.pinching?Math.min(.24,300/(d*d)):Math.min(.045,65/(d*d));x+=dx*pull;y+=dy*pull});
      ctx.beginPath();ctx.fillStyle=`hsla(${spark.hue},100%,68%,${spark.alpha})`;ctx.shadowColor=spark.hue>100?"#70eaff":"#ff7029";ctx.shadowBlur=8+state.tension*10;ctx.arc(x,y,spark.size*(1+state.tension*.5),0,Math.PI*2);ctx.fill();
    });
    if(state.burst>0){state.burst*=.925;if(state.burst<.015)state.burst=0;ctx.beginPath();ctx.strokeStyle=`rgba(255,235,180,${state.burst})`;ctx.lineWidth=3;ctx.arc(center.x,center.y,radius*(1+(1-state.burst)*3),0,Math.PI*2);ctx.stroke()}
    ctx.shadowBlur=0;
    const core=ctx.createRadialGradient(center.x-radius*.2,center.y-radius*.25,radius*.01,center.x,center.y,radius);
    core.addColorStop(0,"rgba(255,255,235,.99)");core.addColorStop(.1,"rgba(255,226,143,.96)");core.addColorStop(.38,`rgba(255,112,31,${.58+state.tension*.25})`);core.addColorStop(.76,"rgba(255,38,10,.15)");core.addColorStop(1,"rgba(255,70,20,0)");
    ctx.globalCompositeOperation="screen";ctx.fillStyle=core;ctx.beginPath();ctx.arc(center.x,center.y,radius*(1-state.burst*.8),0,Math.PI*2);ctx.fill();ctx.globalCompositeOperation="source-over";
    hands.forEach((hand,index)=>{
      const x=hand.point.x*box.width,y=hand.point.y*box.height,hot=hand.pinching;
      const beam=ctx.createLinearGradient(x,y,center.x,center.y);beam.addColorStop(0,hot?"rgba(255,235,155,.72)":"rgba(107,239,255,.28)");beam.addColorStop(1,"rgba(255,96,28,0)");
      ctx.strokeStyle=beam;ctx.lineWidth=hot?2.8:1;ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo((x+center.x)/2,center.y+(index?1:-1)*radius*.32,center.x,center.y);ctx.stroke();
      ctx.beginPath();ctx.strokeStyle=hot?"#ffe39d":"#76efff";ctx.lineWidth=2;ctx.arc(x,y,hot?18:10,0,Math.PI*2);ctx.stroke();
    });
  };
  const onResults=(results:Results)=>{
    processing.current=false;const canvas=overlay.current;if(!canvas)return;
    const box=canvas.getBoundingClientRect(),ratio=devicePixelRatio;canvas.width=box.width*ratio;canvas.height=box.height*ratio;
    const ctx=canvas.getContext("2d")!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,box.width,box.height);
    const landmarks=(results.multiHandLandmarks??[]).slice(0,2);
    if(landmarks.length){
      const previous=[...handsNow.current].sort((a,b)=>a.palm.x-b.palm.x);
      const detected=landmarks.map(lm=>{const palm=palmPoint(lm);const prior=previous.reduce<HandState|undefined>((best,item)=>!best||Math.abs(item.palm.x-palm.x)<Math.abs(best.palm.x-palm.x)?item:best,undefined);const smoothLm=lm.map((p,i)=>prior?{...p,x:mix(prior.landmarks[i].x,p.x,.38),y:mix(prior.landmarks[i].y,p.y,.38),z:mix(prior.landmarks[i].z,p.z,.38)}:p);const next=classify(smoothLm,pinching.current);return {landmarks:smoothLm,point:{x:smoothLm[8].x,y:smoothLm[8].y},palm:palmPoint(smoothLm),gesture:next,pinching:next==="Pinch"||next==="Drag"}});
      handsNow.current=detected;updateEnergy(detected);
      if(performance.now()-lastGestureUpdate.current>120){lastGestureUpdate.current=performance.now();setGesture(`${detected.length} hand${detected.length>1?"s":""} · ${detected.map(hand=>hand.gesture).join(" + ")}`)}
    }else if(performance.now()-energy.current.lastSeen>260){handsNow.current=[];setGesture("Tracking hands…")}
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
      if(!document.fullscreenElement)await root.current?.requestFullscreen();
      setMessage("Requesting camera permission…");
      stream.current=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:1280},height:{ideal:720}},audio:false});
      if(!video.current)return;video.current.srcObject=stream.current;await video.current.play();
      await loadHands();const hands=new window.Hands({locateFile:mediaPipeAsset});tracker.current=hands;
      hands.setOptions({selfieMode:true,maxNumHands:2,modelComplexity:1,minDetectionConfidence:.62,minTrackingConfidence:.62});hands.onResults(onResults);
      const status=await window.orbit.orbitPlayStart(mode);if(!status.supported)throw new Error(status.message);
      setActive(true);setEffect("ENERGY STABLE");setMessage(mode==="desktop"?"Desktop control active · press Esc or hold both fists to stop":"Pull with two pinches, then clap to burst");
      const loop=async()=>{drawWorld();if(video.current&&tracker.current&&!processing.current&&video.current.readyState>=2){processing.current=true;try{await tracker.current.send({image:video.current})}catch{processing.current=false}}raf.current=requestAnimationFrame(loop)};void loop();
    }catch(error){await stop();setMessage(error instanceof Error?error.message:"Camera permission was denied")}
  };
  useEffect(()=>{const changed=()=>setImmersive(Boolean(document.fullscreenElement));const keydown=(event:KeyboardEvent)=>{if(event.key==="Escape"&&stream.current)void stop()};document.addEventListener("fullscreenchange",changed);document.addEventListener("keydown",keydown);drawWorld();return()=>{document.removeEventListener("fullscreenchange",changed);document.removeEventListener("keydown",keydown);void stop()}},[]);

  return <div ref={root} className={`orbit-play ${active?"is-active":""} ${effect==="SUPERNOVA"?"is-bursting":""}`}>
    <canvas className="energy-world" ref={world}/>
    <video ref={video} muted playsInline aria-hidden="true"/>
    <canvas className="hand-overlay" ref={overlay}/>
    <div className="play-vignette"/><div className="play-grain"/>
    <header><div><small>ORBIT PLAY · KINETIC ENERGY ENGINE</small><h1>Shape the impossible.</h1><p>Move the field. Rotate both hands. Pinch and pull, then clap to release.</p></div><span className={active?"camera-live":""}>● {active?"CAMERA ACTIVE · LOCAL ONLY":"CAMERA OFF"}</span></header>
    <div className="play-controls">
      <div className="mode-switch"><button className={mode==="playground"?"selected":""} disabled={active} onClick={()=>setMode("playground")}>Energy field</button><button className={mode==="desktop"?"selected":""} disabled={active} onClick={()=>setMode("desktop")}>Desktop control</button></div>
      {active?<button className="play-stop" onClick={()=>void stop()}>Stop</button>:<button className="play-start" onClick={()=>void start()}>Enter Orbit Play</button>}
      <button className="play-immersive" onClick={()=>void toggleImmersive()}>{immersive?"Exit full screen":"Full screen"}</button>
    </div>
    <div className="gesture-readout"><small>{effect}</small><b>{gesture}</b><span>{message}</span></div>
    <div className="play-hint"><span>MOVE TOGETHER</span><i/><span>ROTATE</span><i/><span>PINCH + PULL</span><i/><span>CLAP TO BURST</span></div>
    <aside className="play-safety"><b>LOCAL CAMERA</b><span>Only hand landmarks appear; the camera image stays hidden. Frames are never recorded or uploaded. Press Esc or hold both fists for 2 seconds to stop.</span></aside>
  </div>;
}
