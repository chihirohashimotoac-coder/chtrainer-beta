import { useState } from "react";
import type {
  ReleaseStopTiming,
  RequiredScaleKey,
  SelfAssessment,
} from "../types/models";
import { nowIso } from "../utils/id";
import { Scale11 } from "./Scale11";
import { t } from "../i18n/ja";

interface AssessmentFormProps {
  timing: SelfAssessment["timing"];
  onSubmit: (assessment: SelfAssessment) => void;
  submitLabel?: string;
}

/** 自己評価入力フォーム(開始前・中間・終了後で共用) */
export function AssessmentForm({
  timing,
  onSubmit,
  submitLabel,
}: AssessmentFormProps) {
  const s = t();
  const [fatigue, setFatigue] = useState(5);
  const [concentration, setConcentration] = useState(5);
  const [pain, setPain] = useState(0);
  const [confidence, setConfidence] = useState(5);
  // 既定値のまま送信された項目を「未回答」として記録するため、操作された項目を追跡する。
  // 既定値(5/5/0/5)と実際にその値を選んだ回答は区別できないため、操作の有無で判定する。
  const [touchedScales, setTouchedScales] = useState<Set<RequiredScaleKey>>(
    () => new Set()
  );
  const markTouched = (key: RequiredScaleKey) =>
    setTouchedScales((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  const untouchedScales = (
    ["fatigue", "concentration", "pain", "confidence"] as const
  ).filter((key) => !touchedScales.has(key));
  const [conditionChange, setConditionChange] = useState<
    "better" | "same" | "worse"
  >("same");
  const [note, setNote] = useState("");
  const [showMental, setShowMental] = useState(false);
  const [anxiety, setAnxiety] = useState(0);
  const [releaseFear, setReleaseFear] = useState(0);
  const [routineAdherence, setRoutineAdherence] = useState(10);
  const [uninterruptedThrowRate, setUninterruptedThrowRate] = useState<number | "">("");
  const [releaseStopTiming, setReleaseStopTiming] = useState<ReleaseStopTiming | "">("");

  const submit = () => {
    const assessment: SelfAssessment = {
      timing,
      recordedAt: nowIso(),
      fatigue,
      concentration,
      pain,
      confidence,
      ...(untouchedScales.length > 0 ? { untouchedScales } : {}),
      ...(timing !== "before" ? { conditionChange } : {}),
      // メンタル評価はセクションを開いて記録した場合のみ保存する
      ...(showMental
        ? {
            anxiety,
            releaseFear,
            routineAdherence,
            ...(uninterruptedThrowRate !== "" ? { uninterruptedThrowRate } : {}),
            ...(releaseStopTiming ? { releaseStopTiming } : {}),
          }
        : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    onSubmit(assessment);
  };

  return (
    <div>
      <p className="muted small">
        {s.assessment.scaleHint0}
        <br />
        {s.assessment.scaleHint10}
      </p>
      <p className="muted small">{s.assessment.untouchedHint}</p>
      <Scale11
        label={s.assessment.fatigue}
        value={fatigue}
        onChange={(v) => {
          markTouched("fatigue");
          setFatigue(v);
        }}
      />
      <Scale11
        label={s.assessment.concentration}
        value={concentration}
        onChange={(v) => {
          markTouched("concentration");
          setConcentration(v);
        }}
      />
      <Scale11
        label={s.assessment.pain}
        value={pain}
        onChange={(v) => {
          markTouched("pain");
          setPain(v);
        }}
      />
      <p className="muted small">{s.assessment.painDisclaimer}</p>
      <Scale11
        label={s.assessment.confidence}
        value={confidence}
        onChange={(v) => {
          markTouched("confidence");
          setConfidence(v);
        }}
      />

      {timing !== "before" && (
        <fieldset>
          <legend>{s.assessment.conditionChange}</legend>
          <div className="choice-row">
            {(
              [
                ["better", s.assessment.changeBetter],
                ["same", s.assessment.changeSame],
                ["worse", s.assessment.changeWorse],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`choice${conditionChange === key ? " selected" : ""}`}
                onClick={() => setConditionChange(key)}
                aria-pressed={conditionChange === key}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <button
        className="btn small block"
        onClick={() => setShowMental((v) => !v)}
        aria-expanded={showMental}
      >
        {s.assessment.mentalSection}
      </button>
      {showMental && (
        <div className="card">
          <p className="muted small">{s.assessment.mentalHint}</p>
          <Scale11
            label={s.assessment.anxiety}
            value={anxiety}
            onChange={setAnxiety}
          />
          <Scale11
            label={s.assessment.releaseFear}
            value={releaseFear}
            onChange={setReleaseFear}
          />
          <Scale11
            label={s.assessment.routineAdherence}
            value={routineAdherence}
            onChange={setRoutineAdherence}
          />
          <label className="field" htmlFor={`uninterrupted-${timing}`}>
            <span>{s.assessment.uninterruptedThrowRate} (任意)</span>
          </label>
          <p id={`uninterrupted-hint-${timing}`} className="muted small">
            {s.assessment.uninterruptedThrowRateHint}
          </p>
          <select
            id={`uninterrupted-${timing}`}
            aria-describedby={`uninterrupted-hint-${timing}`}
            value={uninterruptedThrowRate}
            onChange={(e) => setUninterruptedThrowRate(e.target.value === "" ? "" : Number(e.target.value))}
          >
            <option value="">未入力</option>
            {Array.from({ length: 21 }, (_, i) => i * 5).map((value) => (
              <option key={value} value={value}>{value}%</option>
            ))}
          </select>
          <label className="field" htmlFor={`release-stop-${timing}`}>
            <span>{s.assessment.releaseStopTiming} (任意)</span>
          </label>
          <select
            id={`release-stop-${timing}`}
            value={releaseStopTiming}
            onChange={(e) => setReleaseStopTiming(e.target.value as ReleaseStopTiming | "")}
          >
            <option value="">未入力</option>
            <option value="none">なし</option>
            <option value="during_setup">セットアップ中</option>
            <option value="before_takeback">テイクバック開始前</option>
            <option value="after_takeback">テイクバック後／前へ出す直前</option>
            <option value="during_forward">フォワード動作中</option>
            <option value="before_release">リリース直前</option>
            <option value="unknown">わからない</option>
            <option value="other">その他</option>
          </select>
        </div>
      )}

      <label className="field">
        <span>{s.assessment.note}</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      <div className="action-bar">
        <button className="btn primary block" onClick={submit}>
          {submitLabel ?? s.common.next}
        </button>
      </div>
    </div>
  );
}
