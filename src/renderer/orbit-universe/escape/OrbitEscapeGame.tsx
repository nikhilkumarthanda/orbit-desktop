import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Canvas } from "@react-three/fiber";
import { EscapeScene } from "./EscapeScene";
import type { EscapeState } from "./escapeState";
import type { LeaderboardEntry, LiveEntry, ScoreService } from "./scoreService";

type Hud = { score: number; best: number; multiplier: number; combo: number; dash: number; running: boolean; over: boolean; toast: string | null };
type Tab = "live" | "daily" | "global";

function NameForm({ scoreService, onSet }: { scoreService: ScoreService; onSet: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const result = await scoreService.setDisplayName(value);
    if (!result.ok) { setError(result.error ?? "Invalid name"); return }
    onSet();
  };
  return (
    <div className="escape-board-name">
      <input
        value={value}
        maxLength={20}
        placeholder="Choose a display name"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit() }}
      />
      <button type="button" onClick={() => void submit()}>Save</button>
      {error && <span className="escape-board-name-error">{error}</span>}
    </div>
  );
}

function LeaderboardPanel({ scoreService, postRunResult, onRestart }: { scoreService: ScoreService; postRunResult: { score: number; rank?: number } | null; onRestart: () => void }) {
  const [tab, setTab] = useState<Tab>("daily");
  const [entries, setEntries] = useState<(LeaderboardEntry | LiveEntry)[]>([]);
  const [displayName, setDisplayName] = useState(scoreService.getDisplayName());

  useEffect(() => {
    let cancelled = false;
    if (tab === "live") {
      const unsubscribe = scoreService.subscribeLive((live) => { if (!cancelled) setEntries(live) });
      return () => { cancelled = true; unsubscribe() };
    }
    const load = tab === "daily" ? scoreService.getDailyLeaderboard() : scoreService.getGlobalLeaderboard();
    void load.then((rows) => { if (!cancelled) setEntries(rows) });
    return () => { cancelled = true };
  }, [tab, scoreService, postRunResult]);

  const isOnline = scoreService.mode === "online";

  return (
    <div className="escape-board">
      <h2>SIGNAL LOST</h2>
      {postRunResult && (
        <p className="escape-board-score">
          FINAL SCORE {String(postRunResult.score).padStart(6, "0")}
          {postRunResult.rank === 1 && <span className="escape-board-best-flag"> · NEW {isOnline ? "GLOBAL" : "LOCAL"} BEST</span>}
        </p>
      )}
      <div className="escape-board-tabs">
        <button type="button" className={tab === "live" ? "selected" : ""} onClick={() => setTab("live")}>Live</button>
        <button type="button" className={tab === "daily" ? "selected" : ""} onClick={() => setTab("daily")}>Daily</button>
        <button type="button" className={tab === "global" ? "selected" : ""} onClick={() => setTab("global")}>Global</button>
      </div>
      <div className="escape-board-list">
        {entries.length === 0 && <div className="escape-board-empty">{tab === "live" ? "No live run." : isOnline ? "No runs yet." : "No local runs yet."}</div>}
        {entries.map((entry, i) => (
          <div key={i} className={`escape-board-row${entry.isSelf ? " is-self" : ""}`}>
            <span className="escape-board-rank">{"rank" in entry ? `#${entry.rank}` : "●"}</span>
            <span className="escape-board-name">{entry.name}{entry.isSelf && " (you)"}</span>
            <span className="escape-board-points">{Math.floor(entry.score)}</span>
          </div>
        ))}
      </div>
      {displayName === null && <NameForm scoreService={scoreService} onSet={() => setDisplayName(scoreService.getDisplayName())} />}
      <p className="escape-board-note">
        {isOnline
          ? "ONLINE — competing on the real leaderboard. Anonymous account: clearing app data creates a new identity."
          : "LOCAL / OFFLINE — scores stay on this device only. Real competition arrives with the online leaderboard."}
      </p>
      <button type="button" className="escape-board-restart" onClick={onRestart}>Play Again</button>
      <p className="escape-board-hint">or press Enter</p>
    </div>
  );
}

export function OrbitEscapeGame({ game, onEnded, scoreService, postRunResult, onRestart }: {
  game: MutableRefObject<EscapeState>;
  onEnded: () => void;
  scoreService: ScoreService;
  postRunResult: { score: number; rank?: number } | null;
  onRestart: () => void;
}) {
  const [hud, setHud] = useState<Hud>({ score: 0, best: game.current.best, multiplier: 1, combo: 0, dash: 1, running: false, over: false, toast: null });
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => {
      const g = game.current;
      setHud({ score: Math.floor(g.score), best: g.best, multiplier: g.multiplier, combo: g.combo, dash: g.dash, running: g.running, over: g.over, toast: g.toast?.text ?? null });
    }, 100);
    return () => window.clearInterval(id);
  }, [game]);

  useEffect(() => {
    if (hud.over) { pausedRef.current = false; setPaused(false) }
  }, [hud.over]);

  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  };

  return (
    <div className="orbit-escape-overlay">
      <Canvas
        style={{ position: "absolute", inset: 0, zIndex: 1, background: "#000104" }}
        dpr={[1, 1.75]}
        gl={{ antialias: true }}
        camera={{ fov: 55, near: 0.1, far: 500, position: [0, 2.5, 6.5] }}
      >
        <EscapeScene game={game} onEnded={onEnded} pausedRef={pausedRef} />
      </Canvas>
      <div className="escape-hud">
        <div className="escape-hud-topbar">
          <div className="escape-hud-left">
            <div className="escape-hud-score">{String(hud.score).padStart(6, "0")}</div>
            <div className="escape-hud-multiplier">×{hud.multiplier}{hud.combo > 0 && <span className="escape-hud-combo"> · COMBO {hud.combo}</span>}</div>
          </div>
          <div className="escape-hud-right">
            <div className="escape-hud-best">BEST {String(hud.best).padStart(6, "0")} <span className="escape-hud-local-badge">{scoreService.mode === "online" ? "ONLINE" : "LOCAL"}</span></div>
            {hud.running && (
              <button type="button" className="escape-hud-pause" onClick={togglePause} aria-label={paused ? "Resume" : "Pause"}>
                {paused ? "▶" : "❚❚"}
              </button>
            )}
          </div>
        </div>
        <div className="escape-hud-phase">
          <span>PHASE</span>
          <div className="escape-hud-phase-bar"><i style={{ width: `${hud.dash * 100}%` }} /></div>
        </div>
        {hud.toast && <div className="escape-hud-toast">{hud.toast}</div>}
        {hud.over ? (
          <LeaderboardPanel scoreService={scoreService} postRunResult={postRunResult} onRestart={onRestart} />
        ) : (!hud.running || paused) && (
          <div className="escape-hud-title">
            <h2>{paused ? "PAUSED" : "ORBIT ESCAPE"}</h2>
            <p>{paused ? "SPACE OR TAP TO RESUME" : "A / D TO STEER · SPACE TO PHASE DASH"}</p>
          </div>
        )}
      </div>
    </div>
  );
}
