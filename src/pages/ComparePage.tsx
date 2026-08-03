import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { getSession, getSessions, getStatistics } from "../db/db";
import { recalcAndSaveStatistics } from "../services/sessionService";
import {
  compareStatistics,
  comparisonMismatches,
  rankComparisonCandidates,
  rankDissimilarCandidates,
  type PrecisionSummary,
  type StatDiff,
} from "../domain/compare";
import { modeLabel } from "../export/markdown";
import type { SessionStatistics, TrainingSession } from "../types/models";
import { normalizeScoringStyle } from "../types/models";
import { fmtDateTime, fmtNum, fmtNumDiff, fmtRate, fmtRateDiff } from "../utils/format";
import { t } from "../i18n/ja";

export default function ComparePage() {
  const s = t();
  const { id } = useParams();
  const [base, setBase] = useState<TrainingSession>();
  const [baseStats, setBaseStats] = useState<SessionStatistics>();
  const [others, setOthers] = useState<TrainingSession[]>([]);
  const [statsMap, setStatsMap] = useState<Record<string, SessionStatistics>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [showDissimilar, setShowDissimilar] = useState(false);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      const sess = await getSession(id);
      setBase(sess);
      setBaseStats(
        (await getStatistics(id)) ?? (await recalcAndSaveStatistics(id))
      );
      const all = (await getSessions()).filter(
        (x) => x.id !== id && x.status !== "active"
      );
      setOthers(all);
      const map: Record<string, SessionStatistics> = {};
      await Promise.all(
        all.map(async (x) => {
          const st =
            (await getStatistics(x.id)) ??
            (await recalcAndSaveStatistics(x.id));
          if (st) map[x.id] = st;
        })
      );
      setStatsMap(map);
    })();
  }, [id]);

  const candidates = useMemo(
    () => (base ? rankComparisonCandidates(base, others) : []),
    [base, others]
  );
  const dissimilar = useMemo(
    () => (base ? rankDissimilarCandidates(base, others) : []),
    [base, others]
  );

  if (!base || !baseStats) return <p>{s.common.loading}</p>;

  const toggle = (sessionId: string) => {
    setSelected((prev) =>
      prev.includes(sessionId)
        ? prev.filter((x) => x !== sessionId)
        : [...prev, sessionId]
    );
  };

  return (
    <div>
      <h1>{s.compare.title}</h1>
      <div className="card">
        <span className="muted small">{s.compare.baseSession}</span>
        <div>
          <strong>{modeLabel(base.trainingMode)}</strong>{" "}
          <span className="muted small">{fmtDateTime(base.startedAt)}</span>
        </div>
      </div>

      <h2>{s.compare.candidates}</h2>
      {candidates.length === 0 && (
        <p className="muted">{s.compare.noSameMode}</p>
      )}
      {candidates.map(({ session: cand, reasons }) => {
        const isSelected = selected.includes(cand.id);
        const hasStats = statsMap[cand.id] != null;
        return (
          <button
            key={cand.id}
            className={`card selectable${isSelected ? " selected" : ""}`}
            style={{ display: "block", width: "100%", textAlign: "left" }}
            onClick={() => hasStats && toggle(cand.id)}
            disabled={!hasStats}
            aria-pressed={isSelected}
          >
            <div className="list-row">
              <strong>{modeLabel(cand.trainingMode)}</strong>
              <span className="muted small">{fmtDateTime(cand.startedAt)}</span>
            </div>
            <div className="muted small">
              {reasons.join(" / ") || "-"}
              {!hasStats && ` (${s.errors.notEnoughData})`}
            </div>
            {isSelected && <ComparisonWarning base={base} other={cand} />}
          </button>
        );
      })}

      {dissimilar.length > 0 && (
        <button
          className="btn small"
          onClick={() => setShowDissimilar((v) => !v)}
          aria-expanded={showDissimilar}
        >
          {showDissimilar
            ? s.compare.hideDissimilar
            : s.compare.showDissimilar}
        </button>
      )}
      {showDissimilar && (
        <>
          <p className="muted small">{s.compare.dissimilarHint}</p>
          {dissimilar.map(({ session: cand }) => {
            const isSelected = selected.includes(cand.id);
            const hasStats = statsMap[cand.id] != null;
            return (
              <button
                key={cand.id}
                className={`card selectable${isSelected ? " selected" : ""}`}
                style={{ display: "block", width: "100%", textAlign: "left" }}
                onClick={() => hasStats && toggle(cand.id)}
                disabled={!hasStats}
                aria-pressed={isSelected}
              >
                <div className="list-row">
                  <strong>{modeLabel(cand.trainingMode)}</strong>
                  <span className="muted small">{fmtDateTime(cand.startedAt)}</span>
                </div>
                <ComparisonWarning base={base} other={cand} />
              </button>
            );
          })}
        </>
      )}

      {selected.length === 0 && <p className="muted">{s.compare.noSelection}</p>}

      {selected.map((selId) => {
        const other = others.find((x) => x.id === selId);
        const otherStats = statsMap[selId];
        if (!other || !otherStats) return null;
        const c = compareStatistics(baseStats, otherStats);
        return (
          <div className="card" key={selId}>
            <h2>
              {s.compare.pastSession}: {fmtDateTime(other.startedAt)} (
              {modeLabel(other.trainingMode)})
            </h2>
            <PrecisionNote precision={c.precision} />
            <div className="table-wrap">
              <table className="stats">
                <thead>
                  <tr>
                    <th></th>
                    <th>{s.compare.thisSession}</th>
                    <th>{s.compare.pastSession}</th>
                    <th>差</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{s.result.exactHitRate}</td>
                    <DiffCells d={c.hitRate} format="rate" />
                  </tr>
                  <tr>
                    <td>{s.result.averageErrorDistance}</td>
                    <DiffCells d={c.averageErrorDistance} format="num" />
                  </tr>
                  {(["1", "2", "3"] as const).map((order) => (
                    <tr key={order}>
                      <td>
                        {order}投目 {s.result.hitRate}
                      </td>
                      <DiffCells d={c.byDartInSet[order].hitRate} format="rate" />
                    </tr>
                  ))}
                  <tr>
                    <td>
                      {s.result.firstHalf} {s.result.hitRate}
                    </td>
                    <DiffCells d={c.firstHalfHitRate} format="rate" />
                  </tr>
                  <tr>
                    <td>
                      {s.result.secondHalf} {s.result.hitRate}
                    </td>
                    <DiffCells d={c.secondHalfHitRate} format="rate" />
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="muted small">{s.compare.sampleNote}</p>
            <h3>{s.compare.byTargetDiff}</h3>
            <div className="table-wrap">
              <table className="stats">
                <thead>
                  <tr>
                    <th>{s.throws.target}</th>
                    <th>{s.compare.thisSession}</th>
                    <th>{s.compare.pastSession}</th>
                    <th>差</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(c.byTarget)
                    .sort()
                    .map((label) => {
                      const d = c.byTarget[label];
                      if (!d) return null;
                      return (
                        <tr key={label}>
                          <td>{label}</td>
                          <DiffCells d={d.hitRate} format="rate" />
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <h3>{s.compare.assessmentDiff}</h3>
            <AssessmentDiff base={base} other={other} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * 値と一緒に必ず分母(サンプル数)を表示する。
 * 「3投目 命中率 50.0% → 100.0%」のような差は、分母が20投なのか2投なのかで
 * 意味がまったく変わるため、値だけを見て改善・悪化と判断できないようにする。
 */
function DiffCells({ d, format }: { d: StatDiff; format: "rate" | "num" }) {
  const s = t();
  const value = (v: number | undefined) =>
    format === "rate" ? fmtRate(v) : fmtNum(v);
  const diff = format === "rate" ? fmtRateDiff(d.diff) : fmtNumDiff(d.diff);
  const sample = (n: number | undefined) =>
    n == null ? null : (
      <div className="muted small">
        {s.compare.sampleUnit}
        {n}
      </div>
    );
  return (
    <>
      <td>
        {value(d.base)}
        {sample(d.baseSample)}
      </td>
      <td>
        {value(d.other)}
        {sample(d.otherSample)}
      </td>
      <td>{diff}</td>
    </>
  );
}

/**
 * 入力精度の内訳。詳細座標と簡易入力(エリア代表点による概算)では
 * 平均誤差距離の意味が違うため、差分だけで精度を判断させない。
 */
function PrecisionNote({
  precision,
}: {
  precision: { base: PrecisionSummary; other: PrecisionSummary };
}) {
  const s = t();
  const describe = (p: PrecisionSummary) =>
    `${s.compare.precisionCoordinate}${p.coordinateInputCount} / ${s.compare.precisionApproximate}${p.approximateInputCount}`;
  const mixed =
    precision.base.includesApproximation !==
    precision.other.includesApproximation;
  return (
    <div className="info-box small">
      <div>
        <strong>{s.compare.precisionLabel}</strong> {s.compare.thisSession}:{" "}
        {describe(precision.base)} / {s.compare.pastSession}:{" "}
        {describe(precision.other)}
      </div>
      {mixed && <div>{s.compare.precisionMixedWarning}</div>}
    </div>
  );
}

/**
 * 比較条件の差分を実データから判定し、正確な理由だけを表示する。
 * スコアリング形式差は具体的な形式名と、同一ターゲット単位で比較する指示を添える。
 * 差分がなければ何も表示しない(完全同条件では警告を出さない)。
 */
function ComparisonWarning({
  base,
  other,
}: {
  base: TrainingSession;
  other: TrainingSession;
}) {
  const s = t();
  const m = comparisonMismatches(base, other);
  const lines: string[] = [];
  if (m.mode) lines.push(s.compare.diffMode);
  if (m.board) lines.push(s.compare.diffBoard);
  if (m.input) lines.push(s.compare.diffInput);
  if (m.scoring) {
    const bs = normalizeScoringStyle(base.scoringStyle);
    const os = normalizeScoringStyle(other.scoringStyle);
    const bl = bs ? s.preSession.scoringStyles[bs] : "";
    const ol = os ? s.preSession.scoringStyles[os] : "";
    lines.push(
      `${s.compare.diffScoring}（${bl} / ${ol}）。${s.compare.diffScoringNote}`
    );
  }
  if (lines.length === 0) return null;
  // モード・ボード・入力方式が異なる場合のみ「参考程度に」を添える
  // (形式差だけの場合は同一ターゲット単位での比較指示で十分)。
  const showTail = m.mode || m.board || m.input;
  return (
    <div className="warn-box">
      <strong>{s.compare.warningLead}</strong>
      <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.2rem" }}>
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      {showTail && <div className="small">{s.compare.warningTail}</div>}
    </div>
  );
}

function AssessmentDiff({
  base,
  other,
}: {
  base: TrainingSession;
  other: TrainingSession;
}) {
  const s = t();
  const rows = (["before", "middle", "after"] as const).map((timing) => {
    const a = base.assessments.find((x) => x.timing === timing);
    const b = other.assessments.find((x) => x.timing === timing);
    return { timing, a, b };
  });
  const label = {
    before: s.assessment.beforeTitle,
    middle: s.assessment.middleTitle,
    after: s.assessment.afterTitle,
  };
  return (
    <div className="table-wrap">
      <table className="stats">
        <thead>
          <tr>
            <th></th>
            <th>{s.assessment.fatigue}</th>
            <th>{s.assessment.concentration}</th>
            <th>{s.assessment.pain}</th>
            <th>{s.assessment.confidence}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ timing, a, b }) => (
            <tr key={timing}>
              <td>{label[timing]}</td>
              <td>{a && b ? fmtNumDiff(a.fatigue - b.fatigue, 0) : "N/A"}</td>
              <td>
                {a && b ? fmtNumDiff(a.concentration - b.concentration, 0) : "N/A"}
              </td>
              <td>{a && b ? fmtNumDiff(a.pain - b.pain, 0) : "N/A"}</td>
              <td>
                {a && b ? fmtNumDiff(a.confidence - b.confidence, 0) : "N/A"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
