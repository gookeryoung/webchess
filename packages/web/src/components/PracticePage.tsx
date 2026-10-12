import { AppController, AppSnapshot, LessonRow, ManualRow } from '../app/AppController.js';

/**
 * 练习页面（教学 / 残局 / 打谱）：谱册式覆盖面板，替代旧版简单弹窗。
 *
 * 视觉方向「文房棋馆」：宣纸底、KaiTi 题字、朱砂印过关标记、
 * 列表项错落入场（stagger 入场动画由 CSS animation-delay 实现）。
 */

export type PageKind = 'none' | 'lesson' | 'puzzle' | 'manual';

const PAGE_TITLES: Record<Exclude<PageKind, 'none'>, string> = {
  lesson: '入门课程',
  puzzle: '残局练习',
  manual: '打谱棋谱',
};

const DIFFICULTY_NAMES: Record<number, string> = {
  1: '一步杀',
  2: '两步杀',
  3: '三步杀',
  4: '进阶连杀',
};

export function PracticePage({
  kind,
  controller,
  snapshot,
  onClose,
}: {
  kind: PageKind;
  controller: AppController;
  snapshot: AppSnapshot;
  onClose: () => void;
}) {
  if (kind === 'none') {
    return null;
  }

  return (
    <div className="page-mask" onClick={onClose}>
      <section
        className="page-panel"
        role="dialog"
        aria-label={PAGE_TITLES[kind]}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="page-header">
          <h2 className="page-title">{PAGE_TITLES[kind]}</h2>
          <button type="button" className="page-close" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="page-body">
          {kind === 'lesson' ? <LessonView controller={controller} onClose={onClose} /> : null}
          {kind === 'puzzle' ? (
            <PuzzleView
              controller={controller}
              snapshot={snapshot}
              onClose={onClose}
            />
          ) : null}
          {kind === 'manual' ? <ManualView controller={controller} snapshot={snapshot} /> : null}
        </div>
      </section>
    </div>
  );
}

function LessonView({
  controller,
  onClose,
}: {
  controller: AppController;
  onClose: () => void;
}) {
  const rows = controller.getLessonRows();
  return (
    <ul className="lesson-list">
      {rows.map((row) => (
        <LessonRowItem key={row.id} row={row} onPick={onClose} controller={controller} />
      ))}
    </ul>
  );
}

function LessonRowItem({
  row,
  controller,
  onPick,
}: {
  row: LessonRow;
  controller: AppController;
  onPick: () => void;
}) {
  const lesson = controller.lessonAt(row.index);
  return (
    <li style={{ ['--i' as string]: row.index }}>
      <button
        type="button"
        className={row.current ? 'lesson-item is-current' : 'lesson-item'}
        onClick={() => {
          if (lesson !== null) {
            controller.startLesson(lesson);
          }
          onPick();
        }}
      >
        <span className="item-title">{row.title}</span>
        <span className="item-sub">{row.intro}</span>
        {row.current ? <span className="item-flag">进行中</span> : null}
      </button>
    </li>
  );
}

function PuzzleView({
  controller,
  snapshot,
  onClose,
}: {
  controller: AppController;
  snapshot: AppSnapshot;
  onClose: () => void;
}) {
  const rows = controller.getPuzzleRows();
  return (
    <div className="puzzle-view">
      <p className="page-meta">
        已过关 <b>{snapshot.solvedCount}</b> / {snapshot.puzzleTotal} 题
      </p>
      <ul className="puzzle-list">
        {rows.map((row) => (
          <li key={row.id} style={{ ['--i' as string]: row.index }}>
            <button
              type="button"
              className={row.current ? 'puzzle-item is-current' : 'puzzle-item'}
              onClick={() => {
                const puzzle = controller.puzzleAt(row.index);
                if (puzzle !== null) {
                  controller.startPuzzle(puzzle);
                }
                onClose();
              }}
            >
              <span className="puzzle-seal" aria-hidden={row.solved ? undefined : true}>
                {row.solved ? '过' : ''}
              </span>
              <span className="item-main">
                <span className="item-title">{row.title}</span>
                <span className="item-sub">
                  {DIFFICULTY_NAMES[row.difficulty] ?? `${row.difficulty} 步`}
                  {row.attempts > 0 ? ` · 挑战 ${row.attempts} 次` : ''}
                </span>
              </span>
              {row.current ? <span className="item-flag">进行中</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ManualView({
  controller,
  snapshot,
}: {
  controller: AppController;
  snapshot: AppSnapshot;
}) {
  const rows = controller.getManualRows();
  if (rows.length === 0) {
    return (
      <p className="page-meta">
        尚未打开棋谱。点击下方「打谱」选择内置棋谱或从本地文件载入。
      </p>
    );
  }

  return (
    <div className="manual-view">
      <p className="page-meta">
        <span className="manual-name">{snapshot.practiceTitle}</span>
        {snapshot.practiceHint.length > 0 ? (
          <span className="manual-info">{snapshot.practiceHint}</span>
        ) : null}
      </p>
      <ol className="manual-list">
        {rows.map((row) => (
          <ManualRowItem key={row.depth} row={row} controller={controller} />
        ))}
      </ol>
      <p className="page-meta page-foot">
        点击任意着法可跳转；存在「变」标记处可在棋盘点击落点选择分支。
      </p>
    </div>
  );
}

function ManualRowItem({
  row,
  controller,
}: {
  row: ManualRow;
  controller: AppController;
}) {
  return (
    <li>
      <button
        type="button"
        className={row.isCurrent ? 'manual-item is-current' : 'manual-item'}
        onClick={() => controller.manualGotoDepth(row.depth)}
      >
        <span className="manual-no">{row.depth}</span>
        <span className="manual-chs">{row.chinese}</span>
        {row.annotation !== null && row.annotation.length > 0 ? (
          <span className="manual-note" title={row.annotation}>
            注
          </span>
        ) : null}
        {row.branchCount > 1 ? <span className="manual-branch">变{row.branchCount}</span> : null}
      </button>
    </li>
  );
}
