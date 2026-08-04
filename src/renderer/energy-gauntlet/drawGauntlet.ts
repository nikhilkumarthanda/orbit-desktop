import { HAND_CONNECTIONS, type HandState } from "../orbit-universe/gestures/gestureStateMachine";
import { POWER_DOWN_MS, SUIT_UP_MS, powerDownProgress, type BallState, type Fireball, type GauntletState, type Projectile, type Spark } from "./gauntletState";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const drawBall = (ctx: CanvasRenderingContext2D, width: number, height: number, ball: BallState, sparks: Spark[], hands: HandState[], phase: number, opacity: number) => {
  if (opacity <= 0.01) return;
  ctx.save(); ctx.globalAlpha = opacity;
  const center = { x: ball.center.x * width, y: ball.center.y * height };
  const pinchCharge = hands.filter(hand => hand.pinching).length, base = Math.min(width, height) * .225;
  const pulse = 1 + Math.sin(phase * 2.4) * .012 + ball.tension * .08;
  const radius = base * ball.scale * pulse;
  if (!sparks.length) sparks.push(...Array.from({ length: 460 }, (_, i) => ({ angle: Math.random() * Math.PI * 2, radius: .42 + Math.random() * .88, speed: .0015 + Math.random() * .009, size: .4 + Math.random() * 2.7, alpha: .2 + Math.random() * .78, hue: 18 + Math.random() * 35 + (i % 9 === 0 ? 160 : 0), burstX: 0, burstY: 0 })));

  const atmosphere = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius * 3.1);
  atmosphere.addColorStop(0, `rgba(255,181,73,${.28 + ball.tension * .16})`); atmosphere.addColorStop(.34, "rgba(255,72,19,.1)"); atmosphere.addColorStop(1, "rgba(1,3,10,0)");
  ctx.fillStyle = atmosphere; ctx.fillRect(0, 0, width, height);

  // Sharp radiating rays (starburst/corona), matching a reactor-core look rather than a soft glow.
  const rayCount = 14;
  ctx.save(); ctx.translate(center.x, center.y); ctx.rotate(ball.rotation * .6 + phase * .18);
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < rayCount; i++) {
    const a = (i / rayCount) * Math.PI * 2, len = radius * (2.1 + Math.sin(phase * 1.7 + i * 1.9) * .5 + ball.tension * .9);
    const ray = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    ray.addColorStop(0, `rgba(255,238,190,${.5 + ball.tension * .3})`); ray.addColorStop(.5, "rgba(255,150,50,.14)"); ray.addColorStop(1, "rgba(255,90,20,0)");
    ctx.strokeStyle = ray; ctx.lineWidth = radius * (i % 2 ? .05 : .09);
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * radius * .3, Math.sin(a) * radius * .3); ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len); ctx.stroke();
  }
  ctx.restore(); ctx.globalCompositeOperation = "source-over";

  // Fine angular circuit-fractal ticks around the sphere for a machined, geometric texture.
  ctx.save(); ctx.translate(center.x, center.y);
  for (let i = 0; i < 40; i++) {
    const a = i * 2.399963 + ball.rotation, r = radius * (0.72 + (i % 5) * .09);
    const x = Math.cos(a) * r, y = Math.sin(a) * r * .82, tickLen = radius * (0.05 + (i % 3) * .02);
    ctx.save(); ctx.translate(x, y); ctx.rotate(a + Math.PI / 2);
    ctx.strokeStyle = `rgba(255,214,150,${.35 + (i % 4 === 0 ? .25 : 0)})`; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0, -tickLen / 2); ctx.lineTo(0, tickLen / 2); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  for (let ring = 0; ring < 7; ring++) {
    ctx.save(); ctx.translate(center.x, center.y); ctx.rotate(ball.rotation + phase * (ring % 2 ? -.34 : .5) + ring * .78);
    ctx.scale(1, .5 + ring * .035); ctx.beginPath(); ctx.strokeStyle = `rgba(255,${100 + ring * 18},45,${.2 - ring * .02 + ball.tension * .08})`; ctx.lineWidth = 1.1 + ring * .35;
    ctx.setLineDash([3 + ring * 3, 9 + ring * 5]); ctx.arc(0, 0, radius * (.98 + ring * .052), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  sparks.forEach((spark, index) => {
    spark.angle += spark.speed * (1 + pinchCharge * .7 + ball.tension * 2.5) + ball.rotationVelocity * .025;
    const radial = radius * spark.radius * (1 - ball.tension * .13);
    let x = center.x + Math.cos(spark.angle + ball.rotation + Math.sin(phase + index) * .055) * radial;
    let y = center.y + Math.sin(spark.angle + ball.rotation) * radial * (.68 + .18 * Math.sin(index));
    if (ball.burst > 0) { x += spark.burstX * radius * ball.burst * 2.8; y += spark.burstY * radius * ball.burst * 2.8 }
    hands.forEach(hand => { const hx = hand.point.x * width, hy = hand.point.y * height, dx = hx - x, dy = hy - y, d = Math.max(24, Math.hypot(dx, dy)); const pull = hand.pinching ? Math.min(.24, 300 / (d * d)) : Math.min(.045, 65 / (d * d)); x += dx * pull; y += dy * pull });
    ctx.beginPath(); ctx.fillStyle = `hsla(${spark.hue},100%,68%,${spark.alpha})`; ctx.shadowColor = spark.hue > 100 ? "#70eaff" : "#ff7029"; ctx.shadowBlur = 8 + ball.tension * 10; ctx.arc(x, y, spark.size * (1 + ball.tension * .5), 0, Math.PI * 2); ctx.fill();
  });
  if (ball.burst > 0) { ball.burst *= .925; if (ball.burst < .015) ball.burst = 0; ctx.beginPath(); ctx.strokeStyle = `rgba(255,235,180,${ball.burst})`; ctx.lineWidth = 3; ctx.arc(center.x, center.y, radius * (1 + (1 - ball.burst) * 3), 0, Math.PI * 2); ctx.stroke() }
  ctx.shadowBlur = 0;
  const core = ctx.createRadialGradient(center.x - radius * .2, center.y - radius * .25, radius * .01, center.x, center.y, radius);
  core.addColorStop(0, "rgba(255,255,235,.99)"); core.addColorStop(.1, "rgba(255,226,143,.96)"); core.addColorStop(.38, `rgba(255,112,31,${.58 + ball.tension * .25})`); core.addColorStop(.76, "rgba(255,38,10,.15)"); core.addColorStop(1, "rgba(255,70,20,0)");
  ctx.globalCompositeOperation = "screen"; ctx.fillStyle = core; ctx.beginPath(); ctx.arc(center.x, center.y, radius * (1 - ball.burst * .8), 0, Math.PI * 2); ctx.fill(); ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = `rgba(255,244,214,${.55 + ball.tension * .3})`; ctx.lineWidth = Math.max(1.2, radius * .015); ctx.shadowColor = "#ffcf8a"; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.arc(center.x, center.y, radius * .58, 0, Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0;
  hands.forEach((hand, index) => {
    const x = hand.point.x * width, y = hand.point.y * height, hot = hand.pinching;
    const beam = ctx.createLinearGradient(x, y, center.x, center.y); beam.addColorStop(0, hot ? "rgba(255,235,155,.72)" : "rgba(107,239,255,.28)"); beam.addColorStop(1, "rgba(255,96,28,0)");
    ctx.strokeStyle = beam; ctx.lineWidth = hot ? 2.8 : 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo((x + center.x) / 2, center.y + (index ? 1 : -1) * radius * .32, center.x, center.y); ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = hot ? "#ffe39d" : "#76efff"; ctx.lineWidth = 2; ctx.arc(x, y, hot ? 18 : 10, 0, Math.PI * 2); ctx.stroke();
  });
  ctx.restore();
};

const drawPlates = (ctx: CanvasRenderingContext2D, width: number, height: number, hands: HandState[], reveal: number) => {
  const unit = Math.hypot(width, height);
  hands.forEach(hand => {
    const lm = hand.landmarks;
    HAND_CONNECTIONS.forEach(([a, b], segIndex) => {
      const segmentReveal = clamp(reveal * HAND_CONNECTIONS.length - segIndex, 0, 1);
      if (segmentReveal <= 0) return;
      const ax = lm[a].x * width, ay = lm[a].y * height, bx = lm[b].x * width, by = lm[b].y * height;
      const angle = Math.atan2(by - ay, bx - ax), len = Math.hypot(bx - ax, by - ay) * segmentReveal;
      const thickness = Math.max(6, unit * 0.014);
      ctx.save(); ctx.translate((ax + bx) / 2, (ay + by) / 2); ctx.rotate(angle);
      const grad = ctx.createLinearGradient(0, -thickness / 2, 0, thickness / 2);
      grad.addColorStop(0, "#eef3f7"); grad.addColorStop(.5, "#8b98a4"); grad.addColorStop(1, "#2c3540");
      ctx.fillStyle = grad; ctx.shadowColor = "#7fe0ff"; ctx.shadowBlur = 7 * segmentReveal; ctx.strokeStyle = "rgba(20,30,40,.7)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(-len / 2, -thickness / 2, len, thickness, thickness * .4); ctx.fill(); ctx.stroke();
      ctx.restore();
    });
    const palmX = hand.palm.x * width, palmY = hand.palm.y * height, coreR = unit * 0.026 * reveal;
    const core = ctx.createRadialGradient(palmX, palmY, 0, palmX, palmY, coreR * 2.6);
    core.addColorStop(0, "rgba(215,247,255,.95)"); core.addColorStop(.4, "rgba(90,210,255,.55)"); core.addColorStop(1, "rgba(20,60,90,0)");
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(palmX, palmY, coreR * 2.6, 0, Math.PI * 2); ctx.fill();
  });
};

const drawProjectiles = (ctx: CanvasRenderingContext2D, width: number, height: number, projectiles: Projectile[]) => {
  const unit = Math.hypot(width, height);
  projectiles.forEach(p => {
    const x = p.x * width, y = p.y * height, t = clamp(p.age / p.life, 0, 1), alpha = 1 - t, r = unit * 0.013;
    ctx.save(); ctx.shadowColor = "#8fe4ff"; ctx.shadowBlur = 18;
    const tailX = x - p.vx * unit * 0.05, tailY = y - p.vy * unit * 0.05;
    const tail = ctx.createLinearGradient(tailX, tailY, x, y); tail.addColorStop(0, "rgba(140,220,255,0)"); tail.addColorStop(1, `rgba(200,240,255,${alpha})`);
    ctx.strokeStyle = tail; ctx.lineWidth = r * 1.4; ctx.beginPath(); ctx.moveTo(tailX, tailY); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = `rgba(220,248,255,${alpha})`; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  });
};

const drawFireball = (ctx: CanvasRenderingContext2D, width: number, height: number, fireball: Fireball) => {
  if (fireball.charge <= 0.01) return;
  const x = fireball.x * width, y = fireball.y * height, unit = Math.hypot(width, height), r = unit * 0.022 * (0.6 + fireball.charge * 0.9);
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3.4);
  glow.addColorStop(0, "rgba(255,255,255,.95)"); glow.addColorStop(.28, `rgba(140,220,255,${0.65 * fireball.charge})`); glow.addColorStop(1, "rgba(20,60,120,0)");
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, r * 3.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#eafcff"; ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.fill();
};

const drawPowerDownHold = (ctx: CanvasRenderingContext2D, width: number, height: number, gauntlet: GauntletState, hands: HandState[], now: number) => {
  const progress = powerDownProgress(gauntlet, now), hand = hands[0];
  if (!hand || progress <= 0) return;
  const x = hand.palm.x * width, y = hand.palm.y * height, radius = Math.min(width, height) * .072;
  ctx.save(); ctx.lineCap = "round"; ctx.shadowColor = "#86eaff"; ctx.shadowBlur = 16;
  ctx.strokeStyle = "rgba(126,225,255,.2)"; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#d8f8ff"; ctx.beginPath(); ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress); ctx.stroke();
  ctx.shadowBlur = 0; ctx.fillStyle = "rgba(230,250,255,.92)"; ctx.font = "600 13px Inter, sans-serif"; ctx.textAlign = "center";
  ctx.fillText(`${Math.ceil((1 - progress) * 3)}s`, x, y + 5); ctx.restore();
};

export const drawGauntlet = (
  ctx: CanvasRenderingContext2D,
  width: number, height: number,
  gauntlet: GauntletState,
  hands: HandState[],
  phase: number,
  now: number,
  cameraVisible: boolean,
) => {
  if (!cameraVisible) {
    const bg = ctx.createLinearGradient(0, 0, 0, height); bg.addColorStop(0, "#0c0710"); bg.addColorStop(1, "#020104"); ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  }

  if (gauntlet.phase === "ball") {
    drawBall(ctx, width, height, gauntlet.ball, gauntlet.sparks, hands, phase, 1);
  } else if (gauntlet.phase === "suiting-up") {
    const reveal = clamp((now - gauntlet.phaseStartedAt) / SUIT_UP_MS, 0, 1);
    drawBall(ctx, width, height, gauntlet.ball, gauntlet.sparks, hands, phase, 1 - reveal);
    drawPlates(ctx, width, height, hands, reveal);
  } else if (gauntlet.phase === "suited") {
    drawPlates(ctx, width, height, hands, 1);
    drawProjectiles(ctx, width, height, gauntlet.projectiles);
    drawFireball(ctx, width, height, gauntlet.fireball);
    drawPowerDownHold(ctx, width, height, gauntlet, hands, now);
  } else {
    const retract = clamp((now - gauntlet.phaseStartedAt) / POWER_DOWN_MS, 0, 1);
    drawBall(ctx, width, height, gauntlet.ball, gauntlet.sparks, hands, phase, retract);
    drawPlates(ctx, width, height, hands, 1 - retract);
  }
};
