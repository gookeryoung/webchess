import { PuzzleDefinition, PuzzleMoveNode } from './puzzleTypes.js';

/**
 * 残局题库：由 build/gen_puzzles.py 全量再生（Pikafish depth 16 + pyffish 真将死过滤），
 * 手工编辑无效。着法树 DSL：R=根（children 为并列正解首着），N=持有 UCCI 着法的节点。
 *
 * 移植自 SuperChess Scripts/Game/PuzzleLibrary.cs（50 题，数据逐字搬运）。
 */

/** 树构建 DSL：根节点（children 为并列正解首着）。 */
function R(...children: PuzzleMoveNode[]): PuzzleMoveNode {
  const root = new PuzzleMoveNode();
  for (const child of children) {
    root.addChild(child);
  }

  return root;
}

/** 树构建 DSL：持有 UCCI 走法的节点（children 为后续线/并列分支）。 */
function N(ucci: string, ...children: PuzzleMoveNode[]): PuzzleMoveNode {
  const node = new PuzzleMoveNode(ucci);
  for (const child of children) {
    node.addChild(child);
  }

  return node;
}

/** 全部内置残局题（按难度升序排列）。 */
export const PuzzleLibrary: readonly PuzzleDefinition[] = [
  {
    id: 'mate1-chongpao',
    title: '重炮杀',
    description: '红先一步杀：双炮重叠镇住宫心线，前炮作架后炮叫将。找到制胜一着。',
    difficulty: 1,
    fen: '3aka3/4c4/4R4/4C4/9/2p6/9/9/4C4/3K5 w - - 0 1',
    root: R(N('e7e8')),
  },
  {
    id: 'mate1-chongpao-j',
    title: '重炮杀·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4c4/4R4/4C4/9/6p2/9/9/4C4/5K3 w - - 0 1',
    root: R(N('e7e8')),
  },
  {
    id: 'mate1-chongpao-x1',
    title: '重炮杀·一步杀（变式）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3akab2/4c4/4R4/4C4/9/2p6/9/9/4C4/3K5 w - - 0 1',
    root: R(N('e7e8')),
  },
  {
    id: 'mate1-chongpao-x1-j',
    title: '重炮杀·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '2baka3/4c4/4R4/4C4/9/6p2/9/9/4C4/5K3 w - - 0 1',
    root: R(N('e7e8')),
  },
  {
    id: 'mate1-chongpao-x2',
    title: '重炮杀·一步杀（变式）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4c4/4R4/4C4/9/2p6/p8/9/4C4/3K5 w - - 0 1',
    root: R(N('e7e8')),
  },
  {
    id: 'mate1-chongpao-x2-j',
    title: '重炮杀·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4c4/4R4/4C4/9/6p2/8p/9/4C4/5K3 w - - 0 1',
    root: R(N('e7e8')),
  },
  {
    id: 'mate1-chongpao-x3',
    title: '重炮杀·一步杀（变式）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4c4/4R4/4C4/9/2p6/9/9/4C4/2BK5 w - - 0 1',
    root: R(N('e7e8')),
  },
  {
    id: 'mate1-chongpao-x3-j',
    title: '重炮杀·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4c4/4R4/4C4/9/6p2/9/9/4C4/5KB2 w - - 0 1',
    root: R(N('e7e8')),
  },
  {
    id: 'mate1-menggong',
    title: '闷宫杀',
    description: '红先一步杀：跳马卧槽叫将，车锁宫心，闷杀宫顶。找到制胜一着。',
    difficulty: 1,
    fen: '3aka3/4n4/4R4/9/2N6/2p6/9/9/9/3K5 w - - 0 1',
    root: R(N('c5d7')),
  },
  {
    id: 'mate1-menggong-j',
    title: '闷宫杀·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4n4/4R4/9/6N2/6p2/9/9/9/5K3 w - - 0 1',
    root: R(N('g5f7')),
  },
  {
    id: 'mate1-menggong-x1',
    title: '闷宫杀·一步杀（变式）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3akab2/4n4/4R4/9/2N6/2p6/9/9/9/3K5 w - - 0 1',
    root: R(N('c5d7')),
  },
  {
    id: 'mate1-menggong-x1-j',
    title: '闷宫杀·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '2baka3/4n4/4R4/9/6N2/6p2/9/9/9/5K3 w - - 0 1',
    root: R(N('g5f7')),
  },
  {
    id: 'mate1-menggong-x2',
    title: '闷宫杀·一步杀（变式）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4n4/4R4/8p/2N6/2p6/9/9/9/3K5 w - - 0 1',
    root: R(N('c5d7')),
  },
  {
    id: 'mate1-menggong-x2-j',
    title: '闷宫杀·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4n4/4R4/p8/6N2/6p2/9/9/9/5K3 w - - 0 1',
    root: R(N('g5f7')),
  },
  {
    id: 'mate1-menggong-x3',
    title: '闷宫杀·一步杀（变式）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4n4/4R4/9/2N6/2p6/9/9/9/2BK5 w - - 0 1',
    root: R(N('c5d7')),
  },
  {
    id: 'mate1-menggong-x3-j',
    title: '闷宫杀·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4n4/4R4/9/6N2/6p2/9/9/9/5KB2 w - - 0 1',
    root: R(N('g5f7')),
  },
  {
    id: 'mate1-wocaoma',
    title: '卧槽马',
    description: '红先一步杀：马奔卧槽，直取宫顶。找到制胜一着。',
    difficulty: 1,
    fen: '3aka3/4n4/9/9/4N4/9/9/9/9/3K5 w - - 0 1',
    root: R(N('e5d7'), N('e5f7')),
  },
  {
    id: 'mate1-wocaoma-j',
    title: '卧槽马·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4n4/9/9/4N4/9/9/9/9/5K3 w - - 0 1',
    root: R(N('e5d7'), N('e5f7')),
  },
  {
    id: 'mate1-wocaoma-x1',
    title: '卧槽马·一步杀（变式）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3akab2/4n4/9/9/4N4/9/9/9/9/3K5 w - - 0 1',
    root: R(N('e5d7'), N('e5f7')),
  },
  {
    id: 'mate1-wocaoma-x1-j',
    title: '卧槽马·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '2baka3/4n4/9/9/4N4/9/9/9/9/5K3 w - - 0 1',
    root: R(N('e5d7'), N('e5f7')),
  },
  {
    id: 'mate1-wocaoma-x2',
    title: '卧槽马·一步杀（变式）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4n4/9/p8/4N4/9/9/9/9/3K5 w - - 0 1',
    root: R(N('e5d7'), N('e5f7')),
  },
  {
    id: 'mate1-wocaoma-x2-j',
    title: '卧槽马·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4n4/9/8p/4N4/9/9/9/9/5K3 w - - 0 1',
    root: R(N('e5d7'), N('e5f7')),
  },
  {
    id: 'mate1-wocaoma-x3',
    title: '卧槽马·一步杀（变式）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4n4/9/9/4N4/9/9/9/9/2BK5 w - - 0 1',
    root: R(N('e5d7'), N('e5f7')),
  },
  {
    id: 'mate1-wocaoma-x3-j',
    title: '卧槽马·一步杀（镜像）',
    description: '红先一步杀（1 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 1,
    fen: '3aka3/4n4/9/9/4N4/9/9/9/9/5KB2 w - - 0 1',
    root: R(N('e5d7'), N('e5f7')),
  },
  {
    id: 'mate2-mapao',
    title: '马炮杀',
    description: '红先两步杀：马扑宫顶作炮架，炮镇中线马炮合击。',
    difficulty: 2,
    fen: '4k4/9/9/9/9/8N/9/9/4C4/3K5 w - - 0 1',
    root: R(N('i4g5', N('e9e8', N('g5e6')))),
  },
  {
    id: 'mate2-mapao-j',
    title: '马炮杀·两步杀（镜像）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '4k4/9/9/9/9/N8/9/9/4C4/5K3 w - - 0 1',
    root: R(N('a4c5', N('e9e8', N('c5e6')))),
  },
  {
    id: 'mate2-mapao-x3',
    title: '马炮杀·两步杀（变式）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '4k4/9/9/9/9/8N/9/9/4C4/2BK5 w - - 0 1',
    root: R(N('i4g5', N('e9e8', N('g5e6')))),
  },
  {
    id: 'mate2-mapao-x3-j',
    title: '马炮杀·两步杀（镜像）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '4k4/9/9/9/9/N8/9/9/4C4/5KB2 w - - 0 1',
    root: R(N('a4c5', N('e9e8', N('c5e6')))),
  },
  {
    id: 'mate2-shuangche',
    title: '双车错杀',
    description: '红先两步杀：双车交错叫将，轮番进攻直取老将。',
    difficulty: 2,
    fen: '4k4/9/9/9/9/8R/9/9/R8/3K5 w - - 0 1',
    root: R(
      N('i4e4', N('e9f9', N('a1f1'))),
      N('a1f1', N('e9e8', N('i4e4'))),
      N('i4f4', N('e9e8', N('a1e1'))),
    ),
  },
  {
    id: 'mate2-shuangche-j',
    title: '双车错杀·两步杀（镜像）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '4k4/9/9/9/9/R8/9/9/8R/5K3 w - - 0 1',
    root: R(
      N('i1e1', N('e9d9', N('a4d4'))),
      N('i1d1', N('e9e8', N('a4e4'))),
      N('a4d4', N('e9e8', N('i1e1'))),
    ),
  },
  {
    id: 'mate2-shuangche-x2',
    title: '双车错杀·两步杀（变式）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '4k4/9/9/9/9/8R/4p4/9/R8/3K5 w - - 0 1',
    root: R(N('i4i8', N('e3e2', N('a1a9'))), N('a1a8', N('e3e2', N('i4i9')))),
  },
  {
    id: 'mate2-shuangche-x2-j',
    title: '双车错杀·两步杀（镜像）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '4k4/9/9/9/9/R8/4p4/9/8R/5K3 w - - 0 1',
    root: R(N('i1i8', N('e3e2', N('a4a9'))), N('a4a8', N('e3e2', N('i1i9')))),
  },
  {
    id: 'mate2-shuangche-x3',
    title: '双车错杀·两步杀（变式）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '4k4/9/9/9/9/8R/9/9/R8/2BK5 w - - 0 1',
    root: R(
      N('a1e1', N('e9f9', N('i4f4'))),
      N('a1f1', N('e9e8', N('i4e4'))),
      N('i4e4', N('e9f9', N('a1f1'))),
    ),
  },
  {
    id: 'mate2-shuangche-x3-j',
    title: '双车错杀·两步杀（镜像）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '4k4/9/9/9/9/R8/9/9/8R/5KB2 w - - 0 1',
    root: R(
      N('i1d1', N('e9e8', N('a4e4'))),
      N('a4e4', N('e9d9', N('i1d1'))),
      N('i1e1', N('e9d9', N('a4d4'))),
    ),
  },
  {
    id: 'mate2-shuangchedan',
    title: '双车胁士',
    description: '红先两步杀：双车逼宫，士斜飞亦难解杀。',
    difficulty: 2,
    fen: '3ak4/9/9/9/9/8R/9/9/R8/3K5 w - - 0 1',
    root: R(N('i4e4', N('d9e8', N('a1a9'))), N('a1e1', N('d9e8', N('i4i9')))),
  },
  {
    id: 'mate2-shuangchedan-j',
    title: '双车胁士·两步杀（镜像）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '4ka3/9/9/9/9/R8/9/9/8R/5K3 w - - 0 1',
    root: R(N('i1e1', N('f9e8', N('a4a9'))), N('a4e4', N('f9e8', N('i1i9')))),
  },
  {
    id: 'mate2-shuangchedan-x3',
    title: '双车胁士·两步杀（变式）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '3ak4/9/9/9/9/8R/9/9/R8/2BK5 w - - 0 1',
    root: R(N('i4e4', N('d9e8', N('a1a9'))), N('a1e1', N('d9e8', N('i4i9')))),
  },
  {
    id: 'mate2-shuangchedan-x3-j',
    title: '双车胁士·两步杀（镜像）',
    description: '红先两步杀（3 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 2,
    fen: '4ka3/9/9/9/9/R8/9/9/8R/5KB2 w - - 0 1',
    root: R(N('a4e4', N('f9e8', N('i1i9'))), N('i1e1', N('f9e8', N('a4a9')))),
  },
  {
    id: 'mate2-shuangche-x1',
    title: '双车错杀·三步杀（变式）',
    description: '红先三步杀（5 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 3,
    fen: '2b1k4/9/9/9/9/8R/9/9/R8/3K5 w - - 0 1',
    root: R(
      N(
        'a1a8',
        N(
          'c9e7',
          N('i4i9', N('e7g9', N('i9g9'))),
          N('i4d4', N('e7c5', N('d4d9'))),
        ),
      ),
      N(
        'i4i9',
        N(
          'e9e8',
          N('a1a8', N('e8e7', N('i9i7'))),
          N('i9f9', N('c9a7', N('a1e1'))),
        ),
      ),
      N('i4e4', N('c9e7', N('e4e7', N('e9f9', N('a1f1'))))),
    ),
  },
  {
    id: 'mate2-shuangche-x1-j',
    title: '双车错杀·三步杀（镜像）',
    description: '红先三步杀（5 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 3,
    fen: '4k1b2/9/9/9/9/R8/9/9/8R/5K3 w - - 0 1',
    root: R(
      N('a4e4', N('g9e7', N('e4e7', N('e9d9', N('i1d1'))))),
      N(
        'i1i8',
        N(
          'g9e7',
          N('a4a9', N('e7c9', N('a9c9'))),
          N('i8d8', N('e7c5', N('a4a9'))),
        ),
      ),
      N(
        'a4a9',
        N(
          'e9e8',
          N('a9d9', N('g9e7', N('i1i8'))),
          N('i1i8', N('e8e7', N('a9a7'))),
        ),
      ),
    ),
  },
  {
    id: 'mate2-shuangchedan-x1',
    title: '双车胁士·三步杀（变式）',
    description: '红先三步杀（5 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 3,
    fen: '2bak4/9/9/9/9/8R/9/9/R8/3K5 w - - 0 1',
    root: R(
      N('a1e1', N('c9e7', N('e1e7', N('d9e8', N('i4i9'))))),
      N(
        'i4i9',
        N(
          'e9e8',
          N('a1a8', N('e8e7', N('i9i7'))),
          N('i9f9', N('c9a7', N('a1e1'))),
        ),
      ),
    ),
  },
  {
    id: 'mate2-shuangchedan-x1-j',
    title: '双车胁士·三步杀（镜像）',
    description: '红先三步杀（5 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 3,
    fen: '4kab2/9/9/9/9/R8/9/9/8R/5K3 w - - 0 1',
    root: R(
      N('i1e1', N('g9e7', N('e1e7', N('f9e8', N('a4a9'))))),
      N(
        'a4a9',
        N(
          'e9e8',
          N('i1i8', N('e8e7', N('a9a7'))),
          N('a9d9', N('g9e7', N('i1i8'))),
        ),
      ),
    ),
  },
  {
    id: 'mate2-shuangchedan-x2',
    title: '双车胁士·三步杀（变式）',
    description: '红先三步杀（5 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 3,
    fen: '3ak4/9/9/9/9/8R/4p4/9/R8/3K5 w - - 0 1',
    root: R(
      N('i4e4', N('e9f9', N('a1f1', N('e3f3', N('f1f3'))))),
      N('i4i9', N('e9e8', N('a1a8', N('e8e7', N('i9i7'))))),
    ),
  },
  {
    id: 'mate2-shuangchedan-x2-j',
    title: '双车胁士·三步杀（镜像）',
    description: '红先三步杀（5 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 3,
    fen: '4ka3/9/9/9/9/R8/4p4/9/8R/5K3 w - - 0 1',
    root: R(
      N('a4e4', N('e9d9', N('i1d1', N('e3d3', N('d1d3'))))),
      N('a4a9', N('e9e8', N('i1i8', N('e8e7', N('a9a7'))))),
    ),
  },
  {
    id: 'mate3-maipao',
    title: '马炮三步杀',
    description: '红先三步杀：马炮联攻步步紧逼，马作炮架闷杀宫心。',
    difficulty: 3,
    fen: '4k4/9/9/9/9/9/8N/9/4C4/3K5 w - - 0 1',
    root: R(
      N(
        'e1f1',
        N(
          'e9f9',
          N('i3g4', N('f9f8', N('g4f6'))),
          N('i3h5', N('f9f8', N('h5f6'))),
        ),
      ),
    ),
  },
  {
    id: 'mate3-maipao-x3-j',
    title: '马炮三步杀·三步杀（镜像）',
    description: '红先三步杀（5 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 3,
    fen: '4k4/9/9/9/9/9/N8/9/4C4/5KB2 w - - 0 1',
    root: R(
      N(
        'e1d1',
        N(
          'e9d9',
          N('a3b5', N('d9d8', N('b5d6'))),
          N('a3c4', N('d9d8', N('c4d6'))),
        ),
      ),
      N(
        'a3c4',
        N(
          'e9d9',
          N('c4d6', N('d9d8', N('e1d1'))),
          N('e1d1', N('d9d8', N('c4d6'))),
        ),
      ),
      N(
        'a3b5',
        N(
          'e9d9',
          N('b5d6', N('d9d8', N('e1d1'))),
          N('e1d1', N('d9d8', N('b5d6'))),
        ),
      ),
    ),
  },
  {
    id: 'mate4-chepaoshi',
    title: '车炮破双士（进阶）',
    description: '红先四步杀：车炮联手破双士，老将御驾亲征，四步擒王。',
    difficulty: 4,
    fen: '3aka3/9/9/9/9/8C/9/9/R8/3K5 w - - 0 1',
    root: R(N('a1e1', N('f9e8', N('d0e0', N('e9f9', N('e1f1', N('e8f7', N('f1f7')))))))),
  },
  {
    id: 'mate4-chepaoshi-j',
    title: '车炮破双士·进阶杀（镜像）',
    description: '红先四步杀（7 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 4,
    fen: '3aka3/9/9/9/9/C8/9/9/8R/5K3 w - - 0 1',
    root: R(N('i1e1', N('d9e8', N('f0e0', N('e9d9', N('e1d1', N('e8d7', N('d1d7')))))))),
  },
  {
    id: 'mate4-chepaoshi-x3',
    title: '车炮破双士·进阶杀（变式）',
    description: '红先四步杀（7 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 4,
    fen: '3aka3/9/9/9/9/8C/9/9/R8/2BK5 w - - 0 1',
    root: R(
      N('a1e1', N('f9e8', N('d0e0', N('e9f9', N('e1f1', N('e8f7', N('f1f7'))))))),
      N(
        'a1f1',
        N(
          'e9e8',
          N(
            'f1f7',
            N(
              'e8e9',
              N('f7f8', N('d9e8', N('i4i9'))),
              N('i4i1', N('d9e8', N('i1i9'))),
            ),
          ),
        ),
      ),
    ),
  },
  {
    id: 'mate4-chepaoshi-x3-j',
    title: '车炮破双士·进阶杀（镜像）',
    description: '红先四步杀（7 着连将），正解可能不止一种，找到任意一条制胜路线。',
    difficulty: 4,
    fen: '3aka3/9/9/9/9/C8/9/9/8R/5KB2 w - - 0 1',
    root: R(
      N('i1e1', N('d9e8', N('f0e0', N('e9d9', N('e1d1', N('e8d7', N('d1d7'))))))),
      N(
        'a4a0',
        N(
          'e9e8',
          N(
            'a0e0',
            N(
              'e8e7',
              N('g0e2', N('e7d7', N('i1d1'))),
              N('i1d1', N('d9e8', N('g0e2'))),
            ),
          ),
          N('i1d1', N('e8e9', N('a0e0', N('e9e8', N('g0e2'))))),
        ),
      ),
    ),
  },
];
