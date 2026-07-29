import React, { useEffect, useRef, useState } from "react";
import type { NormalizedLandmark, Results } from "@mediapipe/hands";
import type { OrbitPlayMode } from "../shared/contracts";
import "./orbit-play.css";

type GestureName = "Point"|"Pinch"|"Drag"|"Scroll"|"Open palm"|"Fist";
type PlayScene = "energy"|"system"|"orbit";
type OrbitActivity = "escape"|"gravity"|"forge"|"comets";
type Point = { x:number;y:number };
type HandState = { landmarks:NormalizedLandmark[];point:Point;palm:Point;gesture:GestureName;pinching:boolean };
type Spark = { angle:number;radius:number;speed:number;size:number;alpha:number;hue:number;burstX:number;burstY:number };
type EnergyState = { center:Point;scale:number;rotation:number;rotationVelocity:number;tension:number;burst:number;burstAt:number;lastSeparation:number;lastSeen:number };
type UniverseState = { yaw:number;zoom:number;targetYaw:number;targetZoom:number;selected:number;portal:number;lastPinch:number;cometScore:number;lastSeparation:number;lastAngle:number;lastMidpoint:Point|null;trackedHands:number };
type EscapeObstacle = { lane:number;z:number;kind:"ice"|"debris"|"rift";passed:boolean };
type EscapeState = { running:boolean;over:boolean;lane:number;targetLane:number;distance:number;score:number;best:number;speed:number;multiplier:number;dash:number;obstacles:EscapeObstacle[];lastSpawn:number };
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
  {name:"Astra",orbit:.20,size:.016,speed:.48,kind:"rock",day:"#b99a72",night:"#160f0b"},
  {name:"Vesper",orbit:.31,size:.023,speed:.34,kind:"ocean",day:"#4f8ea6",night:"#07121c"},
  {name:"Orbit",orbit:.44,size:.041,speed:.23,kind:"orbit",day:"#7786a8",night:"#090b18"},
  {name:"Pyra",orbit:.58,size:.030,speed:.16,kind:"gas",day:"#b3704e",night:"#1d0a08"},
  {name:"Nox",orbit:.72,size:.022,speed:.11,kind:"ice",day:"#91aab4",night:"#0a1017"},
] as const;

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
  const universe=useRef<UniverseState>({yaw:0,zoom:1,targetYaw:0,targetZoom:1,selected:2,portal:0,lastPinch:0,cometScore:0,lastSeparation:0,lastAngle:0,lastMidpoint:null,trackedHands:0});
  const escape=useRef<EscapeState>({running:false,over:false,lane:0,targetLane:0,distance:0,score:0,best:Number(localStorage.getItem("orbit-escape-best")??0),speed:.006,multiplier:1,dash:1,obstacles:[],lastSpawn:0});
  const sceneNow=useRef<PlayScene>("system"),activityNow=useRef<OrbitActivity>("escape");
  const [active,setActive]=useState(false),[mode,setMode]=useState<OrbitPlayMode>("playground"),[gesture,setGesture]=useState("Waiting for hands"),[message,setMessage]=useState("Camera off · all tracking is local"),[immersive,setImmersive]=useState(false),[effect,setEffect]=useState("IDLE");
  const [scene,setScene]=useState<PlayScene>("system"),[activity,setActivity]=useState<OrbitActivity>("escape");

  const startEscape=()=>{
    escape.current={...escape.current,running:true,over:false,lane:0,targetLane:0,distance:0,score:0,speed:.006,multiplier:1,dash:1,obstacles:[],lastSpawn:0};
    setEffect("ORBIT ESCAPE");setGesture("Run started");setMessage("Steer with A/D or your hand · Space to phase dash");
  };
  const steerEscape=(direction:-1|1)=>{const game=escape.current;if(game.running)game.targetLane=clamp(game.targetLane+direction,-1,1)};
  const dashEscape=()=>{const game=escape.current;if(game.running&&game.dash>=1){game.dash=0;setEffect("PHASE DASH")}};

  const chooseScene=(next:PlayScene)=>{
    sceneNow.current=next;setScene(next);setEffect(next==="system"?"CELESTIAL NAVIGATION":next==="orbit"?"ORBIT WORLD":"ENERGY STABLE");
    if(next!=="orbit")escape.current.running=false;
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
      const separation=Math.hypot(dx,dy),angle=Math.atan2(dy,dx),bothOpen=ordered.every(hand=>hand.gesture==="Open palm");
      if(state.trackedHands===2&&bothOpen){
        const separationDelta=separation-state.lastSeparation;
        let angleDelta=angle-state.lastAngle;while(angleDelta>Math.PI)angleDelta-=Math.PI*2;while(angleDelta<-Math.PI)angleDelta+=Math.PI*2;
        if(Math.abs(separationDelta)>.003){
          state.targetZoom=clamp(state.targetZoom+separationDelta*3.8,.52,2.25);
          setEffect(separationDelta>0?"ZOOMING IN":"ZOOMING OUT");setGesture(`Two palms · ${Math.round(state.targetZoom*100)}%`);
        }else if(Math.abs(angleDelta)>.008){
          state.targetYaw+=angleDelta*1.15;setEffect(angleDelta>0?"ROTATING CLOCKWISE":"ROTATING COUNTERCLOCKWISE");setGesture("Two palms · rotating system");
        }
      }
      state.lastSeparation=separation;state.lastAngle=angle;state.trackedHands=2;
      const bothPinch=ordered.every(hand=>hand.pinching);
      if(bothPinch&&now-state.lastPinch>1200){
        state.lastPinch=now;
        if(sceneNow.current==="system"&&state.selected===2){state.portal=1;chooseScene("orbit")}
        else if(sceneNow.current==="system"){setEffect(`${planets[state.selected].name.toUpperCase()} LOCKED`);setMessage("Orbit is the inhabited world · rotate to select it")}
      }
    }else if(hands.length===1){
      const hand=hands[0];
      if(sceneNow.current==="orbit"&&activityNow.current==="escape"&&escape.current.running){
        escape.current.targetLane=hand.palm.x<.38?-1:hand.palm.x>.62?1:0;
        if(hand.pinching)dashEscape();
        state.lastMidpoint=hand.palm;state.trackedHands=1;
        return;
      }
      if(state.trackedHands===1&&state.lastMidpoint&&hand.gesture==="Open palm"){
        const dragX=hand.palm.x-state.lastMidpoint.x;
        if(Math.abs(dragX)>.004){state.targetYaw+=dragX*2.6;setEffect("PANNING SYSTEM");setGesture("Open palm · dragging orbit")}
      }
      state.lastMidpoint=hand.palm;state.trackedHands=1;
      if(hand.pinching&&now-state.lastPinch>900){
        state.lastPinch=now;
        if(sceneNow.current==="system"&&state.selected===2){state.portal=1;chooseScene("orbit")}
        else if(sceneNow.current==="orbit"){
          if(activityNow.current==="escape"&&escape.current.running){
            escape.current.targetLane=hand.palm.x<.38?-1:hand.palm.x>.62?1:0;
            dashEscape();
            return;
          }
          const index=clamp(Math.floor(hand.point.x*4),0,3);
          const next=(["escape","gravity","forge","comets"] as OrbitActivity[])[index];
          activityNow.current=next;setActivity(next);setEffect(`${next.toUpperCase()} ACTIVE`);
          setMessage(next==="escape"?"Start a run · steer with one hand and pinch to dash":next==="gravity"?"Move both hands to bend the gravity wells":next==="forge"?"Pinch and pull to forge a new star":"Guide the comet through the orbital gates");
        }
      }
    }else state.trackedHands=0;
    state.yaw=mix(state.yaw,state.targetYaw,.11);state.zoom=mix(state.zoom,state.targetZoom,.14);
    state.selected=((Math.round((-state.yaw)/(Math.PI*.36))%planets.length)+planets.length)%planets.length;
  };

  const drawEscape=(ctx:CanvasRenderingContext2D,width:number,height:number)=>{
    const game=escape.current,t=phase.current,horizon=height*.29,roadBottom=height*1.04,centerX=width*.5;
    const bg=ctx.createLinearGradient(0,0,0,height);bg.addColorStop(0,"#01030a");bg.addColorStop(.48,"#07101a");bg.addColorStop(1,"#020407");ctx.fillStyle=bg;ctx.fillRect(0,0,width,height);
    for(let i=0;i<360;i++){const x=((Math.sin(i*73.37)*27183.17)%1+1)%1*width,y=((Math.sin(i*41.71)*13731.91)%1+1)%1*horizon*.95;ctx.fillStyle=`rgba(220,235,255,${.16+(i%13===0?.55:0)})`;ctx.fillRect(x,y,i%13===0?1.4:.55,i%13===0?1.4:.55)}
    const anomaly=ctx.createRadialGradient(width*.78,height*.14,2,width*.78,height*.14,width*.22);anomaly.addColorStop(0,"#000");anomaly.addColorStop(.12,"#020207");anomaly.addColorStop(.16,"rgba(178,211,255,.78)");anomaly.addColorStop(.2,"rgba(43,91,155,.2)");anomaly.addColorStop(1,"rgba(0,0,0,0)");ctx.fillStyle=anomaly;ctx.fillRect(0,0,width,height*.55);
    ctx.fillStyle="#080d14";ctx.beginPath();ctx.moveTo(0,height);ctx.lineTo(width*.34,horizon);ctx.lineTo(width*.66,horizon);ctx.lineTo(width,height);ctx.closePath();ctx.fill();
    for(let line=-1;line<=1;line++){ctx.strokeStyle="rgba(111,161,202,.16)";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(centerX+line*width*.055,horizon);ctx.lineTo(centerX+line*width*.28,roadBottom);ctx.stroke()}
    if(game.running){
      game.speed=Math.min(.018,game.speed+.0000022);game.distance+=game.speed;game.score+=game.speed*125*game.multiplier;game.dash=Math.min(1,game.dash+.0018);
      if(game.distance-game.lastSpawn>.19){game.lastSpawn=game.distance;const lane=([-1,0,1] as const)[Math.floor(Math.random()*3)];game.obstacles.push({lane,z:1,kind:(["ice","debris","rift"] as const)[Math.floor(Math.random()*3)],passed:false})}
      game.lane=mix(game.lane,game.targetLane,.13);
      game.obstacles.forEach(obstacle=>{obstacle.z-=game.speed*(game.dash<.22?1.9:1)});
      const collision=game.obstacles.find(item=>!item.passed&&item.z<.115&&item.z>.025&&Math.abs(item.lane-game.lane)<.42);
      if(collision&&game.dash>.22){game.running=false;game.over=true;game.best=Math.max(game.best,Math.floor(game.score));localStorage.setItem("orbit-escape-best",String(game.best));setEffect("RUN ENDED");setMessage("Press Enter or click Restart · beat your best")}
      game.obstacles.forEach(item=>{if(!item.passed&&item.z<=.02){item.passed=true;game.multiplier=Math.min(8,game.multiplier+.25)}});
      game.obstacles=game.obstacles.filter(item=>item.z>-.2);
    }
    const project=(lane:number,z:number)=>{const depth=1-clamp(z,0,1),spread=width*(.055+depth*.225);return{x:centerX+lane*spread,y:horizon+(roadBottom-horizon)*depth,scale:.1+depth*1.22}};
    game.obstacles.slice().sort((a,b)=>b.z-a.z).forEach(item=>{const p=project(item.lane,item.z),r=22*p.scale;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(t*(item.kind==="debris"?.7:.18)+item.lane);ctx.shadowColor=item.kind==="rift"?"#509cff":"#8db9d1";ctx.shadowBlur=item.kind==="rift"?22:7;if(item.kind==="rift"){ctx.strokeStyle="rgba(102,170,255,.85)";ctx.lineWidth=5*p.scale;ctx.beginPath();ctx.ellipse(0,0,r*.6,r*1.35,0,0,Math.PI*2);ctx.stroke()}else{ctx.fillStyle=item.kind==="ice"?"#7692a4":"#343b43";ctx.strokeStyle="#b6d4df";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(-r,-r*.55);ctx.lineTo(r*.52,-r);ctx.lineTo(r,r*.4);ctx.lineTo(0,r);ctx.lineTo(-r*.75,r*.35);ctx.closePath();ctx.fill();ctx.stroke()}ctx.restore()});
    const shipX=centerX+game.lane*width*.28,shipY=height*.81,shipScale=Math.min(width,height)/780;ctx.save();ctx.translate(shipX,shipY);ctx.scale(shipScale,shipScale);ctx.shadowColor=game.dash<.22?"#d9f6ff":"#5fcaff";ctx.shadowBlur=game.dash<.22?38:16;ctx.fillStyle="#c7d2d8";ctx.beginPath();ctx.moveTo(0,-31);ctx.lineTo(24,21);ctx.lineTo(7,14);ctx.lineTo(0,28);ctx.lineTo(-7,14);ctx.lineTo(-24,21);ctx.closePath();ctx.fill();ctx.fillStyle=game.dash<.22?"#fff":"#62cfff";ctx.beginPath();ctx.moveTo(-7,19);ctx.lineTo(0,48+(game.dash<.22?35:0));ctx.lineTo(7,19);ctx.fill();ctx.restore();
    ctx.fillStyle="#eef6fb";ctx.font="600 12px Inter, sans-serif";ctx.textAlign="left";ctx.fillText(`SCORE  ${Math.floor(game.score).toString().padStart(6,"0")}`,32,42);ctx.fillStyle="#81909d";ctx.fillText(`BEST  ${game.best.toString().padStart(6,"0")}`,32,62);ctx.textAlign="right";ctx.fillStyle="#d7e8f2";ctx.fillText(`× ${game.multiplier.toFixed(2)}`,width-32,42);ctx.fillStyle="rgba(115,191,231,.25)";ctx.fillRect(width-152,54,120,3);ctx.fillStyle="#8edcff";ctx.fillRect(width-152,54,120*game.dash,3);
    if(!game.running){ctx.textAlign="center";ctx.fillStyle="#f3f7fa";ctx.font="300 34px Inter, sans-serif";ctx.fillText(game.over?"SIGNAL LOST":"ORBIT ESCAPE",centerX,height*.42);ctx.fillStyle="#94a6b2";ctx.font="500 11px Inter, sans-serif";ctx.fillText(game.over?"ENTER TO RUN AGAIN":"A / D TO STEER  ·  SPACE TO PHASE DASH",centerX,height*.42+28)}
  };

  const drawUniverse=(ctx:CanvasRenderingContext2D,width:number,height:number)=>{
    const state=universe.current,t=phase.current,center={x:width*.5,y:height*.52},unit=Math.min(width,height);
    state.yaw=mix(state.yaw,state.targetYaw,.045);state.zoom=mix(state.zoom,state.targetZoom,.05);
    const sky=ctx.createRadialGradient(width*.72,height*.25,0,center.x,center.y,Math.max(width,height));
    sky.addColorStop(0,scene==="orbit"?"#101020":"#090d17");sky.addColorStop(.34,"#03050a");sky.addColorStop(1,"#000104");ctx.fillStyle=sky;ctx.fillRect(0,0,width,height);
    for(let i=0;i<520;i++){const x=((Math.sin(i*91.73)*43758.5453)%1+1)%1*width,y=((Math.sin(i*37.17+8)*24634.6345)%1+1)%1*height,bright=i%43===0,size=bright?1.55:i%9===0?.9:.48,a=bright?.78:.16+(i%7)*.035;ctx.fillStyle=i%17===0?`rgba(178,201,255,${a})`:`rgba(235,239,242,${a})`;ctx.beginPath();ctx.arc(x,y,size,0,Math.PI*2);ctx.fill()}
    if(sceneNow.current==="system"){
      const sunRadius=unit*.062*state.zoom,glow=ctx.createRadialGradient(center.x,center.y,sunRadius*.45,center.x,center.y,sunRadius*5.4);
      glow.addColorStop(0,"rgba(255,244,203,.98)");glow.addColorStop(.12,"rgba(255,190,92,.62)");glow.addColorStop(.42,"rgba(218,82,19,.16)");glow.addColorStop(1,"rgba(255,90,12,0)");ctx.fillStyle=glow;ctx.beginPath();ctx.arc(center.x,center.y,sunRadius*5.4,0,Math.PI*2);ctx.fill();
      const sun=ctx.createRadialGradient(center.x-sunRadius*.28,center.y-sunRadius*.3,2,center.x,center.y,sunRadius);sun.addColorStop(0,"#fffdf1");sun.addColorStop(.26,"#ffe5a3");sun.addColorStop(.72,"#f39735");sun.addColorStop(1,"#a83b0e");ctx.fillStyle=sun;ctx.beginPath();ctx.arc(center.x,center.y,sunRadius,0,Math.PI*2);ctx.fill();
      planets.forEach((planet,index)=>{
        const orbit=unit*planet.orbit*state.zoom;
        ctx.strokeStyle=index===state.selected?"rgba(190,200,224,.3)":"rgba(160,174,195,.09)";ctx.lineWidth=index===state.selected?1.15:.65;ctx.beginPath();ctx.ellipse(center.x,center.y,orbit,orbit*.34,0,0,Math.PI*2);ctx.stroke();
        const angle=t*planet.speed+index*1.37+state.yaw,x=center.x+Math.cos(angle)*orbit,y=center.y+Math.sin(angle)*orbit*.34;
        const radius=unit*planet.size*(index===state.selected?1.12:1);
        ctx.save();ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.clip();
        const surface=ctx.createRadialGradient(x-radius*.36,y-radius*.42,radius*.06,x+radius*.2,y+radius*.12,radius*1.12);surface.addColorStop(0,"#edf0e7");surface.addColorStop(.16,planet.day);surface.addColorStop(.68,planet.day);surface.addColorStop(1,planet.night);ctx.fillStyle=surface;ctx.fillRect(x-radius,y-radius,radius*2,radius*2);
        ctx.globalAlpha=.42;
        for(let band=0;band<7;band++){const yy=y-radius+((band+1)/8)*radius*2+Math.sin(t*.2+band)*radius*.04;ctx.strokeStyle=planet.kind==="gas"?(band%2?"#e2a47b":"#633a31"):planet.kind==="ocean"?(band%2?"#d7e0d1":"#183d4a"):planet.kind==="orbit"?(band%2?"#c1c6ba":"#252d48"):"#5e534c";ctx.lineWidth=Math.max(.6,radius*(planet.kind==="gas"?.11:.035));ctx.beginPath();ctx.moveTo(x-radius,yy);ctx.bezierCurveTo(x-radius*.4,yy-radius*.13,x+radius*.3,yy+radius*.11,x+radius,yy);ctx.stroke()}
        ctx.restore();ctx.strokeStyle="rgba(216,226,237,.25)";ctx.lineWidth=.65;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.stroke();
        if(index===2){ctx.save();ctx.translate(x,y);ctx.rotate(-.24);ctx.scale(1,.28);ctx.strokeStyle="rgba(185,177,166,.62)";ctx.lineWidth=Math.max(1.4,radius*.12);ctx.beginPath();ctx.arc(0,0,radius*1.62,0,Math.PI*2);ctx.stroke();ctx.restore()}
        if(index===state.selected){ctx.fillStyle="#f2efff";ctx.font="600 11px Inter, sans-serif";ctx.textAlign="center";ctx.fillText(planet.name.toUpperCase(),x,y-radius*2.2)}
      });
      ctx.fillStyle="rgba(222,229,255,.7)";ctx.font="500 10px Inter, sans-serif";ctx.textAlign="center";ctx.fillText("ROTATE THE SYSTEM  ·  PINCH ORBIT TO ENTER",center.x,height-62);
    }else{
      state.portal*=.94;
      const r=unit*(.205+state.portal*.6),singularity=ctx.createRadialGradient(center.x,center.y,1,center.x,center.y,r*.56);
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
    if(sceneNow.current==="orbit"&&activityNow.current==="escape"){drawEscape(ctx,box.width,box.height);return}
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
  useEffect(()=>{const changed=()=>setImmersive(Boolean(document.fullscreenElement));const keydown=(event:KeyboardEvent)=>{if(event.key==="Escape"&&stream.current){void stop();return}if(sceneNow.current==="orbit"&&activityNow.current==="escape"){if(event.key==="ArrowLeft"||event.key.toLowerCase()==="a")steerEscape(-1);if(event.key==="ArrowRight"||event.key.toLowerCase()==="d")steerEscape(1);if(event.code==="Space"){event.preventDefault();dashEscape()}if(event.key==="Enter")startEscape()}};document.addEventListener("fullscreenchange",changed);document.addEventListener("keydown",keydown);drawWorld();return()=>{document.removeEventListener("fullscreenchange",changed);document.removeEventListener("keydown",keydown);void stop()}},[]);

  return <div ref={root} className={`orbit-play ${active?"is-active":""} ${effect==="SUPERNOVA"?"is-bursting":""}`}>
    <canvas className="energy-world" ref={world}/>
    <video ref={video} muted playsInline aria-hidden="true"/>
    <canvas className="hand-overlay" ref={overlay}/>
    <header><div><small>ORBIT PLAY · PHASE 10 UNIVERSE</small><h1>{scene==="system"?"A universe in your hands.":scene==="orbit"?"Welcome to Orbit.":"Shape the impossible."}</h1><p>{scene==="system"?"Rotate, zoom, select planets, and enter Orbit World.":scene==="orbit"?"Explore gravity, forge stars, and race comets.":"Move the field. Rotate both hands. Pinch and pull, then clap to release."}</p></div><span className={active?"camera-live":""}>● {active?"CAMERA ACTIVE · LOCAL ONLY":"CAMERA OFF"}</span></header>
    <div className="play-controls">
      <div className="scene-switch"><button className={scene==="system"?"selected":""} onClick={()=>chooseScene("system")}>Solar system</button><button className={scene==="orbit"?"selected":""} onClick={()=>chooseScene("orbit")}>Orbit world</button><button className={scene==="energy"?"selected":""} onClick={()=>chooseScene("energy")}>Energy lab</button></div>
      {scene==="orbit"&&<div className="activity-switch">{(["escape","gravity","forge","comets"] as OrbitActivity[]).map(item=><button key={item} className={activity===item?"selected":""} onClick={()=>{activityNow.current=item;setActivity(item);escape.current.running=false;setEffect(`${item.toUpperCase()} ACTIVE`)}}>{item==="escape"?"Escape":item==="gravity"?"Gravity":item==="forge"?"Forge":"Comets"}</button>)}</div>}
      <div className="mode-switch"><button className={mode==="playground"?"selected":""} disabled={active} onClick={()=>setMode("playground")}>Play</button><button className={mode==="desktop"?"selected":""} disabled={active} onClick={()=>setMode("desktop")}>Desktop</button></div>
      {active?<button className="play-stop" onClick={()=>void stop()}>Stop</button>:<button className="play-start" onClick={()=>void start()}>Enter Orbit Play</button>}
      {scene==="orbit"&&activity==="escape"&&<button className="escape-start" disabled={!active} onClick={startEscape}>{escape.current.over?"Restart":"Launch"}</button>}
      <button className="play-immersive" onClick={()=>void toggleImmersive()}>{immersive?"Exit full screen":"Full screen"}</button>
    </div>
    <div className="gesture-readout"><small>{effect}</small><b>{gesture}</b><span>{message}</span></div>
    <div className="play-hint">{scene==="energy"?<><span>MOVE TOGETHER</span><i/><span>ROTATE</span><i/><span>PINCH + PULL</span><i/><span>CLAP TO BURST</span></>:scene==="system"?<><span>ROTATE SYSTEM</span><i/><span>SPREAD TO ZOOM</span><i/><span>PINCH TO VISIT</span></>:activity==="escape"?<><span>A / D OR HAND TO STEER</span><i/><span>SPACE OR PINCH TO DASH</span></>:<><span>GRAVITY GARDEN</span><i/><span>STAR FORGE</span><i/><span>COMET RUN</span></>}</div>
    <aside className="play-safety"><b>LOCAL CAMERA</b><span>Only hand landmarks appear; the camera image stays hidden. Frames are never recorded or uploaded. Press Esc or hold both fists for 2 seconds to stop.</span></aside>
  </div>;
}
