import { Piece } from '../piece.js';
import { LessonDefinition, LessonGoalKind } from './lessonTypes.js';

/**
 * 入门课程库：十课覆盖七兵种走法、将军、将死与吃子（炮打）。
 * 课程 FEN 使用「棋盘 走子方」短格式；数据由题库完整性测试兜底校验。
 */
export const LessonLibrary: readonly LessonDefinition[] = [
  {
    id: 'move-king',
    title: '帅（将）走法',
    intro: '帅（将）限九宫内一步直行，且不能与对方将帅照脸。点击红帅，走到任意绿色落点。',
    fen: '3k5/9/9/9/9/9/9/9/9/4K4 w',
    goal: { kind: LessonGoalKind.AnyMoveOfPiece, pieceCode: Piece.RedKing },
    successText: '帅（将）走法学会了！记住：九宫之内，一步直行。',
  },
  {
    id: 'move-advisor',
    title: '仕（士）走法',
    intro: '仕（士）限九宫内沿斜线走一格，是帅（将）的贴身护卫。点击红仕，走到任意绿色落点。',
    fen: '3k5/9/9/9/9/9/9/9/4A4/4K4 w',
    goal: { kind: LessonGoalKind.AnyMoveOfPiece, pieceCode: Piece.RedAdvisor },
    successText: '仕（士）走法学会了！九宫斜行一步格。',
  },
  {
    id: 'move-bishop',
    title: '相（象）走法',
    intro:
      '相（象）走「田」字斜行两格，不能过河；田字中心有子（塞象眼）时不可走。点击红相，走到任意绿色落点。',
    fen: '3k5/9/9/9/9/9/9/9/9/4K1B2 w',
    goal: { kind: LessonGoalKind.AnyMoveOfPiece, pieceCode: Piece.RedBishop },
    successText: '相（象）走法学会了！田字飞行不过河，小心塞象眼。',
  },
  {
    id: 'move-knight',
    title: '马走日',
    intro:
      '马走「日」字：先直一格再斜一格，紧邻的直格有子（蹩马腿）时不可走。点击红马，走到任意绿色落点。',
    fen: '4k4/9/4N4/9/9/9/9/9/9/3K5 w',
    goal: { kind: LessonGoalKind.AnyMoveOfPiece, pieceCode: Piece.RedKnight },
    successText: '马走日学会了！注意蹩马腿的位置。',
  },
  {
    id: 'move-rook',
    title: '车走直线',
    intro: '车沿横竖线任意距离直行，威力最强。点击红车，走到任意绿色落点。',
    fen: '3k5/9/9/9/9/R8/9/9/9/4K4 w',
    goal: { kind: LessonGoalKind.AnyMoveOfPiece, pieceCode: Piece.RedRook },
    successText: '车走法学会了！一车十子寒，直线任驰骋。',
  },
  {
    id: 'move-cannon',
    title: '炮走法',
    intro: '炮与车一样直线行走，但吃子必须隔一个「炮架」。点击红炮，走到任意绿色落点。',
    fen: '3k5/r8/9/9/p8/C8/9/9/9/4K4 w',
    goal: { kind: LessonGoalKind.AnyMoveOfPiece, pieceCode: Piece.RedCannon },
    successText: '炮走法学会了！行走如车，吃子借架。',
  },
  {
    id: 'move-pawn',
    title: '兵（卒）走法',
    intro: '兵（卒）过河前只能前行，过河后可前行或横移，永不能后退。点击红兵，走到任意绿色落点。',
    fen: '3k5/9/9/9/4P4/9/9/9/9/4K4 w',
    goal: { kind: LessonGoalKind.AnyMoveOfPiece, pieceCode: Piece.RedPawn },
    successText: '兵（卒）走法学会了！过河小卒赛如车。',
  },
  {
    id: 'check-basic',
    title: '将军与应将',
    intro: '走一步攻击对方将（帅）即为「将军」。黑车正红车线，请走一步车形成将军。',
    fen: '4k4/9/9/9/9/3R5/9/3n5/9/3K5 w',
    goal: { kind: LessonGoalKind.AnyCheckingMove },
    successText: '会将军了！被将军一方必须应将：应将、垫子或吃掉攻击子。',
  },
  {
    id: 'mate-basic',
    title: '将死',
    intro:
      '将（帅）被将军且无法应将、垫子或吃掉攻击子，即为「将死」，对局结束。此局面红方一步可成重炮杀，请找出制胜一着。',
    fen: '3aka3/4c4/4R4/4C4/9/9/9/9/4C4/3K5 w',
    goal: { kind: LessonGoalKind.AnyMateMove },
    successText: '一步杀！将死后对局立即结束，这就是残局练习的目标。',
  },
  {
    id: 'capture-cannon',
    title: '吃子（炮打）',
    intro: '炮吃子必须隔一个棋子作炮架。请用红炮隔黑卒打掉黑车。',
    fen: '3k5/r8/9/9/p8/C8/9/9/9/4K4 w',
    goal: { kind: LessonGoalKind.AnyCaptureMove, pieceCode: Piece.BlackRook },
    successText: '炮打学会了！隔山打牛，正是炮的精髓。',
  },
];

/** 供测试与 UI 复用：按 id 查找课程。 */
export function findLesson(id: string): LessonDefinition | undefined {
  return LessonLibrary.find((lesson) => lesson.id === id);
}
