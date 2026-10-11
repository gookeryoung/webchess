#!/usr/bin/env node
/**
 * 内核冒烟：直接加载构建产物（dist），端到端验证规则、FEN、记谱三大能力。
 * 阶段验收用，仅依赖 Node 运行 ESM，不引入任何测试框架。
 */
import { Board, ChineseNotation, Move, Piece, Position, Rule } from '../packages/core/dist/index.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${actual}${ok ? '' : ` (期望 ${expected})`}`);
}

console.log('--- 内核冒烟（加载 dist 产物）---');

const board = new Board();
check('起始 FEN 往返', board.toFen(), 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1');
check('起始局面棋子数', [...board.cells].filter((p) => Piece.isValid(p)).length, 32);
check('起始合法着数', Rule.getAllLegalMoves(board, true).length, 44);

const cannonMove = new Move(new Position(7, 7), new Position(4, 7));
check('炮二平五合法', Rule.isLegalMove(board, cannonMove), true);
check('炮二平五记谱', ChineseNotation.toChinese(board, cannonMove), '炮二平五');

check('落子成功', board.doMove(cannonMove), true);
check('落子后翻边', board.redToMove, false);
check('落子后回合数', board.rounds, 2);
check('UCCI 编码', cannonMove.toUcci(), 'h2e2');
check('UCCI 往返', Move.fromUcci(cannonMove.toUcci()).equals(cannonMove), true);

console.log(failed === 0 ? '\n[smoke] 全部通过' : `\n[smoke] ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
