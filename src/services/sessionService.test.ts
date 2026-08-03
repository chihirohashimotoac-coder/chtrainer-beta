import { describe, expect, it } from "vitest";
import { SOFT_BOARD, STEEL_BOARD } from "../config/boardProfiles";
import { getSessions, getThrows, getThrowSets, saveSession } from "../db/db";
import { landingFromCoordinate } from "../domain/landing";
import { buildSessionCsv } from "../export/csv";
import { buildAnalysisMarkdown } from "../export/markdown";
import { fixtureSession, T20 } from "../test/fixtures";
import { buildSkillCheckPlan } from "../domain/skillCheck";
import {
  commitSet,
  purgeEmptyActiveSessions,
  recalcAndSaveStatistics,
  updateThrowLanding,
} from "./sessionService";

describe("session commit/export flow", () => {
  it("persists a 60 throw session and exports all throws", async () => {
    const session = fixtureSession({
      id: "session-60-integration",
      setCount: 20,
      plannedThrowCount: 60,
      plannedTargets: Array.from({ length: 20 }, () => [T20, T20, T20]),
      progress: { currentSetNumber: 20, middleAssessmentDone: true },
      status: "completed",
    });
    await saveSession(session);

    const rep = T20.representativePoint;
    for (let setNumber = 1; setNumber <= 20; setNumber += 1) {
      await commitSet(
        session,
        setNumber,
        [1, 2, 3].map((dartInSet) => ({
          dartInSet: dartInSet as 1 | 2 | 3,
          target: T20,
          landing: landingFromCoordinate(
            rep.x + setNumber * 0.001,
            rep.y + dartInSet * 0.001,
            STEEL_BOARD
          ),
        })),
        undefined,
        session.startedAt
      );
    }

    const sets = await getThrowSets(session.id);
    const throws = await getThrows(session.id);
    const stats = await recalcAndSaveStatistics(session.id);
    const setNumberOf = (setId: string) =>
      sets.find((set) => set.id === setId)?.setNumber ?? 0;

    expect(sets).toHaveLength(20);
    expect(throws).toHaveLength(60);
    expect(stats?.completedThrows).toBe(60);

    const markdown = buildAnalysisMarkdown({
      session,
      player: undefined,
      equipment: undefined,
      stats: stats!,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: true,
    });
    const csv = buildSessionCsv(session, throws, setNumberOf);

    expect(markdown).toContain("| 60 | 20 | 3 |");
    expect(csv.trim().split("\r\n")).toHaveLength(61);
  });

  it("再開後も開始時スナップショットのダーツ色を使う", async () => {
    const session = fixtureSession({
      id: "session-snapshot-colors",
      setCount: 1,
      plannedThrowCount: 3,
      contextSnapshot: {
        capturedAt: "2026-01-01T10:00:00.000Z",
        displayName: "開始時プレイヤー",
        dominantHand: "right",
        dartColors: ["#111111", "#222222", "#333333"],
        boardType: "steel",
        inputMethod: "coordinate",
      },
    });
    await saveSession(session);
    const rep = T20.representativePoint;
    await commitSet(
      session,
      1,
      [1, 2, 3].map((dartInSet) => ({
        dartInSet: dartInSet as 1 | 2 | 3,
        target: T20,
        landing: landingFromCoordinate(rep.x, rep.y, STEEL_BOARD),
      })),
      {
        schemaVersion: 2,
        id: "edited-player",
        displayName: "編集後",
        dominantHand: "right",
        defaultBoardType: "steel",
        dartColors: ["#aaaaaa", "#bbbbbb", "#cccccc"],
        defaultInputMethod: "coordinate",
        vibrationEnabled: false,
        soundEnabled: false,
        autoAdvanceEnabled: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T11:00:00.000Z",
      },
      session.startedAt
    );

    const saved = await getThrows(session.id);
    expect(saved.map((record) => record.dartColor)).toEqual([
      "#111111",
      "#222222",
      "#333333",
    ]);
  });

  it("セット境界の1投目は前投命中・切替直後をN/Aに保つ", async () => {
    const session = fixtureSession({ id: "session-cross-set-correction" });
    await saveSession(session);
    const rep = T20.representativePoint;
    const darts = [1, 2, 3].map((dartInSet) => ({
      dartInSet: dartInSet as 1 | 2 | 3,
      target: T20,
      landing: landingFromCoordinate(rep.x, rep.y, STEEL_BOARD),
    }));
    await commitSet(session, 1, darts, undefined, session.startedAt);
    await commitSet(session, 2, darts, undefined, session.startedAt);

    const before = await getThrows(session.id);
    expect(before[3]?.derived.previousThrowWasHit).toBeUndefined();
    expect(before[3]?.derived.previousThrowWasHitInSameSet).toBeUndefined();
    expect(before[3]?.derived.sameTargetAsPrevious).toBeUndefined();
    expect(before[3]?.derived.targetChangedFromPrevious).toBe(false);
    await updateThrowLanding(
      before[2]!,
      landingFromCoordinate(rep.x + 0.3, rep.y, STEEL_BOARD)
    );

    const after = await getThrows(session.id);
    expect(after[3]?.derived.previousThrowWasHit).toBeUndefined();
    expect(after[3]?.derived.previousThrowWasHitInSameSet).toBeUndefined();
  });

  it("updateThrowLandingで矢速を保持・更新・クリアできる", async () => {
    const session = fixtureSession({ id: "session-speed-edit" });
    await saveSession(session);
    const rep = T20.representativePoint;
    await commitSet(
      session,
      1,
      [1, 2, 3].map((dartInSet) => ({
        dartInSet: dartInSet as 1 | 2 | 3,
        target: T20,
        landing: landingFromCoordinate(rep.x, rep.y, STEEL_BOARD),
        ...(dartInSet === 1 ? { speedKmh: 60 } : {}),
      })),
      undefined,
      session.startedAt
    );
    const landing = landingFromCoordinate(rep.x, rep.y, STEEL_BOARD);
    let throws = await getThrows(session.id);
    // undefined = 既存値を保持
    await updateThrowLanding(throws[0]!, landing);
    // 数値 = 更新
    await updateThrowLanding(throws[1]!, landing, undefined, 58.9);
    throws = await getThrows(session.id);
    expect(throws[0]?.speedKmh).toBe(60);
    expect(throws[1]?.speedKmh).toBe(58.9);
    // null = クリア
    await updateThrowLanding(throws[0]!, landing, undefined, null);
    throws = await getThrows(session.id);
    expect(throws[0]?.speedKmh).toBeUndefined();
  });

  it("R4切替パターンのメタデータと同一セット内切替だけを保存する", async () => {
    const targets = buildSkillCheckPlan(SOFT_BOARD, 20, "fat_bull")[17]!;
    const session = fixtureSession({
      id: "session-r4-switch",
      setCount: 1,
      plannedThrowCount: 3,
      plannedTargets: [targets],
      trainingMode: "skill_check",
    });
    await saveSession(session);
    await commitSet(
      session,
      1,
      targets.map((target, index) => ({
        dartInSet: (index + 1) as 1 | 2 | 3,
        target,
        landing: landingFromCoordinate(
          target.representativePoint.x,
          target.representativePoint.y,
          SOFT_BOARD
        ),
      })),
      undefined,
      session.startedAt
    );
    const [set] = await getThrowSets(session.id);
    expect(set).toMatchObject({
      roundId: "skill-r4",
      roundKind: "checkout",
      evaluationKind: "exact_hit",
      patternId: "r4-route-20",
      patternKind: "switch",
    });
    const saved = await getThrows(session.id);
    expect(saved.map((record) => record.derived.targetChangedFromPrevious)).toEqual([
      false,
      true,
      true,
    ]);
    expect(saved.map((record) => record.derived.sameSetAsPrevious)).toEqual([
      false,
      true,
      true,
    ]);

    const fixedTargets = buildSkillCheckPlan(SOFT_BOARD, 20, "fat_bull")[15]!;
    const fixedSession = fixtureSession({
      id: "session-r4-fixed",
      setCount: 1,
      plannedThrowCount: 3,
      plannedTargets: [fixedTargets],
      trainingMode: "skill_check",
    });
    await saveSession(fixedSession);
    await commitSet(
      fixedSession,
      1,
      fixedTargets.map((target, index) => ({
        dartInSet: (index + 1) as 1 | 2 | 3,
        target,
        landing: landingFromCoordinate(
          target.representativePoint.x,
          target.representativePoint.y,
          SOFT_BOARD
        ),
      })),
      undefined,
      fixedSession.startedAt
    );
    expect(
      (await getThrows(fixedSession.id)).map(
        (record) => record.derived.targetChangedFromPrevious
      )
    ).toEqual([false, false, false]);
  });
});

describe("空の進行中セッションの掃除", () => {
  it("0投の進行中セッションだけを削除し、投擲のあるものは残す", async () => {
    const empty1 = fixtureSession({
      id: "purge-empty-1",
      status: "active",
      startedAt: "2026-02-01T10:00:00.000Z",
    });
    const empty2 = fixtureSession({
      id: "purge-empty-2",
      status: "active",
      startedAt: "2026-02-01T11:00:00.000Z",
    });
    const withThrows = fixtureSession({
      id: "purge-has-throws",
      status: "active",
      startedAt: "2026-02-01T12:00:00.000Z",
    });
    const completedEmpty = fixtureSession({
      id: "purge-completed-empty",
      status: "completed",
      startedAt: "2026-02-01T09:00:00.000Z",
    });
    const brandNew = fixtureSession({
      id: "purge-brand-new",
      status: "active",
      startedAt: "2026-02-01T13:00:00.000Z",
    });
    for (const s of [empty1, empty2, withThrows, completedEmpty, brandNew]) {
      await saveSession(s);
    }
    // 1投でも記録があるセッションは中断として残す必要がある
    await commitSet(
      withThrows,
      1,
      [1, 2, 3].map((dartInSet) => ({
        dartInSet: dartInSet as 1 | 2 | 3,
        target: T20,
        landing: landingFromCoordinate(
          T20.representativePoint.x,
          T20.representativePoint.y,
          STEEL_BOARD
        ),
      })),
      undefined,
      withThrows.startedAt
    );

    const removed = await purgeEmptyActiveSessions(brandNew.id);
    expect(removed).toBe(2);

    const ids = (await getSessions()).map((s) => s.id);
    expect(ids).not.toContain("purge-empty-1");
    expect(ids).not.toContain("purge-empty-2");
    // 投擲があるもの・完了済み・除外指定したものは残る
    expect(ids).toContain("purge-has-throws");
    expect(ids).toContain("purge-completed-empty");
    expect(ids).toContain("purge-brand-new");
    expect((await getThrows("purge-has-throws")).length).toBe(3);
  });

  it("除外指定を外せば次回に掃除され、その後は0件で安定する", async () => {
    // 前テストで除外した purge-brand-new は0投のままなので、次の掃除で消える
    expect(await purgeEmptyActiveSessions()).toBe(1);
    expect((await getSessions()).map((s) => s.id)).not.toContain(
      "purge-brand-new"
    );

    // 対象が尽きたら何も変更しない(繰り返し呼んでも安全)
    const before = (await getSessions()).map((s) => s.id).sort();
    expect(await purgeEmptyActiveSessions()).toBe(0);
    expect((await getSessions()).map((s) => s.id).sort()).toEqual(before);
    expect((await getThrows("purge-has-throws")).length).toBe(3);
  });
});
