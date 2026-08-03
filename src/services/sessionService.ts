import { DARTS_PER_SET } from "../config/constants";
import {
  deleteSessionCascade,
  getSession,
  getSessions,
  getThrows,
  getThrowSets,
  saveCommittedSet,
  saveSession,
  saveStatistics,
  saveThrow,
} from "../db/db";
import { deriveThrow } from "../domain/derive";
import { calculateStatistics } from "../domain/stats";
import { SCHEMA_VERSION } from "../types/models";
import type {
  LandingRecord,
  PlayerProfile,
  SessionStatistics,
  TargetDefinition,
  ThrowRecord,
  ThrowSet,
  TrainingSession,
  UUID,
} from "../types/models";
import { newId, nowIso } from "../utils/id";

/** 中間自己評価を表示するセット番号(そのセット終了直後)。奇数は切り上げ。 */
export function middleAssessmentSet(setCount: number): number {
  return Math.ceil(setCount / 2);
}

export interface PendingDart {
  dartInSet: 1 | 2 | 3;
  target: TargetDefinition;
  landing: LandingRecord;
  /** 矢速(km/h・任意) */
  speedKmh?: number;
  note?: string;
}

/**
 * 1セット分(3投)の入力を確定し、派生データを計算して保存する。
 * 直前セットまでの最後の投擲を基準に previousThrow 系を求める。
 *
 * replaceSetId を渡すと、そのセットIDの既存データを単一トランザクションで
 * 置き換える(セット確認画面での再保存用。二重保存されない)。
 */
export async function commitSet(
  session: TrainingSession,
  setNumber: number,
  darts: PendingDart[],
  player: PlayerProfile | undefined,
  setStartedAt: string | undefined,
  replaceSetId?: string
): Promise<{ throwSet: ThrowSet; records: ThrowRecord[] }> {
  const existing = (await getThrows(session.id)).filter(
    (record) => record.setId !== replaceSetId
  );
  const lastExisting = existing[existing.length - 1];
  const baseGlobal = existing.length;
  const sessionStart = Date.parse(session.startedAt);
  const now = nowIso();

  const throwSet: ThrowSet = {
    schemaVersion: SCHEMA_VERSION,
    id: replaceSetId ?? newId(),
    sessionId: session.id,
    setNumber,
    startedAt: setStartedAt ?? now,
    completedAt: now,
    roundId: darts[0]?.target.roundId,
    roundKind: darts[0]?.target.roundKind,
    patternId: darts[0]?.target.patternId,
    patternKind: darts[0]?.target.patternKind,
    analysisCategory: darts[0]?.target.analysisCategory,
    evaluationKind: darts[0]?.target.evaluationKind,
    requiredInputPrecision: darts[0]?.target.requiredInputPrecision,
    inputMethod:
      darts.every((d) => d.landing.positionPrecision === "coordinate")
        ? "coordinate"
        : "simple",
  };

  const records: ThrowRecord[] = [];
  const dartColors = session.contextSnapshot?.dartColors ?? player?.dartColors;
  let prevTarget: TargetDefinition | undefined = lastExisting?.target;
  let prevHit: boolean | undefined = lastExisting?.derived.exactHit;
  darts.forEach((dart, i) => {
    const globalThrowNumber = baseGlobal + i + 1;
    const derived = deriveThrow(dart.target, dart.landing, {
      previousTarget: prevTarget,
      previousWasHit: prevHit,
      globalThrowNumber,
      plannedThrowCount: session.plannedThrowCount,
      sameSetAsPrevious: i > 0,
    });
    const record: ThrowRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: newId(),
      sessionId: session.id,
      setId: throwSet.id,
      globalThrowNumber,
      dartInSet: dart.dartInSet,
      dartColor: dartColors?.[dart.dartInSet - 1],
      target: dart.target,
      thrownAt: now,
      elapsedMs: Math.max(0, Date.now() - sessionStart),
      landing: dart.landing,
      derived,
      ...(dart.speedKmh != null ? { speedKmh: dart.speedKmh } : {}),
      ...(dart.note ? { note: dart.note } : {}),
      createdAt: now,
      updatedAt: now,
    };
    records.push(record);
    prevTarget = dart.target;
    prevHit = derived.exactHit;
  });

  await saveCommittedSet(throwSet, records);
  return { throwSet, records };
}

/** セッションの統計を再計算して保存する */
export async function recalcAndSaveStatistics(
  sessionId: UUID
): Promise<SessionStatistics | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  const throws = await getThrows(sessionId);
  const stats = calculateStatistics(
    sessionId,
    session.plannedThrowCount,
    throws,
    session.trainingMode
  );
  await saveStatistics(stats);
  return stats;
}

/**
 * 投擲1件の着弾を修正する。
 * 派生データを再計算し、次の投擲の previousThrowWasHit も更新、統計を再計算する。
 * speedKmh: undefined=既存値を保持 / null=クリア / 数値=更新
 */
export async function updateThrowLanding(
  record: ThrowRecord,
  landing: LandingRecord,
  note?: string,
  speedKmh?: number | null
): Promise<void> {
  const session = await getSession(record.sessionId);
  if (!session) throw new Error("session not found");
  const all = await getThrows(record.sessionId);
  const index = all.findIndex((x) => x.id === record.id);
  const prev = index > 0 ? all[index - 1] : undefined;
  const derived = deriveThrow(record.target, landing, {
    previousTarget: prev?.target,
    previousWasHit: prev?.derived.exactHit,
    globalThrowNumber: record.globalThrowNumber,
    plannedThrowCount: session.plannedThrowCount,
    sameSetAsPrevious: prev?.setId === record.setId,
  });
  const updated: ThrowRecord = {
    ...record,
    landing,
    derived,
    ...(note !== undefined ? { note: note || undefined } : {}),
    ...(speedKmh !== undefined ? { speedKmh: speedKmh ?? undefined } : {}),
  };
  await saveThrow(updated);
  const next = index >= 0 ? all[index + 1] : undefined;
  if (next) {
    const sameSet = next.setId === record.setId;
    const needsUpdate =
      sameSet &&
      (next.derived.previousThrowWasHit !== derived.exactHit ||
        next.derived.previousThrowWasHitInSameSet !== derived.exactHit);
    if (needsUpdate) {
      await saveThrow({
        ...next,
        derived: {
          ...next.derived,
          previousThrowWasHit: derived.exactHit,
          previousThrowWasHitInSameSet: derived.exactHit,
        },
      });
    }
  }
  await recalcAndSaveStatistics(record.sessionId);
}

/**
 * 1投も記録されていない進行中セッションを削除する。
 *
 * セッションは「開始」を押した時点で作成されるため、モードや設定を選び直して
 * 離脱するだけで0投のセッションが残り、履歴一覧を埋めてしまう。
 * 0投のセッションは再開しても失われる進捗がないので、安全に削除できる。
 * 1投でも記録があるセッションは中断として残すため、決して削除しない。
 *
 * @param exceptId 削除対象から除外するセッションID(これから使う新規セッション等)
 * @returns 削除したセッション数
 */
export async function purgeEmptyActiveSessions(
  exceptId?: UUID
): Promise<number> {
  const sessions = await getSessions();
  let removed = 0;
  for (const session of sessions) {
    if (session.status !== "active") continue;
    if (exceptId != null && session.id === exceptId) continue;
    const throwCount = (await getThrows(session.id)).length;
    if (throwCount > 0) continue;
    await deleteSessionCascade(session.id);
    removed += 1;
  }
  return removed;
}

/** セッションを終了(完了/中断)し統計を確定する */
export async function finishSession(
  session: TrainingSession,
  status: "completed" | "aborted"
): Promise<void> {
  await saveSession({
    ...session,
    status,
    endedAt: nowIso(),
  });
  await recalcAndSaveStatistics(session.id);
}

/**
 * 中断したセッションを再開可能な状態に戻す。
 * 入力済みのセットはそのまま残り、続きのセットから再開される。
 */
export async function reopenSession(session: TrainingSession): Promise<void> {
  const { endedAt: _endedAt, ...rest } = session;
  await saveSession({ ...rest, status: "active" });
}

/** セッションの完了セット数(保存済みセット)を数える */
export async function completedSetCount(sessionId: UUID): Promise<number> {
  const sets = await getThrowSets(sessionId);
  return sets.length;
}

/** セッション概要用: 総投擲数から完了率などを出す小ヘルパー */
export function plannedThrowCountOf(setCount: number): number {
  return setCount * DARTS_PER_SET;
}
