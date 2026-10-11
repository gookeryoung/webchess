import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { GameMode, LessonLibrary, Position, PuzzleLibrary } from '@webchess/core';
import type { AudioPlayer, KeyValueStorage, SoundEffect } from '@webchess/adapters';
import { AppController } from '../AppController.js';

/**
 * 五态模式路由集成测试（对应原 Godot Main.cs 的行为）。
 * AppController 不依赖 DOM，故可在 Node 环境中以内存适配器完整驱动。
 */

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  read(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  write(key: string, value: string): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

class RecordingAudio implements AudioPlayer {
  readonly played: SoundEffect[] = [];
  enabled = true;
  play(effect: SoundEffect): void {
    this.played.push(effect);
  }
  setEnabled(value: boolean): void {
    this.enabled = value;
  }
}

function lessonByTitle(title: string) {
  const lesson = LessonLibrary.find((l) => l.title === title);
  if (lesson === undefined) throw new Error(`缺少课程：${title}`);
  return lesson;
}

function puzzleById(id: string) {
  const puzzle = PuzzleLibrary.find((p) => p.id === id);
  if (puzzle === undefined) throw new Error(`缺少题目：${id}`);
  return puzzle;
}

function readManual(name: string): Uint8Array {
  const file = readFileSync(new URL(`../../../../core/test-data/${name}`, import.meta.url));
  return new Uint8Array(file);
}

describe('AppController 五态路由', () => {
  let storage: MemoryStorage;
  let audio: RecordingAudio;
  let controller: AppController;

  beforeEach(() => {
    storage = new MemoryStorage();
    audio = new RecordingAudio();
    controller = new AppController(storage, audio, null, true);
  });

  it('双人模式：两段式选子落子', () => {
    controller.onBoardClick(new Position(7, 7)); // 红炮
    expect(controller.getSnapshot().selected?.equals(new Position(7, 7))).toBe(true);
    expect(controller.getSnapshot().targets.length).toBeGreaterThan(0);

    controller.onBoardClick(new Position(4, 7)); // 炮二平五
    const snap = controller.getSnapshot();
    expect(snap.history).toHaveLength(1);
    expect(snap.lastMove?.toUcci()).toBe('h2e2');
    expect(snap.redToMove).toBe(false);
    expect(audio.played).toContain('move');
  });

  it('无引擎时切人机模式被拒绝', () => {
    controller.toggleMode();
    expect(controller.getSnapshot().mode).toBe(GameMode.TwoPlayers);
    expect(controller.getSnapshot().status).toContain('引擎未就绪');
  });

  it('悔棋回退一手', () => {
    controller.onBoardClick(new Position(7, 7));
    controller.onBoardClick(new Position(4, 7));
    expect(controller.getSnapshot().history).toHaveLength(1);
    controller.undo();
    expect(controller.getSnapshot().history).toHaveLength(0);
    expect(controller.getSnapshot().redToMove).toBe(true);
  });

  it('非法 FEN 载入被拒绝并给出提示', () => {
    expect(controller.loadFen('9/9 w')).toBe(false);
    expect(controller.getSnapshot().status).toContain('FEN 非法');
  });

  it('教学：完成马走日课程', () => {
    const lesson = lessonByTitle('马走日');
    controller.startLesson(lesson);
    let snap = controller.getSnapshot();
    expect(snap.practice).toBe('lesson');
    expect(snap.practiceTitle).toBe('马走日');

    const knight = new Position(4, 2);
    controller.onBoardClick(knight);
    controller.onBoardClick(new Position(3, 0));
    snap = controller.getSnapshot();
    expect(snap.history).toHaveLength(1);
    expect(snap.status).toContain(lesson.successText);
  });

  it('残局：走正解过关并持久化进度', () => {
    const puzzle = puzzleById('mate1-chongpao');
    controller.startPuzzle(puzzle);
    expect(controller.getSnapshot().practice).toBe('puzzle');

    // 先走一步错着：被拒绝且不推进。
    controller.onBoardClick(new Position(4, 3));
    controller.onBoardClick(new Position(4, 4));
    expect(controller.getSnapshot().status).toContain('请重试');

    // 正解：e7e8 = 车 (4,2) → (4,1)
    controller.onBoardClick(new Position(4, 2));
    controller.onBoardClick(new Position(4, 1));
    const snap = controller.getSnapshot();
    expect(snap.status).toContain('过关');
    expect(snap.solvedCount).toBe(1);
    // 进度已写入存储。
    expect(storage.read('puzzle_progress')).toContain('mate1-chongpao');
  });

  it('打谱：载入 XQF 棋谱并前进/回退', () => {
    controller.openManual({ name: '测试棋谱', bytes: readManual('test_manual_v10.xqf') });
    let snap = controller.getSnapshot();
    expect(snap.manualOpen).toBe(true);
    expect(snap.manualTotal).toBe(4);
    expect(snap.manualDepth).toBe(0);

    controller.manualForward();
    snap = controller.getSnapshot();
    expect(snap.manualDepth).toBe(1);
    expect(snap.history).toHaveLength(1);

    controller.undo();
    snap = controller.getSnapshot();
    expect(snap.manualDepth).toBe(0);
    expect(snap.history).toHaveLength(0);

    controller.manualForward();
    controller.manualRewind();
    expect(controller.getSnapshot().manualDepth).toBe(0);
  });

  it('打谱：PGN 棋谱可载入', () => {
    const text = readFileSync(
      new URL('../../../../core/test-data/manual_iccs.pgn', import.meta.url),
      'utf8',
    );
    controller.openManual({ name: 'ICCS 样例', text });
    expect(controller.getSnapshot().manualOpen).toBe(true);
    expect(controller.getSnapshot().manualTotal).toBeGreaterThan(0);
  });

  it('退出练习复位到新对局', () => {
    controller.startPuzzle(puzzleById('mate1-chongpao'));
    expect(controller.getSnapshot().practice).toBe('puzzle');
    controller.exitPractice();
    const snap = controller.getSnapshot();
    expect(snap.practice).toBe('none');
    expect(snap.history).toHaveLength(0);
    expect(snap.fen).toContain('rnbakabnr');
  });

  it('新局与音效开关', () => {
    controller.onBoardClick(new Position(7, 7));
    controller.onBoardClick(new Position(4, 7));
    controller.newGame();
    expect(controller.getSnapshot().history).toHaveLength(0);

    controller.setSoundEnabled(false);
    expect(audio.enabled).toBe(false);
  });

  it('订阅通知在状态变化时触发', () => {
    let notified = 0;
    const unsubscribe = controller.subscribe(() => {
      notified++;
    });
    controller.newGame();
    expect(notified).toBeGreaterThan(0);
    unsubscribe();
  });
});
