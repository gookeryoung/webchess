import { describe, expect, it } from 'vitest';
import { PuzzleProgress } from '../game/puzzleProgress.js';

describe('PuzzleProgress', () => {
  it('初始进度为空', () => {
    const progress = new PuzzleProgress();
    expect(progress.solvedCount).toBe(0);
    expect(progress.solvedIds).toHaveLength(0);
    expect(progress.isSolved('x')).toBe(false);
    expect(progress.attempts('x')).toBe(0);
  });

  it('MarkAttempt 累加尝试次数但不标记过关', () => {
    const progress = new PuzzleProgress();
    progress.markAttempt('p1');
    progress.markAttempt('p1');
    expect(progress.attempts('p1')).toBe(2);
    expect(progress.isSolved('p1')).toBe(false);
    expect(progress.solvedCount).toBe(0);
  });

  it('MarkSolved 标记过关且幂等', () => {
    const progress = new PuzzleProgress();
    progress.markSolved('p1');
    progress.markSolved('p1');
    expect(progress.isSolved('p1')).toBe(true);
    expect(progress.solvedCount).toBe(1);
    // 过关不增加尝试计数。
    expect(progress.attempts('p1')).toBe(0);
  });

  it('JSON 往返保留进度', () => {
    const progress = new PuzzleProgress();
    progress.markAttempt('p1');
    progress.markSolved('p2');
    const restored = PuzzleProgress.fromJson(progress.toJson());
    expect(restored.attempts('p1')).toBe(1);
    expect(restored.isSolved('p2')).toBe(true);
    expect(restored.solvedIds).toEqual(['p2']);
  });

  it('空或非法 JSON 降级为空进度（不阻塞启动）', () => {
    expect(PuzzleProgress.fromJson('').solvedCount).toBe(0);
    expect(PuzzleProgress.fromJson('   ').solvedCount).toBe(0);
    expect(PuzzleProgress.fromJson(null).solvedCount).toBe(0);
    expect(PuzzleProgress.fromJson('{ not json }').solvedCount).toBe(0);
    expect(PuzzleProgress.fromJson('"string"').solvedCount).toBe(0);
  });

  it('进度条目缺字段时按默认值填充', () => {
    const restored = PuzzleProgress.fromJson('{"p1":{"Solved":true}}');
    expect(restored.isSolved('p1')).toBe(true);
    expect(restored.attempts('p1')).toBe(0);
  });
});
