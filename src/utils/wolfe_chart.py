#!/usr/bin/env python3
"""
Wolfe Wave Chart Renderer
Reads JSON from stdin, outputs PNG to stdout.

Input JSON schema:
{
  "candles": [{"timestamp": ms, "open": n, "high": n, "low": n, "close": n},...],
  "wave": {
    "direction": "bullish"|"bearish",
    "p1": {"index": n, "price": n},
    "p2": {"index": n, "price": n},
    "p3": {"index": n, "price": n},
    "p4": {"index": n, "price": n},
    "p5": {"index": n, "price": n}
  },
  "levels": {
    "entryPrice": n,
    "stopLoss": n,
    "target1": n,
    "target2": n,
    "line14Price": n  (optional)
  },
  "meta": {
    "symbol": str,
    "timeframe": str,
    "shape": str
  }
}
"""

import sys
import json
import math
from PIL import Image, ImageDraw, ImageFont

# ── Palette ──────────────────────────────────────────────────────────────────
BG          = (18, 18, 24)
GRID        = (35, 35, 48)
BORDER      = (55, 55, 75)
TEXT        = (200, 200, 220)
TEXT_DIM    = (110, 110, 140)

BULL_BODY   = (38, 166, 91)    # green candle body
BEAR_BODY   = (239, 83, 80)    # red candle body
WICK        = (120, 120, 140)

WAVE_LINE   = (255, 200, 0)    # P1-P5 connecting lines
POINT_DOT   = (255, 220, 60)
LABEL_BG    = (50, 45, 10)

CHANNEL_13  = (100, 180, 255)  # line 1-3
CHANNEL_24  = (180, 120, 255)  # line 2-4
LINE14      = (255, 160, 40)   # line 1-4 projection

SL_COLOR    = (239, 83, 80)    # red
TP1_COLOR   = (38, 220, 120)   # green
TP2_COLOR   = (38, 166, 91)    # darker green

# ── Layout ───────────────────────────────────────────────────────────────────
W, H        = 1280, 720
PAD_L       = 10
PAD_R       = 90   # price axis
PAD_T       = 50
PAD_B       = 40

FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD    = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

def price_fmt(p):
    if p >= 1000:
        return f"{p:,.2f}"
    elif p >= 1:
        return f"{p:.4f}"
    else:
        return f"{p:.6f}"


def render(data: dict) -> bytes:
    candles  = data["candles"]
    wave     = data["wave"]
    levels   = data["levels"]
    meta     = data.get("meta", {})

    # Limit to last 100 candles; wave indices are absolute → remap
    n_show = min(100, len(candles))
    offset = len(candles) - n_show          # candle[offset] → display col 0
    candles = candles[-n_show:]             # now 0-indexed for display

    # Remap wave point indices to display space
    def remap(idx):
        return idx - offset

    p = {k: {"index": remap(wave[k]["index"]), "price": wave[k]["price"]}
         for k in ("p1","p2","p3","p4","p5")}

    # Price range — include all levels
    all_prices = []
    for c in candles:
        all_prices += [c["high"], c["low"]]
    for k in ("entryPrice","stopLoss","target1","target2"):
        if levels.get(k):
            all_prices.append(levels[k])
    if levels.get("line14Price"):
        all_prices.append(levels["line14Price"])

    p_min = min(all_prices)
    p_max = max(all_prices)
    p_rng = p_max - p_min or 1
    # Add 5% padding top and bottom
    p_min -= p_rng * 0.05
    p_max += p_rng * 0.05
    p_rng  = p_max - p_min

    # Chart area
    cx0 = PAD_L
    cx1 = W - PAD_R
    cy0 = PAD_T
    cy1 = H - PAD_B
    cw  = cx1 - cx0
    ch  = cy1 - cy0

    def x_of(col):
        # col in [0, n_show-1]
        return cx0 + (col + 0.5) * cw / n_show

    def y_of(price):
        return cy1 - (price - p_min) / p_rng * ch

    # ── Create image ─────────────────────────────────────────────────────────
    img  = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    font_sm   = load_font(FONT_REGULAR, 11)
    font_md   = load_font(FONT_REGULAR, 13)
    font_bold = load_font(FONT_BOLD, 14)
    font_lg   = load_font(FONT_BOLD, 17)

    # ── Grid ─────────────────────────────────────────────────────────────────
    n_grid = 6
    for i in range(n_grid + 1):
        gp = p_min + p_rng * i / n_grid
        gy = y_of(gp)
        draw.line([(cx0, gy), (cx1, gy)], fill=GRID, width=1)
        label = price_fmt(gp)
        draw.text((cx1 + 4, gy - 7), label, fill=TEXT_DIM, font=font_sm)

    # ── Horizontal level lines ────────────────────────────────────────────────
    def h_line(price, color, label, dash=6):
        y = y_of(price)
        # Dashed line
        x = cx0
        seg_on = True
        while x < cx1:
            xe = min(x + dash, cx1)
            if seg_on:
                draw.line([(x, y), (xe, y)], fill=color, width=2)
            x = xe
            seg_on = not seg_on
        # Label on right
        txt = f"{label}  {price_fmt(price)}"
        draw.text((cx1 + 4, y - 7), txt, fill=color, font=font_sm)

    h_line(levels["stopLoss"],  SL_COLOR,  "SL")
    h_line(levels["target1"],   TP1_COLOR, "TP1")
    h_line(levels["target2"],   TP2_COLOR, "TP2")

    # ── Candles ───────────────────────────────────────────────────────────────
    candle_w = max(2, cw / n_show * 0.65)

    for i, c in enumerate(candles):
        cx  = x_of(i)
        o, h_, l_, cl = c["open"], c["high"], c["low"], c["close"]
        bull = cl >= o
        body_color = BULL_BODY if bull else BEAR_BODY

        # Wick
        draw.line([(cx, y_of(h_)), (cx, y_of(l_))], fill=WICK, width=1)

        # Body
        y_top = y_of(max(o, cl))
        y_bot = y_of(min(o, cl))
        body_h = max(1, y_bot - y_top)
        draw.rectangle(
            [cx - candle_w/2, y_top, cx + candle_w/2, y_top + body_h],
            fill=body_color
        )

    # ── Channel lines 1-3 and 2-4 ────────────────────────────────────────────
    def draw_channel_line(pa, pb, color, label):
        """Draw line through two wave points, extended across chart."""
        xi, yi = pa["index"], pa["price"]
        xj, yj = pb["index"], pb["price"]
        if xj == xi:
            return
        slope = (yj - yi) / (xj - xi)

        # Extend to chart edges (col 0 and col n_show-1)
        p_left  = yi + slope * (0 - xi)
        p_right = yi + slope * ((n_show - 1) - xi)

        pts = [(x_of(0), y_of(p_left)), (x_of(n_show - 1), y_of(p_right))]
        draw.line(pts, fill=color, width=1)

    draw_channel_line(p["p1"], p["p3"], CHANNEL_13, "1-3")
    draw_channel_line(p["p2"], p["p4"], CHANNEL_24, "2-4")

    # ── Line 1-4 projection ───────────────────────────────────────────────────
    if levels.get("line14Price") and p["p5"]["index"] >= 0:
        draw_channel_line(p["p1"], p["p4"], LINE14, "1-4")

    # ── Wave connecting lines P1→P2→P3→P4→P5 ─────────────────────────────────
    wave_pts = [
        (x_of(p["p1"]["index"]), y_of(p["p1"]["price"])),
        (x_of(p["p2"]["index"]), y_of(p["p2"]["price"])),
        (x_of(p["p3"]["index"]), y_of(p["p3"]["price"])),
        (x_of(p["p4"]["index"]), y_of(p["p4"]["price"])),
        (x_of(p["p5"]["index"]), y_of(p["p5"]["price"])),
    ]
    for i in range(len(wave_pts) - 1):
        draw.line([wave_pts[i], wave_pts[i+1]], fill=WAVE_LINE, width=2)

    # ── Wave points P1-P5 ─────────────────────────────────────────────────────
    POINT_R = 6
    for label, pt in p.items():
        idx = pt["index"]
        if idx < 0 or idx >= n_show:
            continue
        px_ = x_of(idx)
        py_ = y_of(pt["price"])

        # Dot
        draw.ellipse(
            [px_ - POINT_R, py_ - POINT_R, px_ + POINT_R, py_ + POINT_R],
            fill=POINT_DOT, outline=BG, width=2
        )

        # Label (P1..P5) — place above bullish points, below bearish
        is_peak = (label in ("p2","p4")) if wave["direction"] == "bearish" else (label in ("p2","p4"))
        txt = label.upper()
        bbox = draw.textbbox((0, 0), txt, font=font_bold)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        # Alternate above/below based on high/low pivot type
        direction = wave["direction"]
        above = label in ("p2","p4") if direction == "bullish" else label in ("p1","p3","p5")
        lx = px_ - tw / 2
        ly = (py_ - th - POINT_R - 6) if above else (py_ + POINT_R + 4)

        # Background pill
        draw.rounded_rectangle(
            [lx - 3, ly - 2, lx + tw + 3, ly + th + 2],
            radius=3, fill=LABEL_BG
        )
        draw.text((lx, ly), txt, fill=POINT_DOT, font=font_bold)

        # Price label
        price_lbl = price_fmt(pt["price"])
        pl_bbox = draw.textbbox((0,0), price_lbl, font=font_sm)
        plw = pl_bbox[2] - pl_bbox[0]
        plx = px_ - plw / 2
        ply = ly - 14 if above else ly + th + 6
        draw.text((plx, ply), price_lbl, fill=TEXT_DIM, font=font_sm)

    # ── Border ────────────────────────────────────────────────────────────────
    draw.rectangle([cx0, cy0, cx1, cy1], outline=BORDER, width=1)

    # ── Title ────────────────────────────────────────────────────────────────
    direction_str = "🔼 LONG" if meta.get("direction","bullish") == "bullish" else "🔽 SHORT"
    title = f"{meta.get('symbol','')}  {meta.get('timeframe','')}  │  Wolfe Wave  │  {direction_str}  │  {meta.get('shape','').upper()}"
    draw.text((cx0, 10), title, fill=TEXT, font=font_lg)

    # ── Legend (channel lines) ────────────────────────────────────────────────
    lx = cx1 - 220
    ly = cy0 + 8
    items = [
        (CHANNEL_13, "Line 1-3"),
        (CHANNEL_24, "Line 2-4"),
        (LINE14,     "Line 1-4"),
    ]
    for color, lbl in items:
        draw.line([(lx, ly + 6), (lx + 20, ly + 6)], fill=color, width=2)
        draw.text((lx + 24, ly), lbl, fill=TEXT_DIM, font=font_sm)
        lx += 85

    # ── Output PNG to stdout ──────────────────────────────────────────────────
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    sys.stdout.buffer.write(render(data))