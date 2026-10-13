"""webchess NNUE 训练器：WCND 数据 → 32×32×32 网络 → int8/int16 量化权重导出。

网络结构（浮点训练）：
    视角特征 1260（14 类棋子 × 90 格：己方 0-6 / 对方 7-13，双视角共享权重）
    → l1: 1260→32（双视角各自累加，共享权重与 bias）
    → concat 64 → cReLU → l2a: 64→32 → cReLU → l2b: 32→32 → cReLU → l3: 32→1
    → 输出 × 400 = 走子方视角 cp。

量化方案（与 TS 推理逐位一致，全部 floor 除法）：
    QA1=256：W1 int16（clip ±24000 防溢出），acc int32；
    a1 = clip(floor((acc*127+128)/256), 0, 127) —— int8 cReLU；
    W2A/W2B/W3 int8 = round(w×64)，逐层 h = W·a + B（int32，B=round(b×8128)）；
    各隐层激活 a = clip(floor((h*127+4064)/8128), 0, 127)；
    eval = floor(out*400/8128) cp（走子方视角）。
    （W 权重 scale 取 64 而非 128：|max|≈1.3，128 会触发 ±127 clip 截断。）

用法（uv run）：
    uv run train.py --data F:/DevCache/nnue-data.bin --epochs 24
    uv run train.py --data ... --export-only  # 仅量化导出（加载 checkpoint）
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

PAD = 1260  # 特征填充下标（embedding 扩一行，权重恒零）
FEATURES = 1260
HIDDEN = 32
QA1 = 256
SCALE_L2 = 8128  # 127(激活) × 64(权重)
EVAL_SCALE = 400.0
WCNW_VERSION = 2


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="webchess NNUE trainer")
    ap.add_argument("--data", required=True, help="WCND 数据文件")
    ap.add_argument("--epochs", type=int, default=24)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--val-frac", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--ckpt", default="F:/DevCache/nnue-ckpt.pt")
    ap.add_argument("--out-weights", default="F:/DevCache/nnue-weights.bin")
    ap.add_argument("--out-vectors", default="", help="一致性测试向量输出目录（空则跳过）")
    ap.add_argument("--export-only", action="store_true", help="跳过训练，仅量化导出")
    return ap.parse_args()


def load_wcnd(path: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """读 WCND：返回 (cells n×90, side n, result n, eval_cp n)。"""
    buf = Path(path).read_bytes()
    assert buf[:4] == b"WCND", "magic 不符"
    count = struct.unpack_from("<I", buf, 8)[0]
    assert len(buf) == 12 + count * 96, f"记录数与文件大小不符: {count}"
    rec = np.frombuffer(buf, dtype=np.uint8, offset=12).reshape(count, 96)
    cells = rec[:, :90].astype(np.int64)
    side = rec[:, 90].astype(np.int64)  # 1=红 0=黑
    result = rec[:, 91].astype(np.float64) / 2.0  # 红方视角 0/0.5/1
    eval_cp = rec[:, 92:96].copy().view(np.int32).reshape(count)  # 红方视角
    return cells, side, result, eval_cp


def mirror_table() -> np.ndarray:
    sq = np.arange(90)
    return (9 - sq // 9) * 9 + sq % 9


def featurize(cells: np.ndarray, side: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """视角化特征：返回 (my, opp)，各 (n, 90)，PAD 填充空格。

    红视角：class = t-1（红子 0-6 / 黑子 7-13），sq 原样；
    黑视角：黑子 class = t-8，红子 class = t+6，sq 行镜像。
    走子方视角 = my。
    """
    n = cells.shape[0]
    sq = np.arange(90)
    mir = mirror_table()
    t = cells
    idx_red = (t - 1) * 90 + sq[None, :]
    class_black_view = np.where(t >= 8, t - 8, t + 6)
    idx_black = class_black_view * 90 + mir[None, :]
    empty = t == 0
    idx_red = np.where(empty, PAD, idx_red)
    idx_black = np.where(empty, PAD, idx_black)
    red = side == 1
    my = np.where(red[:, None], idx_red, idx_black)
    opp = np.where(red[:, None], idx_black, idx_red)
    assert my.shape == (n, 90)
    return my, opp


class NnueNet(nn.Module):
    """浮点训练网络（结构与量化推理对应）。"""

    def __init__(self) -> None:
        super().__init__()
        self.l1 = nn.Linear(FEATURES, HIDDEN)
        self.l2a = nn.Linear(HIDDEN * 2, HIDDEN)
        self.l2b = nn.Linear(HIDDEN, HIDDEN)
        self.l3 = nn.Linear(HIDDEN, 1)

    def forward(self, my: torch.Tensor, opp: torch.Tensor) -> torch.Tensor:
        acc_my = self._accumulate(my)
        acc_opp = self._accumulate(opp)
        x = torch.clamp(torch.cat([acc_my, acc_opp], dim=1), 0.0, 1.0)
        x = torch.clamp(self.l2a(x), 0.0, 1.0)
        x = torch.clamp(self.l2b(x), 0.0, 1.0)
        return self.l3(x)

    def _accumulate(self, idx: torch.Tensor) -> torch.Tensor:
        # idx: (n, 90) 特征下标，PAD 行贡献零。
        mask = (idx != PAD).unsqueeze(-1).float()
        w = self.l1.weight.t()[idx.clamp(max=PAD - 1)]  # (n, 90, 32)，PAD 行 gather 后由 mask 清零
        return (w * mask).sum(dim=1) + self.l1.bias


def quantize(model: NnueNet) -> dict[str, np.ndarray]:
    """浮点权重 → 定点权重（方案见模块 docstring）。"""
    w1 = model.l1.weight.detach().numpy().T  # (1260, 32)
    w1q = np.clip(np.round(w1 * QA1), -24000, 24000).astype(np.int16)
    b1q = np.round(model.l1.bias.detach().numpy() * QA1).astype(np.int16)
    w2aq = np.clip(np.round(model.l2a.weight.detach().numpy() * 64), -127, 127).astype(np.int8)
    b2aq = np.round(model.l2a.bias.detach().numpy() * SCALE_L2).astype(np.int32)
    w2bq = np.clip(np.round(model.l2b.weight.detach().numpy() * 64), -127, 127).astype(np.int8)
    b2bq = np.round(model.l2b.bias.detach().numpy() * SCALE_L2).astype(np.int32)
    w3q = np.clip(np.round(model.l3.weight.detach().numpy() * 64), -127, 127).astype(np.int8)
    b3q = np.round(model.l3.bias.detach().numpy() * SCALE_L2).astype(np.int32)
    return {
        "w1": w1q,
        "b1": b1q,
        "w2a": w2aq,
        "b2a": b2aq,
        "w2b": w2bq,
        "b2b": b2bq,
        "w3": w3q,
        "b3": b3q,
    }


def quant_forward(q: dict[str, np.ndarray], my: np.ndarray, opp: np.ndarray) -> np.ndarray:
    """量化模拟前向（整数运算，floor 除法，与 TS 推理逐位一致）。

    返回走子方视角 eval（int32，cp）。
    """
    w1 = np.concatenate([q["w1"], np.zeros((1, HIDDEN), dtype=np.int16)])
    acc_my = w1[my].sum(axis=1, dtype=np.int64) + q["b1"].astype(np.int64)
    acc_opp = w1[opp].sum(axis=1, dtype=np.int64) + q["b1"].astype(np.int64)
    a1_my = np.clip((acc_my * 127 + 128) // 256, 0, 127).astype(np.int64)
    a1_opp = np.clip((acc_opp * 127 + 128) // 256, 0, 127).astype(np.int64)
    a1 = np.concatenate([a1_my, a1_opp], axis=1)  # (n, 64)
    h1 = a1 @ q["w2a"].T.astype(np.int64) + q["b2a"].astype(np.int64)
    a2 = np.clip((h1 * 127 + 4064) // SCALE_L2, 0, 127).astype(np.int64)
    h2 = a2 @ q["w2b"].T.astype(np.int64) + q["b2b"].astype(np.int64)
    a3 = np.clip((h2 * 127 + 4064) // SCALE_L2, 0, 127).astype(np.int64)
    out = a3 @ q["w3"].T.astype(np.int64) + q["b3"].astype(np.int64)
    return (out * 400 // SCALE_L2).astype(np.int32)  # floor 语义（out*400 可负）


def export_weights(q: dict[str, np.ndarray], path: str) -> None:
    """导出二进制权重：WCNW 头 + 定点数组（小端）。"""
    header = struct.pack(
        "<4sIIII",
        b"WCNW",
        WCNW_VERSION,
        FEATURES,
        HIDDEN,
        QA1,
    )
    parts = [header]
    for name, dt in (
        ("w1", "<i2"),
        ("b1", "<i2"),
        ("w2a", "i1"),
        ("b2a", "<i4"),
        ("w2b", "i1"),
        ("b2b", "<i4"),
        ("w3", "i1"),
        ("b3", "<i4"),
    ):
        arr = np.ascontiguousarray(q[name], dtype=dt)
        parts.append(arr.tobytes())

    Path(path).write_bytes(b"".join(parts))
    size = sum(len(p) for p in parts)
    print(f"权重导出：{path}（{size / 1024:.1f} KB）")


def main() -> None:
    args = parse_args()
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)

    cells, side, result, eval_cp = load_wcnd(args.data)
    my, opp = featurize(cells, side)
    # 标签转走子方视角（网络输出语义）。
    cp_my = np.where(side == 1, eval_cp, -eval_cp).astype(np.float64)
    n = len(cells)
    perm = rng.permutation(n)
    val_n = max(1, int(n * args.val_frac))
    val_idx, train_idx = perm[:val_n], perm[val_n:]
    print(f"数据：{n} 局面（训练 {len(train_idx)} / 验证 {val_n}）")

    device = torch.device("cpu")
    model = NnueNet().to(device)
    ckpt_path = Path(args.ckpt)
    if args.export_only:
        model.load_state_dict(torch.load(ckpt_path, weights_only=True))
        print(f"export-only：加载 checkpoint {ckpt_path}")

    if not args.export_only:
        opt = torch.optim.Adam(model.parameters(), lr=args.lr)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
        x_my_all = torch.from_numpy(my)
        x_opp_all = torch.from_numpy(opp)
        y_cp = torch.from_numpy(cp_my).float()
        y_res = torch.from_numpy(result).float()
        red_mask = torch.from_numpy((side == 1).astype(np.float64)).float()
        sign = red_mask * 2 - 1  # 结果转走子方视角：红 1 / 黑 -1

        best_val = float("inf")
        for epoch in range(args.epochs):
            model.train()
            order = rng.permutation(train_idx)
            total_loss = 0.0
            total_mse = 0.0
            batches = 0
            for s in range(0, len(order), args.batch):
                idx = order[s : s + args.batch]
                b_my = x_my_all[idx].to(device)
                b_opp = x_opp_all[idx].to(device)
                pred_cp = model(b_my, b_opp)[:, 0] * EVAL_SCALE
                label_cp = y_cp[idx]
                label_res = y_res[idx] * sign[idx]  # 走子方视角结果
                mse = nn.functional.mse_loss(pred_cp, label_cp)
                bce = nn.functional.binary_cross_entropy_with_logits(
                    pred_cp / 300.0, label_res.clamp(0.0, 1.0)
                )
                loss = mse + 0.5 * bce
                opt.zero_grad()
                loss.backward()
                opt.step()
                total_loss += float(loss)
                total_mse += float(mse)
                batches += 1

            sched.step()
            model.eval()
            with torch.no_grad():
                v_pred = model(x_my_all[val_idx], x_opp_all[val_idx])[:, 0] * EVAL_SCALE
                val_mse = float(nn.functional.mse_loss(v_pred, y_cp[val_idx]))
            print(
                f"epoch {epoch + 1}/{args.epochs}: loss {total_loss / batches:.1f} "
                f"train_mse {total_mse / batches:.1f} val_mse {val_mse:.1f} lr {sched.get_last_lr()[0]:.2e}"
            )
            if val_mse < best_val:
                best_val = val_mse
                torch.save(model.state_dict(), ckpt_path)

        model.load_state_dict(torch.load(ckpt_path, weights_only=True))
        print(f"训练完成，最佳 val_mse {best_val:.1f}，checkpoint {ckpt_path}")

    q = quantize(model)
    # 量化损失核对：浮点 vs 量化在验证集上的 cp 偏差。
    with torch.no_grad():
        f_pred = (
            model(torch.from_numpy(my[val_idx]), torch.from_numpy(opp[val_idx]))[:, 0].numpy()
            * EVAL_SCALE
        )

    q_pred = quant_forward(q, my[val_idx], opp[val_idx]).reshape(-1).astype(np.float64)
    delta = q_pred - f_pred
    print(
        f"量化偏差：mean {delta.mean():.1f} cp，p99 {np.percentile(np.abs(delta), 99):.0f} cp，"
        f"量化 vs 标签 mse {np.mean((q_pred - cp_my[val_idx]) ** 2):.0f}"
    )
    export_weights(q, args.out_weights)

    # 一致性测试向量：64 条局面（96B 原始记录）+ 期望量化 eval。
    if args.out_vectors:
        vec_n = min(64, n)
        vec_dir = Path(args.out_vectors)
        vec_dir.mkdir(parents=True, exist_ok=True)
        buf = Path(args.data).read_bytes()
        rec_flat = buf[12:]
        pick = rng.choice(n, size=vec_n, replace=False)
        pick_sorted = np.sort(pick)
        rec_bytes = b"".join(rec_flat[i * 96 : (i + 1) * 96] for i in pick_sorted)
        (vec_dir / "nnue-vectors.bin").write_bytes(rec_bytes)
        q_vals = quant_forward(q, my[pick_sorted], opp[pick_sorted])
        (vec_dir / "nnue-vectors.json").write_text(
            json.dumps([int(v) for v in q_vals.reshape(-1).tolist()]), encoding="utf-8"
        )
        print(f"测试向量：{vec_n} 条 → {vec_dir}")


if __name__ == "__main__":
    main()
