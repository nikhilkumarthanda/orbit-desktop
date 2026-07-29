import React, { useEffect, useRef, useState } from "react";
import type { NormalizedLandmark, Results } from "@mediapipe/hands";
import type { OrbitPlayMode } from "../shared/contracts";
import "./orbit-play.css";

type GestureName = "Point"|"Pinch"|"Drag"|"Scroll"|"Open palm"|"Fist";
type PlayScene = "energy"|"system"|"orbit";
type OrbitActivity = "gravity"|"forge"|"comets";
type Point = { x:number;y:number };
type HandState = { landmarks:NormalizedLandmark[];point:Point;palm:Point;gesture:GestureName;pinching:boolean };
type Spark = { angle:number;radius:number;speed:number;size:number;alpha:number;hue:number;burstX:number;burstY:number };
type EnergyState = { center:Point;scale:number;rotation:number;rotationVelocity:number;tension:number;burst:number;burstAt:number;lastSeparation:number;lastSeen:number };
type UniverseState = { yaw:number;zoom:number;targetYaw:number;targetZoom:number;selected:number;portal:number;lastPinch:number;cometScore:number };
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
const planets=[
  {name:"Astra",orbit:.20,size:.018,hue:38,speed:.48},
  {name:"Vesper",orbit:.31,size:.026,hue:194,speed:.34},
  {name:"Orbit",orbit:.44,size:.046,hue:268,speed:.23},
  {name:"Pyra",orbit:.58,size:.033,hue:8,speed:.16},
  {name:"Nox",orbit:.72,size:.024,hue:218,speed:.11},
];

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
  const universe=useRef<UniverseState>({yaw:0,zoom:1,targetYaw:0,targetZoom:1,selected:2,portal:0,lastPinch:0,cometScore:0});
  const sceneNow=useRef<PlayScene>("system"),activityNow=useRef<OrbitActivity>("gravity");
  const [active,setActive]=useState(false),[mode,setMode]=useState<OrbitPlayMode>("playground"),[gesture,setGesture]=useState("Waiting for hands"),[message,setMessage]=useState("Camera off · all tracking is local"),[immersive,setImmersive]=useState(false),[effect,setEffect]=useState("IDLE");
  const [scene,setScene]=useState<PlayScene>("system"),[activity,setActivity]=useState<OrbitActivity>("gravity");

  const chooseScene=(next:PlayScene)=>{
    sceneNow.current=next;setScene(next);setEffect(next==="system"?"CELESTIAL NAVIGATION":next==="orbit"?"ORBIT WORLD":"ENERGY STABLE");
    setMessage(next==="system"?"Rotate with both hands · pinch a planet to visit":next==="orbit"?"Choose an experience inside Orbit":"Pull with two pinches, then clap to burst");
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
  const updateUniverse=(hands:HandState[])=>{
    const state=universe.current,now=performance.now();
    if(hands.length===2){
      const ordered=[...hands].sort((a,b)=>a.palm.x-b.palm.x);
      const dx=ordered[1].palm.x-ordered[0].palm.x,dy=ordered[1].palm.y-ordered[0].palm.y;
      const separation=Math.hypot(dx,dy),angle=Math.atan2(dy,dx);
      state.targetYaw+=clamp(angle,-.7,.7)*.035;
      state.targetZoom=clamp(.62+separation*1.45,.72,1.62);
      const bothPinch=ordered.every(hand=>hand.pinching);
      if(bothPinch&&now-state.lastPinch>1200){
        state.lastPinch=now;
        if(sceneNow.current==="system"&&state.selected===2){state.portal=1;chooseScene("orbit")}
        else if(sceneNow.current==="system"){setEffect(`${planets[state.selected].name.toUpperCase()} LOCKED`);setMessage("Orbit is the inhabited world · rotate to select it")}
      }
    }else if(hands.length===1){
      const hand=hands[0];
      state.targetYaw+=(hand.palm.x-.5)*.018;
      if(hand.pinching&&now-state.lastPinch>900){
        state.lastPinch=now;
        if(sceneNow.current==="system"&&state.selected===2){state.portal=1;chooseScene("orbit")}
        else if(sceneNow.current==="orbit"){
          const index=clamp(Math.floor(hand.point.x*3),0,2);
          const next=(["gravity","forge","comets"] as OrbitActivity[])[index];
          activityNow.current=next;setActivity(next);setEffect(`${next.toUpperCase()} ACTIVE`);
          setMessage(next==="gravity"?"Move both hands to bend the gravity wells":next==="forge"?"Pinch and pull to forge a new star":"Guide the comet through the orbital gates");
        }
      }
    }
    state.yaw=mix(state.yaw,state.targetYaw,.055);state.zoom=mix(state.zoom,state.targetZoom,.065);
    state.selected=((Math.round((-state.yaw)/(Math.PI*.36))%planets.length)+planets.length)%planets.length;
  };

  const drawUniverse=(ctx:CanvasRenderingContext2D,width:number,height:number)=>{
    const state=universe.current,t=phase.current,center={x:width*.5,y:height*.52},unit=Math.min(width,height);
    state.yaw=mix(state.yaw,state.targetYaw,.045);state.zoom=mix(state.zoom,state.targetZoom,.05);
    const sky=ctx.createRadialGradient(center.x,center.y,0,center.x,center.y,unit*.85);
    sky.addColorStop(0,scene==="orbit"?"#160b35":"#091731");sky.addColorStop(.45,"#030713");sky.addColorStop(1,"#010207");ctx.fillStyle=sky;ctx.fillRect(0,0,width,height);
    for(let i=0;i<190;i++){const x=(Math.sin(i*91.73)*.5+.5)*width,y=(Math.sin(i*37.17+8)*.5+.5)*height,a=.15+(i%7)*.07;ctx.fillStyle=`rgba(190,220,255,${a})`;ctx.fillRect(x,y,i%11===0?1.7:1,i%11===0?1.7:1)}
    if(sceneNow.current==="system"){
      const sunRadius=unit*.075*state.zoom,glow=ctx.createRadialGradient(center.x,center.y,0,center.x,center.y,sunRadius*4);
      glow.addColorStop(0,"rgba(255,250,205,1)");glow.addColorStop(.2,"rgba(255,166,57,.72)");glow.addColorStop(1,"rgba(255,90,12,0)");ctx.fillStyle=glow;ctx.beginPath();ctx.arc(center.x,center.y,sunRadius*4,0,Math.PI*2);ctx.fill();
      planets.forEach((planet,index)=>{
        const orbit=unit*planet.orbit*state.zoom;
        ctx.strokeStyle=index===state.selected?"rgba(165,119,255,.42)":"rgba(119,162,219,.12)";ctx.lineWidth=index===state.selected?1.5:1;ctx.beginPath();ctx.ellipse(center.x,center.y,orbit,orbit*.34,0,0,Math.PI*2);ctx.stroke();
        const angle=t*planet.speed+index*1.37+state.yaw,x=center.x+Math.cos(angle)*orbit,y=center.y+Math.sin(angle)*orbit*.34;
        const radius=unit*planet.size*(index===state.selected?1.16:1),planetGlow=ctx.createRadialGradient(x-radius*.3,y-radius*.35,1,x,y,radius*2.8);
        planetGlow.addColorStop(0,"#fff");planetGlow.addColorStop(.16,`hsl(${planet.hue} 88% 72%)`);planetGlow.addColorStop(.48,`hsl(${planet.hue} 72% 35%)`);planetGlow.addColorStop(1,`hsl(${planet.hue} 80% 20% / 0)`);
        ctx.fillStyle=planetGlow;ctx.beginPath();ctx.arc(x,y,radius*2.8,0,Math.PI*2);ctx.fill();
        if(index===2){ctx.strokeStyle="rgba(206,174,255,.75)";ctx.lineWidth=1.2;ctx.beginPath();ctx.ellipse(x,y,radius*1.8,radius*.55,-.3,0,Math.PI*2);ctx.stroke()}
        if(index===state.selected){ctx.fillStyle="#f2efff";ctx.font="600 11px Inter, sans-serif";ctx.textAlign="center";ctx.fillText(planet.name.toUpperCase(),x,y-radius*2.2)}
      });
      ctx.fillStyle="rgba(222,229,255,.7)";ctx.font="500 10px Inter, sans-serif";ctx.textAlign="center";ctx.fillText("ROTATE THE SYSTEM  ·  PINCH ORBIT TO ENTER",center.x,height-62);
    }else{
      state.portal*=.94;
      const r=unit*(.22+state.portal*.6),world=ctx.createRadialGradient(center.x-r*.25,center.y-r*.3,2,center.x,center.y,r);
      world.addColorStop(0,"#fff");world.addColorStop(.1,"#cbb7ff");world.addColorStop(.37,"#7449d8");world.addColorStop(.7,"#231258");world.addColorStop(1,"rgba(15,5,40,0)");
      ctx.fillStyle=world;ctx.beginPath();ctx.arc(center.x,center.y,r,0,Math.PI*2);ctx.fill();
      for(let ring=0;ring<5;ring++){ctx.save();ctx.translate(center.x,center.y);ctx.rotate(t*(.18+ring*.05)+ring);ctx.scale(1,.35);ctx.strokeStyle=`rgba(${135+ring*18},${85+ring*14},255,${.38-ring*.045})`;ctx.lineWidth=1.4;ctx.beginPath();ctx.arc(0,0,r*(1.08+ring*.09),0,Math.PI*2);ctx.stroke();ctx.restore()}
      if(activityNow.current==="gravity"){
        handsNow.current.forEach((hand,index)=>{const x=hand.palm.x*width,y=hand.palm.y*height,well=ctx.createRadialGradient(x,y,2,x,y,unit*.12);well.addColorStop(0,index?"rgba(255,105,218,.85)":"rgba(75,218,255,.85)");well.addColorStop(.3,"rgba(126,71,255,.25)");well.addColorStop(1,"rgba(0,0,0,0)");ctx.fillStyle=well;ctx.beginPath();ctx.arc(x,y,unit*.12,0,Math.PI*2);ctx.fill();for(let n=0;n<4;n++){ctx.strokeStyle=`rgba(190,157,255,${.3-n*.05})`;ctx.beginPath();ctx.ellipse(x,y,unit*(.035+n*.019),unit*(.016+n*.008),t*(index?-.6:.6)+n,0,Math.PI*2);ctx.stroke()}});
      }else if(activityNow.current==="forge"){
        const charge=handsNow.current.filter(hand=>hand.pinching).length/2,forgeR=unit*(.045+charge*.055);
        const forge=ctx.createRadialGradient(center.x,center.y,0,center.x,center.y,forgeR*4);forge.addColorStop(0,"#fff");forge.addColorStop(.12,"#fff4a9");forge.addColorStop(.42,"rgba(255,86,26,.75)");forge.addColorStop(1,"rgba(255,20,5,0)");ctx.fillStyle=forge;ctx.beginPath();ctx.arc(center.x,center.y,forgeR*4,0,Math.PI*2);ctx.fill();
      }else{
        const hand=handsNow.current[0],cometX=(hand?.point.x??(.5+Math.sin(t)*.22))*width,cometY=(hand?.point.y??.55)*height;
        for(let gate=0;gate<5;gate++){const gx=width*(.14+gate*.18),gy=height*(.38+Math.sin(gate*2.1)*.16);ctx.strokeStyle="rgba(108,225,255,.45)";ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(gx,gy,unit*.032,unit*.075,0,0,Math.PI*2);ctx.stroke()}
        const tail=ctx.createLinearGradient(cometX-110,cometY,cometX,cometY);tail.addColorStop(0,"rgba(79,191,255,0)");tail.addColorStop(1,"rgba(218,249,255,.9)");ctx.strokeStyle=tail;ctx.lineWidth=8;ctx.beginPath();ctx.moveTo(cometX-120,cometY+Math.sin(t*8)*8);ctx.lineTo(cometX,cometY);ctx.stroke();ctx.fillStyle="#fff";ctx.shadowColor="#65dfff";ctx.shadowBlur=24;ctx.beginPath();ctx.arc(cometX,cometY,7,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
      }
      const cards=[{id:"gravity",name:"GRAVITY GARDEN",x:.25},{id:"forge",name:"STAR FORGE",x:.5},{id:"comets",name:"COMET RUN",x:.75}] as const;
      cards.forEach(card=>{const selected=activityNow.current===card.id,x=width*card.x,y=height*.78,w=Math.min(210,width*.2),h=72;ctx.fillStyle=selected?"rgba(139,94,255,.22)":"rgba(8,12,27,.72)";ctx.strokeStyle=selected?"#a57cff":"rgba(139,164,211,.24)";ctx.lineWidth=selected?1.7:1;ctx.beginPath();ctx.roundRect(x-w/2,y-h/2,w,h,14);ctx.fill();ctx.stroke();ctx.fillStyle=selected?"#f2ebff":"#9ba8c7";ctx.font="600 10px Inter, sans-serif";ctx.textAlign="center";ctx.fillText(card.name,x,y+4)});
      ctx.fillStyle="#eee8ff";ctx.font="300 32px Inter, sans-serif";ctx.textAlign="center";ctx.fillText("ORBIT WORLD",center.x,height*.18);
    }
  };
  const drawWorld=()=>{
    const canvas=world.current;if(!canvas)return;const box=canvas.getBoundingClientRect(),ratio=devicePixelRatio;
    if(canvas.width!==Math.floor(box.width*ratio)||canvas.height!==Math.floor(box.height*ratio)){canvas.width=Math.floor(box.width*ratio);canvas.height=Math.floor(box.height*ratio)}
    const ctx=canvas.getContext("2d")!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,box.width,box.height);
    const hands=handsNow.current,state=energy.current;phase.current+=.013;
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
      const previous=[...handsNow.current].sort((a,b)=>a.palm.x-b.palm.x);
      const detected=landmarks.map(lm=>{const palm=palmPoint(lm);const prior=previous.reduce<HandState|undefined>((best,item)=>!best||Math.abs(item.palm.x-palm.x)<Math.abs(best.palm.x-palm.x)?item:best,undefined);const smoothLm=lm.map((p,i)=>prior?{...p,x:mix(prior.landmarks[i].x,p.x,.38),y:mix(prior.landmarks[i].y,p.y,.38),z:mix(prior.landmarks[i].z,p.z,.38)}:p);const next=classify(smoothLm,pinching.current);return {landmarks:smoothLm,point:{x:smoothLm[8].x,y:smoothLm[8].y},palm:palmPoint(smoothLm),gesture:next,pinching:next==="Pinch"||next==="Drag"}});
      handsNow.current=detected;if(sceneNow.current==="energy")updateEnergy(detected);else updateUniverse(detected);
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
      setActive(true);setEffect(sceneNow.current==="system"?"CELESTIAL NAVIGATION":sceneNow.current==="orbit"?"ORBIT WORLD":"ENERGY STABLE");setMessage(mode==="desktop"?"Desktop control active · press Esc or hold both fists to stop":sceneNow.current==="system"?"Rotate with both hands · pinch Orbit to visit":sceneNow.current==="orbit"?"Pinch a world experience to begin":"Pull with two pinches, then clap to burst");
      const loop=async()=>{drawWorld();if(video.current&&tracker.current&&!processing.current&&video.current.readyState>=2){processing.current=true;try{await tracker.current.send({image:video.current})}catch{processing.current=false}}raf.current=requestAnimationFrame(loop)};void loop();
    }catch(error){await stop();setMessage(error instanceof Error?error.message:"Camera permission was denied")}
  };
  useEffect(()=>{const changed=()=>setImmersive(Boolean(document.fullscreenElement));const keydown=(event:KeyboardEvent)=>{if(event.key==="Escape"&&stream.current)void stop()};document.addEventListener("fullscreenchange",changed);document.addEventListener("keydown",keydown);drawWorld();return()=>{document.removeEventListener("fullscreenchange",changed);document.removeEventListener("keydown",keydown);void stop()}},[]);

  return <div ref={root} className={`orbit-play ${active?"is-active":""} ${effect==="SUPERNOVA"?"is-bursting":""}`}>
    <canvas className="energy-world" ref={world}/>
    <video ref={video} muted playsInline aria-hidden="true"/>
    <canvas className="hand-overlay" ref={overlay}/>
    <div className="play-vignette"/><div className="play-grain"/>
    <header><div><small>ORBIT PLAY · PHASE 10 UNIVERSE</small><h1>{scene==="system"?"A universe in your hands.":scene==="orbit"?"Welcome to Orbit.":"Shape the impossible."}</h1><p>{scene==="system"?"Rotate, zoom, select planets, and enter Orbit World.":scene==="orbit"?"Explore gravity, forge stars, and race comets.":"Move the field. Rotate both hands. Pinch and pull, then clap to release."}</p></div><span className={active?"camera-live":""}>● {active?"CAMERA ACTIVE · LOCAL ONLY":"CAMERA OFF"}</span></header>
    <div className="play-controls">
      <div className="scene-switch"><button className={scene==="system"?"selected":""} onClick={()=>chooseScene("system")}>Solar system</button><button className={scene==="orbit"?"selected":""} onClick={()=>chooseScene("orbit")}>Orbit world</button><button className={scene==="energy"?"selected":""} onClick={()=>chooseScene("energy")}>Energy lab</button></div>
      {scene==="orbit"&&<div className="activity-switch">{(["gravity","forge","comets"] as OrbitActivity[]).map(item=><button key={item} className={activity===item?"selected":""} onClick={()=>{activityNow.current=item;setActivity(item);setEffect(`${item.toUpperCase()} ACTIVE`)}}>{item==="gravity"?"Gravity":item==="forge"?"Forge":"Comets"}</button>)}</div>}
      <div className="mode-switch"><button className={mode==="playground"?"selected":""} disabled={active} onClick={()=>setMode("playground")}>Play</button><button className={mode==="desktop"?"selected":""} disabled={active} onClick={()=>setMode("desktop")}>Desktop</button></div>
      {active?<button className="play-stop" onClick={()=>void stop()}>Stop</button>:<button className="play-start" onClick={()=>void start()}>Enter Orbit Play</button>}
      <button className="play-immersive" onClick={()=>void toggleImmersive()}>{immersive?"Exit full screen":"Full screen"}</button>
    </div>
    <div className="gesture-readout"><small>{effect}</small><b>{gesture}</b><span>{message}</span></div>
    <div className="play-hint">{scene==="energy"?<><span>MOVE TOGETHER</span><i/><span>ROTATE</span><i/><span>PINCH + PULL</span><i/><span>CLAP TO BURST</span></>:scene==="system"?<><span>ROTATE SYSTEM</span><i/><span>SPREAD TO ZOOM</span><i/><span>PINCH TO VISIT</span></>:<><span>GRAVITY GARDEN</span><i/><span>STAR FORGE</span><i/><span>COMET RUN</span></>}</div>
    <aside className="play-safety"><b>LOCAL CAMERA</b><span>Only hand landmarks appear; the camera image stays hidden. Frames are never recorded or uploaded. Press Esc or hold both fists for 2 seconds to stop.</span></aside>
  </div>;
}
