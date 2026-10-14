import { useState } from 'react';
import { EngineOptions, GameMode } from '@webchess/core';
import { AppController, AppSnapshot } from '../app/AppController.js';
import { Modal } from './Modal.js';

/**
 * 控制面板（对应原 Godot HudPanel）：保留其 17 个事件契约中 Web 端需要的部分，
 * 控件改为 DOM 实现，触摸目标高度 ≥44px。
 */
export function Hud({
  controller,
  snapshot,
  onOpenLessons,
  onOpenPuzzles,
  onOpenManuals,
}: {
  controller: AppController;
  snapshot: AppSnapshot;
  onOpenLessons: () => void;
  onOpenPuzzles: () => void;
  onOpenManuals: () => void;
}) {
  const [fenInput, setFenInput] = useState('');
  const [showFen, setShowFen] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [limitStrength, setLimitStrength] = useState(false);
  const [elo, setElo] = useState(1600);
  const [soundOn, setSoundOn] = useState(true);

  const practicing = snapshot.practice !== 'none';

  return (
    <div className="hud">
      <div className="status">{snapshot.status}</div>

      <div className="row">
        <button type="button" className="btn" onClick={() => controller.newGame()}>
          新局
        </button>
        <button type="button" className="btn" onClick={() => controller.undo()}>
          悔棋
        </button>
        <button type="button" className="btn" onClick={() => void controller.requestHint()}>
          提示
        </button>
        <button
          type="button"
          className={snapshot.analysisActive ? 'btn btn-on' : 'btn'}
          onClick={() => void controller.analyze()}
        >
          分析
        </button>
        <button
          type="button"
          className={snapshot.mode === GameMode.PlayWithEngine ? 'btn btn-on' : 'btn'}
          onClick={() => controller.toggleMode()}
        >
          {snapshot.mode === GameMode.PlayWithEngine ? '人机' : '双人'}
        </button>
      </div>

      <div className="row">
        <button type="button" className="btn" onClick={onOpenLessons}>
          入门课程
        </button>
        <button type="button" className="btn" onClick={onOpenPuzzles}>
          残局练习
        </button>
        <button type="button" className="btn" onClick={onOpenManuals}>
          打谱
        </button>
        {practicing ? (
          <button type="button" className="btn" onClick={() => controller.exitPractice()}>
            退出练习
          </button>
        ) : null}
      </div>

      {snapshot.manualOpen ? (
        <div className="row">
          <button type="button" className="btn" onClick={() => controller.manualRewind()}>
            ⏮ 开局
          </button>
          <button type="button" className="btn" onClick={() => controller.undo()}>
            ⏪ 后退
          </button>
          <button type="button" className="btn" onClick={() => controller.manualForward()}>
            前进 ⏩
          </button>
          <span className="badge">
            {snapshot.manualDepth}/{snapshot.manualTotal}
          </span>
        </div>
      ) : null}

      <div className="row">
        <button type="button" className="btn" onClick={() => void controller.copyFen()}>
          复制 FEN
        </button>
        <button type="button" className="btn" onClick={() => setShowFen(true)}>
          载入 FEN
        </button>
        <button type="button" className="btn" onClick={() => setShowOptions(true)}>
          引擎设置
        </button>
        <button
          type="button"
          className={soundOn ? 'btn btn-on' : 'btn'}
          onClick={() => {
            const next = !soundOn;
            setSoundOn(next);
            controller.setSoundEnabled(next);
          }}
        >
          音效
        </button>
        <button type="button" className="btn" onClick={() => setShowAbout(true)}>
          关于
        </button>
      </div>

      {snapshot.evalLines.length > 0 ? (
        <div className="eval">
          {snapshot.evalLines.map((line) => (
            <div key={line} className="eval-line">
              {line}
            </div>
          ))}
        </div>
      ) : null}

      <div className="meta">
        <span>{snapshot.redToMove ? '红方走子' : '黑方走子'}</span>
        <span>残局 {snapshot.solvedCount}/{snapshot.puzzleTotal} 已过关</span>
        {snapshot.busy ? <span className="busy">思考中…</span> : null}
        {snapshot.isDraw ? <span className="over">和棋</span> : null}
        {!snapshot.isDraw && snapshot.isGameOver ? (
          <span className="over">{snapshot.result === 'red-win' ? '红方胜' : '黑方胜'}</span>
        ) : null}
        {snapshot.gb18030Ready ? null : <span className="warn">GB18030 未就绪（中文棋谱元信息降级）</span>}
      </div>

      {showFen ? (
        <Modal
          title="载入 FEN 局面"
          okText="载入"
          onOk={() => {
            if (fenInput.trim().length > 0) {
              controller.loadFen(fenInput.trim());
            }
          }}
          onCancel={() => setShowFen(false)}
        >
          <input
            className="fen-input"
            value={fenInput}
            placeholder="rnbakabnr/9/1c5c1/... w - - 0 1"
            onChange={(e) => setFenInput(e.target.value)}
          />
        </Modal>
      ) : null}

      {showOptions ? (
        <Modal
          title="引擎设置"
          okText="应用"
          onOk={() => {
            const options: EngineOptions = {
              limitStrength,
              elo,
            };
            controller.setEngineOptions(options);
          }}
          onCancel={() => setShowOptions(false)}
        >
          <label className="field">
            <input
              type="checkbox"
              checked={limitStrength}
              onChange={(e) => setLimitStrength(e.target.checked)}
            />
            限制棋力（UCI_Elo）
          </label>
          <label className="field">
            Elo {elo}
            <input
              type="range"
              min={1280}
              max={3199}
              step={1}
              value={elo}
              disabled={!limitStrength}
              onChange={(e) => setElo(Number(e.target.value))}
            />
          </label>
        </Modal>
      ) : null}

      {showAbout ? (
        <Modal title="关于 SuperChess Web" okText="好的" onCancel={() => setShowAbout(false)}>
          <p>
            中国象棋训练与 AI 练习工具，内核与界面解耦，规则引擎移植自 SuperChess（Godot C#）。
          </p>
          <p>引擎：内置 TypeScript alpha-beta 搜索引擎（Web Worker 中运行）。</p>
          <p>项目代码 MIT；棋子与音效资产沿用 chinese-chess-fish-android（MIT）。</p>
        </Modal>
      ) : null}
    </div>
  );
}
