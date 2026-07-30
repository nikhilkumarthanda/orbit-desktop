import React, { useEffect, useRef, useState } from "react";
import type { NormalizedLandmark, Results } from "@mediapipe/hands";
import type { OrbitPlayMode } from "../shared/contracts";
import "./orbit-play.css";
import { OrbitUniverse } from "./orbit-universe/OrbitUniverse";
import { createCameraState, nextNavStep, radiusRangeFor, type CameraState } from "./orbit-universe/cameraState";
import { ALL_BODIES, ORBIT_INDEX } from "./orbit-universe/planets";
import { OrbitEscapeGame } from "./orbit-universe/escape/OrbitEscapeGame";
import { createEscapeState, drawEscape, steerEscape as steerEscapeState, dashEscape as dashEscapeState, type EscapeState } from "./orbit-universe/escape/escapeState";
import { GestureStabilizer, type HandState, type Point } from "./orbit-universe/gestures/gestureStateMachine";

type PlayScene = "energy"|"system"|"orbit";
type OrbitActivity = "escape"|"gravity"|"forge"|"comets";
type Spark = { angle:number;radius:number;speed:number;size:number;alpha:number;hue:number;burstX:number;burstY:number };
type EnergyState = { center:Point;scale:number;rotation:number;rotationVelocity:number;tension:number;burst:number;burstAt:number;lastSeparation:number;lastSeen:number };
type NavGestureState = { lastSeparation:number;lastAngle:number;lastMidpoint:Point|null;trackedHands:number;lastPinch:number };
type HandsTracker = { setOptions(options:Record<string,unknown>):void;onResults(callback:(results:Results)=>void):void;send(input:{image:HTMLVideoElement}):Promise<void>;close():Promise<void> };
declare global { interface Window { Hands: new(options:{locateFile:(file:string)=>string})=>HandsTracker } }

const HAND_CONNECTIONS:[number,number][]=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
let handsScript:Promise<void>|null=null;
const mediaPipeAsset=(file:string)=>new URL(`./mediapipe/hands/${file}`,document.baseURI).href;
const loadHands=()=>handsScript??=new Promise((resolve,reject)=>{if(window.Hands)return resolve();const script=document.createElement("script");script.src=mediaPipeAsset("hands.js");script.onload=()=>resolve();script.onerror=()=>reject(new Error("Orbit Play hand model could not load"));document.head.append(script)});
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const mix=(from:number,to:number,amount:number)=>from+(to-from)*amount;
const mixPoint=(from:Point,to:Point,amount:number)=>({x:mix(from.x,to.x,amount),y:mix(from.y,to.y,amount)});

export function OrbitPlay(){
  const root=useRef<HTMLDivElement>(null),video=useRef<HTMLVideoElement>(null),overlay=useRef<HTMLCanvasElement>(null),world=useRef<HTMLCanvasElement>(null);
  const stream=useRef<MediaStream|null>(null),tracker=useRef<HandsTracker|null>(null),raf=useRef(0),processing=useRef(false),handsNow=useRef<HandState[]>([]);
  const sparks=useRef<Spark[]>([]),pinching=useRef(false),lastScrollY=useRef(.5),fistSince=useRef(0),lastClick=useRef(0),phase=useRef(0),lastGestureUpdate=useRef(0);
  const energy=useRef<EnergyState>({center:{x:.5,y:.53},scale:1,rotation:0,rotationVelocity:0,tension:0,burst:0,burstAt:0,lastSeparation:.34,lastSeen:0});
  const camera=useRef<CameraState>(createCameraState());
  const nav=useRef<NavGestureState>({lastSeparation:0,lastAngle:0,lastMidpoint:null,trackedHands:0,lastPinch:0});
  const escape=useRef<EscapeState>(createEscapeState());
  const escapeNow=useRef(false);
  const stabilizers=useRef<[GestureStabilizer,GestureStabilizer]>([new GestureStabilizer(),new GestureStabilizer()]);
  const sceneNow=useRef<PlayScene>("system"),activityNow=useRef<OrbitActivity>("escape");
  const [active,setActive]=useState(false),[mode,setMode]=useState<OrbitPlayMode>("playground"),[gesture,setGesture]=useState("Waiting for hands"),[message,setMessage]=useState("Camera off · all tracking is local"),[immersive,setImmersive]=useState(false),[effect,setEffect]=useState("IDLE");
  const [scene,setScene]=useState<PlayScene>("system"),[activity,setActivity]=useState<OrbitActivity>("escape");
  const [orbitReady,setOrbitReady]=useState(false),[escapeActive,setEscapeActiveState]=useState(false);

  const setEscapeActive=(value:boolean)=>{escapeNow.current=value;setEscapeActiveState(value)};
  const escapeInputActive=()=>escapeNow.current||(sceneNow.current==="orbit"&&activityNow.current==="escape");

  const handleEscapeEnd=()=>{setEffect("RUN ENDED");setMessage("Press Enter or click Restart · beat your best")};
  const startEscape=()=>{
    escape.current={...escape.current,running:true,over:false,lane:0,targetLane:0,distance:0,score:0,speed:.006,multiplier:1,dash:1,obstacles:[],lastSpawn:0};
    setEffect("ORBIT ESCAPE");setGesture("Run started");setMessage("Steer with A/D or your hand · Space to phase dash");
  };
  const steerEscape=(direction:-1|1)=>steerEscapeState(escape.current,direction);
  const dashEscape=()=>{if(dashEscapeState(escape.current))setEffect("PHASE DASH")};

  const chooseScene=(next:PlayScene)=>{
    sceneNow.current=next;setScene(next);setEffect(next==="system"?"SOLAR SYSTEM":next==="orbit"?"ORBIT WORLD":"ENERGY STABLE");
    if(next!=="orbit")escape.current.running=false;
    setEscapeActive(false);
    setMessage(next==="system"?"Rotate with both hands · spread to zoom · pinch to travel":next==="orbit"?"Choose an experience inside Orbit":"Pull with two pinches, then clap to burst");
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

  const advanceFocus=()=>{
    const step=nextNavStep(camera.current.tier,camera.current.focusIndex);
    camera.current.targetTier=step.tier;camera.current.targetFocusIndex=step.focusIndex;camera.current.targetRadius=step.radius;
    const name=step.focusIndex===-1?(step.tier==="galaxy"?"the Milky Way":"the solar system"):ALL_BODIES[step.focusIndex].name;
    setEffect(step.tier==="galaxy"?"GALACTIC VIEW":step.tier==="system"?"SYSTEM OVERVIEW":`${name.toUpperCase()} APPROACH`);
    setGesture(`Pinch · traveling to ${name}`);
    setMessage(step.focusIndex===ORBIT_INDEX?"Arriving at Orbit — hold steady, then press Play.":`Spread hands to zoom · rotate to look around ${name}.`);
  };
  const updateCamera=(hands:HandState[])=>{
    const state=camera.current,gestureState=nav.current,now=performance.now();
    if(hands.length===2){
      const ordered=[...hands].sort((a,b)=>a.palm.x-b.palm.x);
      const dx=ordered[1].palm.x-ordered[0].palm.x,dy=ordered[1].palm.y-ordered[0].palm.y;
      const separation=Math.hypot(dx,dy),angle=Math.atan2(dy,dx),bothOpen=ordered.every(hand=>hand.gesture==="Open palm");
      if(gestureState.trackedHands===2&&bothOpen){
        const separationDelta=separation-gestureState.lastSeparation;
        let angleDelta=angle-gestureState.lastAngle;while(angleDelta>Math.PI)angleDelta-=Math.PI*2;while(angleDelta<-Math.PI)angleDelta+=Math.PI*2;
        if(Math.abs(separationDelta)>.003){
          const [min,max]=radiusRangeFor(state.tier,state.focusIndex);
          state.targetRadius=clamp(state.targetRadius-separationDelta*(max-min)*1.6,min,max);
          setEffect(separationDelta>0?"ZOOMING IN":"ZOOMING OUT");setGesture(`Two palms · ${Math.round((1-(state.targetRadius-min)/(max-min))*100)}% in`);
        }else if(Math.abs(angleDelta)>.008){
          state.targetAzimuth+=angleDelta*1.15;setEffect(angleDelta>0?"ROTATING CLOCKWISE":"ROTATING COUNTERCLOCKWISE");setGesture("Two palms · rotating view");
        }
      }
      gestureState.lastSeparation=separation;gestureState.lastAngle=angle;gestureState.trackedHands=2;
      const bothPinch=ordered.every(hand=>hand.pinching);
      if(bothPinch&&now-gestureState.lastPinch>1200){gestureState.lastPinch=now;advanceFocus()}
    }else if(hands.length===1){
      const hand=hands[0];
      if(gestureState.trackedHands===1&&gestureState.lastMidpoint&&hand.gesture==="Open palm"){
        const dragX=hand.palm.x-gestureState.lastMidpoint.x;
        if(Math.abs(dragX)>.004){state.targetAzimuth+=dragX*2.6;setEffect("PANNING VIEW");setGesture("Open palm · dragging view")}
      }
      gestureState.lastMidpoint=hand.palm;gestureState.trackedHands=1;
      if(hand.pinching&&now-gestureState.lastPinch>900){gestureState.lastPinch=now;advanceFocus()}
    }else gestureState.trackedHands=0;
  };

  const drawUniverse=(ctx:CanvasRenderingContext2D,width:number,height:number)=>{
    const t=phase.current,center={x:width*.5,y:height*.52},unit=Math.min(width,height);
    const sky=ctx.createRadialGradient(width*.72,height*.25,0,center.x,center.y,Math.max(width,height));
    sky.addColorStop(0,"#101020");sky.addColorStop(.34,"#03050a");sky.addColorStop(1,"#000104");ctx.fillStyle=sky;ctx.fillRect(0,0,width,height);
    for(let i=0;i<520;i++){const x=((Math.sin(i*91.73)*43758.5453)%1+1)%1*width,y=((Math.sin(i*37.17+8)*24634.6345)%1+1)%1*height,bright=i%43===0,size=bright?1.55:i%9===0?.9:.48,a=bright?.78:.16+(i%7)*.035;ctx.fillStyle=i%17===0?`rgba(178,201,255,${a})`:`rgba(235,239,242,${a})`;ctx.beginPath();ctx.arc(x,y,size,0,Math.PI*2);ctx.fill()}
    const r=unit*.205;
    const singularity=ctx.createRadialGradient(center.x,center.y,1,center.x,center.y,r*.56);
    singularity.addColorStop(0,"#000");singularity.addColorStop(.24,"#000107");singularity.addColorStop(.34,"rgba(229,247,255,.94)");singularity.addColorStop(.42,"rgba(71,139,201,.38)");singularity.addColorStop(1,"rgba(4,9,17,0)");ctx.fillStyle=singularity;ctx.beginPath();ctx.arc(center.x,center.y,r*.58,0,Math.PI*2);ctx.fill();
    ctx.save();ctx.beginPath();ctx.arc(center.x,center.y,r,0,Math.PI*2);ctx.clip();
    const ice=ctx.createRadialGradient(center.x-r*.42,center.y-r*.48,r*.04,center.x+r*.12,center.y+r*.14,r*1.08);ice.addColorStop(0,"#a9bec7");ice.addColorStop(.2,"#4b6170");ice.addColorStop(.58,"#111b26");ice.addColorStop(1,"#02050a");ctx.fillStyle=ice;ctx.fillRect(center.x-r,center.y-r,r*2,r*2);
    ctx.strokeStyle="rgba(122,199,241,.68)";ctx.shadowColor="#4db7f2";ctx.shadowBlur=8;ctx.lineWidth=Math.max(1,r*.009);
    for(let crack=0;crack<19;crack++){const angle=crack*.91+t*.012,start=r*(.22+(crack%4)*.08),end=r*(.62+(crack%3)*.1);ctx.beginPath();ctx.moveTo(center.x+Math.cos(angle)*start,center.y+Math.sin(angle)*start);ctx.lineTo(center.x+Math.cos(angle+.08)*end*.58,center.y+Math.sin(angle+.08)*end*.58);ctx.lineTo(center.x+Math.cos(angle-.04)*end,center.y+Math.sin(angle-.04)*end);ctx.stroke()}
    ctx.restore();ctx.shadowBlur=0;ctx.fillStyle=singularity;ctx.beginPath();ctx.arc(center.x,center.y,r*.58,0,Math.PI*2);ctx.fill();ctx.strokeStyle="rgba(176,215,231,.3)";ctx.lineWidth=1;ctx.beginPath();ctx.arc(center.x,center.y,r,0,Math.PI*2);ctx.stroke();
    for(let fragment=0;fragment<18;fragment++){const angle=t*(fragment%2?-.1:.08)+fragment*.73,distance=r*(1.12+(fragment%5)*.09),x=center.x+Math.cos(angle)*distance,y=center.y+Math.sin(angle)*distance*.43,size=r*(.018+(fragment%4)*.009);ctx.save();ctx.translate(x,y);ctx.rotate(angle*2);ctx.fillStyle=fragment%3?"#293a46":"#6d8794";ctx.beginPath();ctx.moveTo(-size,-size*.3);ctx.lineTo(size*.5,-size);ctx.lineTo(size,size*.45);ctx.lineTo(-size*.35,size);ctx.closePath();ctx.fill();ctx.restore()}
    if(activityNow.current==="gravity"){
      handsNow.current.forEach((hand,index)=>{const x=hand.palm.x*width,y=hand.palm.y*height,well=ctx.createRadialGradient(x,y,2,x,y,unit*.12);well.addColorStop(0,index?"rgba(255,105,218,.85)":"rgba(75,218,255,.85)");well.addColorStop(.3,"rgba(126,71,255,.25)");well.addColorStop(1,"rgba(0,0,0,0)");ctx.fillStyle=well;ctx.beginPath();ctx.arc(x,y,unit*.12,0,Math.PI*2);ctx.fill();for(let n=0;n<4;n++){ctx.strokeStyle=`rgba(190,157,255,${.3-n*.05})`;ctx.beginPath();ctx.ellipse(x,y,unit*(.035+n*.019),unit*(.016+n*.008),t*(index?-.6:.6)+n,0,Math.PI*2);ctx.stroke()}});
    }else if(activityNow.current==="forge"){
      const charge=handsNow.current.filter(hand=>hand.pinching).length/2,forgeR=unit*(.045+charge*.055);
      const forge=ctx.createRadialGradient(center.x,center.y,0,center.x,center.y,forgeR*4);forge.addColorStop(0,"#fff");forge.addColorStop(.12,"#fff4a9");forge.addColorStop(.42,"rgba(255,86,26,.75)");forge.addColorStop(1,"rgba(255,20,5,0)");ctx.fillStyle=forge;ctx.beginPath();ctx.arc(center.x,center.y,forgeR*4,0,Math.PI*2);ctx.fill();
    }else if(activityNow.current==="comets"){
      const hand=handsNow.current[0],cometX=(hand?.point.x??(.5+Math.sin(t)*.22))*width,cometY=(hand?.point.y??.55)*height;
      for(let gate=0;gate<5;gate++){const gx=width*(.14+gate*.18),gy=height*(.38+Math.sin(gate*2.1)*.16);ctx.strokeStyle="rgba(108,225,255,.45)";ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(gx,gy,unit*.032,unit*.075,0,0,Math.PI*2);ctx.stroke()}
      const tail=ctx.createLinearGradient(cometX-110,cometY,cometX,cometY);tail.addColorStop(0,"rgba(79,191,255,0)");tail.addColorStop(1,"rgba(218,249,255,.9)");ctx.strokeStyle=tail;ctx.lineWidth=8;ctx.beginPath();ctx.moveTo(cometX-120,cometY+Math.sin(t*8)*8);ctx.lineTo(cometX,cometY);ctx.stroke();ctx.fillStyle="#fff";ctx.shadowColor="#65dfff";ctx.shadowBlur=24;ctx.beginPath();ctx.arc(cometX,cometY,7,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
    }
    const cards=[{id:"gravity",name:"GRAVITY GARDEN",x:.25},{id:"forge",name:"STAR FORGE",x:.5},{id:"comets",name:"COMET RUN",x:.75}] as const;
    cards.forEach(card=>{const selected=activityNow.current===card.id,x=width*card.x,y=height*.78,w=Math.min(210,width*.2),h=72;ctx.fillStyle=selected?"rgba(139,94,255,.22)":"rgba(8,12,27,.72)";ctx.strokeStyle=selected?"#a57cff":"rgba(139,164,211,.24)";ctx.lineWidth=selected?1.7:1;ctx.beginPath();ctx.roundRect(x-w/2,y-h/2,w,h,14);ctx.fill();ctx.stroke();ctx.fillStyle=selected?"#f2ebff":"#9ba8c7";ctx.font="600 10px Inter, sans-serif";ctx.textAlign="center";ctx.fillText(card.name,x,y+4)});
    ctx.fillStyle="#eee8ff";ctx.font="300 32px Inter, sans-serif";ctx.textAlign="center";ctx.fillText("ORBIT WORLD",center.x,height*.18);
  };
  const drawWorld=()=>{
    const canvas=world.current;if(!canvas)return;const box=canvas.getBoundingClientRect(),ratio=devicePixelRatio;
    if(canvas.width!==Math.floor(box.width*ratio)||canvas.height!==Math.floor(box.height*ratio)){canvas.width=Math.floor(box.width*ratio);canvas.height=Math.floor(box.height*ratio)}
    const ctx=canvas.getContext("2d")!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,box.width,box.height);
    const hands=handsNow.current,state=energy.current;phase.current+=.013;
    if(sceneNow.current==="system")return; // rendered by the 3D <OrbitUniverse> canvas
    if(sceneNow.current==="orbit"&&activityNow.current==="escape"){const{justEnded}=drawEscape(ctx,box.width,box.height,escape.current,phase.current);if(justEnded)handleEscapeEnd();return}
    if(sceneNow.current!=="energy"){drawUniverse(ctx,box.width,box.height);return}
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
      }else if(sceneNow.current==="energy")updateEnergy(detected);
      else updateCamera(detected);
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
      setActive(true);setEffect(sceneNow.current==="system"?"SOLAR SYSTEM":sceneNow.current==="orbit"?"ORBIT WORLD":"ENERGY STABLE");setMessage(mode==="desktop"?"Desktop control active · press Esc or hold both fists to stop":sceneNow.current==="system"?"Rotate with both hands · spread to zoom · pinch to travel":sceneNow.current==="orbit"?"Pinch a world experience to begin":"Pull with two pinches, then clap to burst");
      const loop=async()=>{drawWorld();if(video.current&&tracker.current&&!processing.current&&video.current.readyState>=2){processing.current=true;try{await tracker.current.send({image:video.current})}catch{processing.current=false}}raf.current=requestAnimationFrame(loop)};void loop();
    }catch(error){await stop();setMessage(error instanceof Error?error.message:"Camera permission was denied")}
  };
  useEffect(()=>{const changed=()=>setImmersive(Boolean(document.fullscreenElement));const keydown=(event:KeyboardEvent)=>{if(event.key==="Escape"&&stream.current){void stop();return}if(escapeInputActive()){if(event.key==="ArrowLeft"||event.key.toLowerCase()==="a")steerEscape(-1);if(event.key==="ArrowRight"||event.key.toLowerCase()==="d")steerEscape(1);if(event.code==="Space"){event.preventDefault();dashEscape()}if(event.key==="Enter")startEscape()}};document.addEventListener("fullscreenchange",changed);document.addEventListener("keydown",keydown);drawWorld();return()=>{document.removeEventListener("fullscreenchange",changed);document.removeEventListener("keydown",keydown);void stop()}},[]);

  return <div ref={root} className={`orbit-play ${active?"is-active":""} ${effect==="SUPERNOVA"?"is-bursting":""}`}>
    <canvas className="energy-world" ref={world}/>
    {scene==="system"&&!escapeActive&&<OrbitUniverse camera={camera} onOrbitReadyChange={setOrbitReady}/>}
    {escapeActive&&<OrbitEscapeGame game={escape} onEnded={handleEscapeEnd}/>}
    <video ref={video} muted playsInline aria-hidden="true"/>
    <canvas className="hand-overlay" ref={overlay}/>
    <header><div><small>ORBIT PLAY · REAL SOLAR SYSTEM</small><h1>{scene==="system"?"A real universe in your hands.":scene==="orbit"?"Welcome to Orbit.":"Shape the impossible."}</h1><p>{scene==="system"?"Fly from the Milky Way down to every real planet, and find Orbit at the edge of the system.":scene==="orbit"?"Explore gravity, forge stars, and race comets.":"Move the field. Rotate both hands. Pinch and pull, then clap to release."}</p></div><span className={active?"camera-live":""}>● {active?"CAMERA ACTIVE · LOCAL ONLY":"CAMERA OFF"}</span></header>
    <div className="play-controls">
      <div className="scene-switch"><button className={scene==="system"?"selected":""} onClick={()=>chooseScene("system")}>Solar system</button><button className={scene==="orbit"?"selected":""} onClick={()=>chooseScene("orbit")}>Orbit world</button><button className={scene==="energy"?"selected":""} onClick={()=>chooseScene("energy")}>Energy lab</button></div>
      {scene==="orbit"&&<div className="activity-switch">{(["escape","gravity","forge","comets"] as OrbitActivity[]).map(item=><button key={item} className={activity===item?"selected":""} onClick={()=>{activityNow.current=item;setActivity(item);escape.current.running=false;setEffect(`${item.toUpperCase()} ACTIVE`)}}>{item==="escape"?"Escape":item==="gravity"?"Gravity":item==="forge"?"Forge":"Comets"}</button>)}</div>}
      <div className="mode-switch"><button className={mode==="playground"?"selected":""} disabled={active} onClick={()=>setMode("playground")}>Play</button><button className={mode==="desktop"?"selected":""} disabled={active} onClick={()=>setMode("desktop")}>Desktop</button></div>
      {active?<button className="play-stop" onClick={()=>void stop()}>Stop</button>:<button className="play-start" onClick={()=>void start()}>Enter Orbit Play</button>}
      {scene==="orbit"&&activity==="escape"&&<button className="escape-start" disabled={!active} onClick={startEscape}>{escape.current.over?"Restart":"Launch"}</button>}
      {scene==="system"&&orbitReady&&!escapeActive&&<button className="escape-start" onClick={()=>{setEscapeActive(true);startEscape()}}>Play Orbit Escape</button>}
      {escapeActive&&<button className="play-stop" onClick={()=>{escape.current.running=false;setEscapeActive(false)}}>Exit Escape</button>}
      <button className="play-immersive" onClick={()=>void toggleImmersive()}>{immersive?"Exit full screen":"Full screen"}</button>
    </div>
    <div className="gesture-readout"><small>{effect}</small><b>{gesture}</b><span>{message}</span></div>
    <div className="play-hint">{scene==="energy"?<><span>MOVE TOGETHER</span><i/><span>ROTATE</span><i/><span>PINCH + PULL</span><i/><span>CLAP TO BURST</span></>:scene==="system"?<><span>ROTATE VIEW</span><i/><span>SPREAD TO ZOOM</span><i/><span>PINCH TO ADVANCE</span></>:activity==="escape"?<><span>A / D OR HAND TO STEER</span><i/><span>SPACE OR PINCH TO DASH</span></>:<><span>GRAVITY GARDEN</span><i/><span>STAR FORGE</span><i/><span>COMET RUN</span></>}</div>
    <aside className="play-safety"><b>LOCAL CAMERA</b><span>Only hand landmarks appear; the camera image stays hidden. Frames are never recorded or uploaded. Press Esc or hold both fists for 2 seconds to stop.</span></aside>
  </div>;
}
