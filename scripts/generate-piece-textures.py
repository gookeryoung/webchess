#!/usr/bin/env python3
"""生成中国象棋棋子贴图（packages/web/public/pieces/*.png，256x256 RGBA）。

程序化渲染，替代早期 140x140 低清占位图；风格统一、可复现，且小程序端
（packages/miniapp/scripts/build.mjs）直接复制本目录产物，无需单独处理。

视觉构成（自下而上）：
  1. 柔和落地投影
  2. 棋子侧壁（圆柱厚度，纵向渐变）
  3. 顶面（木质径向渐变 + 年轮纹理 + 左上高光/边缘暗角）
  4. 双圈描边（外圈刻线 + 内圈凹槽）
  5. 雕刻漆字（底部投影 + 纵向渐变字面 + 顶部高光）

用法：python3 scripts/generate-piece-textures.py
依赖：pip install pillow numpy；字体 LXGWWenKai-Medium.ttf（SIL OFL，见仓库 NOTICE）
"""

from __future__ import annotations

import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---- 基本参数 ----------------------------------------------------------------

SIZE = 256          # 输出尺寸
SS = 4              # 超采样倍率（渲染 1024 再缩小，抗锯齿）
R = SIZE * SS // 2  # 画布半径基准
FONT_PATH = Path('/tmp/fonts/LXGWWenKai-Medium.ttf')
OUT_DIR = Path(__file__).resolve().parent.parent / 'packages/web/public/pieces'

# 棋子定义：红方在前（索引 = 棋子编码 - 1，与 BoardRenderer.PieceTextureNames 一致）
PIECES: list[tuple[str, str]] = [
    ('r_shuai', '帅'), ('r_shi', '仕'), ('r_xiang', '相'), ('r_ma', '馬'),
    ('r_ju', '車'), ('r_pao', '炮'), ('r_bing', '兵'),
    ('b_jiang', '將'), ('b_shi', '士'), ('b_xiang', '象'), ('b_ma', '馬'),
    ('b_ju', '車'), ('b_pao', '砲'), ('b_zu', '卒'),
]

# 配色：红方漆字 vs 黑方墨字；木质底双方一致（传统黄杨木色）
INK_RED = (180, 26, 14)
INK_RED_LIGHT = (232, 72, 44)
INK_BLACK = (44, 40, 36)
INK_BLACK_LIGHT = (96, 90, 82)
WOOD_LIGHT = (238, 208, 148)
WOOD_MID = (222, 184, 116)
WOOD_DARK = (188, 142, 76)
WOOD_SIDE_DARK = (146, 98, 46)
WOOD_GRAIN = (168, 118, 58)


def make_radial_gradient(size: int, inner: tuple, outer: tuple) -> Image.Image:
    """以中心为亮部、边缘为暗部的径向渐变（RGB）。"""
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    c = (size - 1) / 2
    t = np.sqrt((xs - c) ** 2 + (ys - c) ** 2) / c
    t = np.clip(t, 0, 1) ** 1.6
    rgb = np.zeros((size, size, 3), np.uint8)
    for i in range(3):
        rgb[..., i] = (inner[i] + (outer[i] - inner[i]) * t).astype(np.uint8)
    return Image.fromarray(rgb, 'RGB')


def wood_grain_layer(size: int, radius: int, rng: random.Random) -> Image.Image:
    """年轮纹理：围绕偏心圆心的同心弧线 + 少量细碎纤维，稍作模糊。"""
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = size / 2 + rng.uniform(-0.15, 0.15) * radius
    cy = size / 2 + rng.uniform(-0.15, 0.15) * radius
    r = radius * 0.10
    while r < radius * 1.7:
        jitter = rng.uniform(0.84, 1.16)
        width = max(1, int(SS * rng.uniform(0.8, 2.4)))
        alpha = int(rng.uniform(22, 64))
        bbox = [cx - r * jitter, cy - r * jitter, cx + r * jitter, cy + r * jitter]
        start = rng.uniform(0, 360)
        d.arc(bbox, start, start + rng.uniform(180, 360), fill=(*WOOD_GRAIN, alpha), width=width)
        r += radius * rng.uniform(0.04, 0.065)
    # 细纤维：极浅的随机短线，模拟木纹毛孔
    for _ in range(140):
        x = rng.uniform(0, size)
        y = rng.uniform(0, size)
        ang = rng.uniform(0, math.tau)
        ln = rng.uniform(0.04, 0.12) * radius
        d.line(
            [(x, y), (x + ln * math.cos(ang), y + ln * math.sin(ang))],
            fill=(*WOOD_GRAIN, int(rng.uniform(10, 26))),
            width=1,
        )
    return layer.filter(ImageFilter.GaussianBlur(SS * 0.35))


def text_gradient_mask(size: int, ch: str, font: ImageFont.FreeTypeFont) -> Image.Image:
    """文字 alpha 蒙版（居中，视觉重心微调）。"""
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    bbox = d.textbbox((0, 0), ch, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text((size / 2 - w / 2 - bbox[0], size / 2 - h / 2 - bbox[1] - size * 0.004), ch, font=font, fill=255)
    return mask


def draw_character(size: int, ch: str, ink: tuple, ink_light: tuple, rng: random.Random) -> Image.Image:
    """凸起漆字（光源左上）：右下投影 + 渐变字面 + 左上受光棱线/右下背光棱线。"""
    font = ImageFont.truetype(str(FONT_PATH), int(size * 0.54))
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mask = text_gradient_mask(size, ch, font)

    # 1) 投影：字块向右下投射的软阴影，营造凸起高度
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    shadow.paste(Image.new('RGBA', (size, size), (70, 40, 12, 150)), (int(size * 0.014), int(size * 0.022)), mask)
    layer = Image.alpha_composite(layer, shadow.filter(ImageFilter.GaussianBlur(size * 0.007)))

    # 2) 字面：纵向渐变（上浅下深），叠加细微噪点模拟漆面
    grad = np.zeros((size, size, 3), np.uint8)
    t = np.linspace(0, 1, size).reshape(-1, 1).repeat(size, axis=1)
    for i in range(3):
        grad[..., i] = (ink_light[i] + (ink[i] - ink_light[i]) * t).astype(np.uint8)
    grad_img = Image.fromarray(grad, 'RGB').convert('RGBA')
    grad_img.putalpha(mask)
    layer = Image.alpha_composite(layer, grad_img)

    # 3) 棱线：仅字形外扩边缘（膨胀 - 原掩码），浅色偏左上、深色偏右下
    band = np.array(mask.filter(ImageFilter.MaxFilter(5)), np.int16) - np.array(mask, np.int16)
    band_img = Image.fromarray(np.clip(band, 0, 255).astype(np.uint8), 'L')
    edge = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    off = max(1, int(size * 0.004))
    edge.paste(Image.new('RGBA', (size, size), (255, 238, 205, 165)), (-off, -off), band_img)  # 左上受光
    edge.paste(Image.new('RGBA', (size, size), (52, 26, 6, 150)), (off, off), band_img)  # 右下背光
    layer = Image.alpha_composite(layer, edge)
    return layer


def render_piece(ch: str, side: str, seed: int) -> Image.Image:
    """渲染单枚棋子（SIZE*SS 大小，含透明边距）。"""
    rng = random.Random(seed)
    size = SIZE * SS
    ink = INK_RED if side == 'r' else INK_BLACK
    ink_light = INK_RED_LIGHT if side == 'r' else INK_BLACK_LIGHT

    # 几何：外半径 / 顶面半径 / 侧壁厚度 / 出血边距
    outer_r = size * 0.405
    face_r = size * 0.385
    depth = size * 0.055
    cx = cy = size / 2

    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))

    # 1) 落地投影：向下偏移的模糊椭圆
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(shadow)
    sx0, sy0 = cx - outer_r * 0.98, cy - outer_r * 0.86 + depth
    d.ellipse([sx0, sy0, sx0 + outer_r * 1.96, sy0 + outer_r * 1.78], fill=(52, 30, 8, 150))
    canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(size * 0.02)))

    # 2) 侧壁（圆柱厚度）：整体轮廓剪出顶面圆后的月牙区域，叠纵向渐变
    body = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    db = ImageDraw.Draw(body)
    db.ellipse([cx - outer_r, cy - outer_r + depth, cx + outer_r, cy + outer_r + depth], fill=WOOD_SIDE_DARK + (255,))
    db.ellipse([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r], fill=WOOD_MID + (255,))
    side_grad = np.zeros((size, size, 4), np.uint8)
    ys = np.arange(size, dtype=np.float32).reshape(-1, 1).repeat(size, axis=1)
    t = np.clip((ys - (cy - outer_r)) / (2 * outer_r + depth), 0, 1)
    top = np.array((222, 184, 116), np.float32)
    bottom = np.array(WOOD_SIDE_DARK, np.float32)
    rgb = (top + (bottom - top) * (0.2 + 0.8 * t)[..., None]).astype(np.uint8)
    side_grad[..., :3] = rgb
    side_grad[..., 3] = 255
    side_layer = Image.fromarray(side_grad, 'RGBA')
    side_mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(side_mask).ellipse([cx - outer_r, cy - outer_r + depth, cx + outer_r, cy + outer_r + depth], fill=255)
    canvas.paste(side_layer, (0, 0), side_mask)
    canvas = Image.alpha_composite(canvas, body)

    # 3) 顶面：径向渐变 + 年轮 + 高光/暗角
    face = make_radial_gradient(int(2 * face_r), WOOD_LIGHT, WOOD_DARK)
    grain = wood_grain_layer(int(2 * face_r), int(face_r), rng)
    face = Image.alpha_composite(face.convert('RGBA'), grain)

    # 左上高光：半透明白椭圆（柔边）
    hl = Image.new('RGBA', face.size, (0, 0, 0, 0))
    dh = ImageDraw.Draw(hl)
    fr = face_r
    dh.ellipse([fr * 0.18, fr * 0.10, fr * 1.55, fr * 1.30], fill=(255, 248, 228, 52))
    face = Image.alpha_composite(face, hl.filter(ImageFilter.GaussianBlur(fr * 0.12)))

    # 边缘暗角：内侧一圈深色柔边
    vig = Image.new('RGBA', face.size, (0, 0, 0, 0))
    dv = ImageDraw.Draw(vig)
    dv.ellipse([fr * 0.06, fr * 0.06, fr * 1.94, fr * 1.94], outline=(96, 58, 20, 80), width=int(fr * 0.10))
    face = Image.alpha_composite(face, vig.filter(ImageFilter.GaussianBlur(fr * 0.05)))

    face_size = int(2 * face_r)
    mask_face = Image.new('L', (face_size, face_size), 0)
    ImageDraw.Draw(mask_face).ellipse([0, 0, face_size, face_size], fill=255)
    canvas.paste(face.resize((face_size, face_size)), (int(cx - face_r), int(cy - face_r)), mask_face)

    # 4) 描边圈：外圈刻线（上暗下亮成对偏移）+ 内侧细槽
    rings = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    dr = ImageDraw.Draw(rings)
    for rr, w in [(outer_r - size * 0.004, int(size * 0.012)), (face_r - size * 0.030, int(size * 0.006))]:
        dr.ellipse([cx - rr, cy - rr - size * 0.003, cx + rr, cy + rr - size * 0.003],
                   outline=(255, 238, 200, 110), width=w)  # 下缘受光
        dr.ellipse([cx - rr, cy - rr + size * 0.003, cx + rr, cy + rr + size * 0.003],
                   outline=(92, 54, 18, 150), width=w)  # 上缘背光
    canvas = Image.alpha_composite(canvas, rings)

    # 5) 漆字
    canvas = Image.alpha_composite(canvas, draw_character(size, ch, ink, ink_light, rng))

    # 6) 外缘一圈极细深色轮廓，增强在浅色棋盘上的辨识度
    edge = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    de = ImageDraw.Draw(edge)
    de.ellipse([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r], outline=(74, 44, 14, 200), width=max(2, int(size * 0.006)))
    canvas = Image.alpha_composite(canvas, edge)

    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    if not FONT_PATH.exists():
        raise SystemExit(f'缺少字体文件：{FONT_PATH}（下载 LXGWWenKai-Medium.ttf 后重试）')
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for index, (name, ch) in enumerate(PIECES, start=1):
        side = 'r' if name.startswith('r_') else 'b'
        img = render_piece(ch, side, seed=index * 7 + 3)
        img.save(OUT_DIR / f'{name}.png', optimize=True)
        print(f'生成 {name}.png（{ch}）')
    print(f'完成：{OUT_DIR}')


if __name__ == '__main__':
    main()
