import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApp } from "../state/AppContext";
import { useSetup } from "../state/SetupContext";
import { getSessions, getStatistics, getThrowSets } from "../db/db";
import { finishSession, recalcAndSaveStatistics } from "../services/sessionService";
import type { TrainingSession } from "../types/models";
import { fmtDateTime, fmtRate } from "../utils/format";
import { modeLabel } from "../export/markdown";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { BetaBadge } from "../components/BetaBadge";
import { t } from "../i18n/ja";

export default function HomePage() {
  const s = t();
  const { loading, settings, activeSession, refresh } = useApp();
  const { reset } = useSetup();
  const navigate = useNavigate();
  const [recent, setRecent] = useState<
    {
      session: TrainingSession;
      hitRate?: number;
      hasStats: boolean;
      completedSets: number;
      completedThrows: number;
    }[]
  >([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    void (async () => {
      const sessions = (await getSessions())
        .filter((x) => x.status !== "active")
        .slice(0, 5);
      const withStats = await Promise.all(
        sessions.map(async (session) => {
          const stats =
            (await getStatistics(session.id)) ??
            (await recalcAndSaveStatistics(session.id));
          const sets = await getThrowSets(session.id);
          return {
            session,
            hitRate: stats?.exactHitRate,
            hasStats: stats != null && stats.scorableThrows > 0,
            completedSets: sets.length,
            completedThrows: stats?.completedThrows ?? 0,
          };
        })
      );
      setRecent(withStats);
    })();
  }, [activeSession]);

  if (loading) return <p>{s.common.loading}</p>;

  const needsSetup = !settings?.onboardingCompleted;

  return (
    <div className="home-page">
      <div className="home-hero">
        <div className="title-row">
          <span className="eyebrow">PERFORMANCE ANALYTICS</span>
          <BetaBadge />
        </div>
        <h1>{s.appName}</h1>
        <p>1投ごとの事実を、次の改善判断へ。</p>
      </div>

      {needsSetup ? (
        <div className="card">
          <p>{s.home.setupRequired}</p>
          <Link className="btn primary block" to="/setup">
            {s.home.goSetup}
          </Link>
        </div>
      ) : (
        <>
          {activeSession && (
            <div className="card">
              <p>{s.home.resumeDescription}</p>
              <p className="muted small">
                {fmtDateTime(activeSession.startedAt)} /{" "}
                {modeLabel(activeSession.trainingMode)} /{" "}
                {activeSession.setCount}
                {s.sets.setsUnit}
              </p>
              <button
                className="btn primary block"
                onClick={() => navigate("/train/session")}
              >
                {s.home.resumeSession}
              </button>
              <button
                className="btn danger block"
                onClick={() => setConfirmDiscard(true)}
              >
                {s.home.discardSession}
              </button>
            </div>
          )}
          {!activeSession && (
            <button
              className="btn primary block hero-cta"
              onClick={() => {
                reset();
                navigate("/train/mode");
              }}
            >
              {s.home.startTraining}
            </button>
          )}

          <h2>{s.home.recentSessions}</h2>
          {recent.length === 0 && <p className="muted">{s.home.noSessions}</p>}
          {recent.map(({ session, hitRate, hasStats, completedSets, completedThrows }) => (
            <Link
              key={session.id}
              to={`/session/${session.id}`}
              className="card selectable"
              style={{ display: "block", textDecoration: "none", color: "inherit" }}
            >
              <div className="list-row">
                <strong>{modeLabel(session.trainingMode)}</strong>
                <span className={`badge${session.status === "completed" ? " ok" : " warn"}`}>
                  {session.status === "completed"
                    ? s.sessions.completed
                    : s.sessions.aborted}
                </span>
              </div>
              <div className="muted small">
                {fmtDateTime(session.startedAt)} /{" "}
                {session.status === "completed"
                  ? `${session.setCount}${s.sets.setsUnit}`
                  : `${completedSets}/${session.setCount}${s.sets.setsUnit} (${completedThrows}/${session.plannedThrowCount}${s.sets.throwsUnit})`}{" "}
                / {s.sessions.hitRate}{" "}
                {hasStats && hitRate != null ? fmtRate(hitRate) : "N/A"}
              </div>
            </Link>
          ))}
        </>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        title={s.home.discardSession}
        danger
        confirmLabel={s.common.ok}
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={async () => {
          if (activeSession) {
            await finishSession(activeSession, "aborted");
            await refresh();
          }
          setConfirmDiscard(false);
        }}
      >
        <p className="muted">{s.throwing.abortConfirm}</p>
      </ConfirmDialog>
    </div>
  );
}
