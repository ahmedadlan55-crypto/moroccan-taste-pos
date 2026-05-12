# -*- coding: utf-8 -*-
"""
v5.10.48 — Generate a comprehensive Arabic-language PDF mind map of the
Moroccan Taste POS warehouse + inventory system.

Output: warehouse-system-mindmap.pdf in the project root.

Covers:
  1. System layers (UI / API / DB)
  2. Core entities + relationships
  3. Movement ledger model
  4. Stock-issue lifecycle state machine
  5. Production order lifecycle
  6. Stocktake / adjustment flows
  7. UI section map (15 screens)
  8. Permission matrix
  9. Validation rules summary

Renders RTL Arabic text correctly via arabic_reshaper + python-bidi
and the Tahoma TTF (bundled with Windows).
"""
import os
from pathlib import Path

import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon, Group, Circle
from reportlab.graphics import renderPDF


# ──────────────────────── Fonts ────────────────────────
WIN_FONTS = Path(r"C:\Windows\Fonts")
pdfmetrics.registerFont(TTFont("Arabic",      str(WIN_FONTS / "tahoma.ttf")))
pdfmetrics.registerFont(TTFont("Arabic-Bold", str(WIN_FONTS / "tahomabd.ttf")))


def ar(text: str) -> str:
    """Reshape + reorder Arabic for correct RTL rendering."""
    return get_display(arabic_reshaper.reshape(text))


# ──────────────────────── Palette ────────────────────────
PRIMARY      = colors.HexColor("#4f46e5")  # indigo
PRIMARY_SOFT = colors.HexColor("#eef2ff")
SUCCESS      = colors.HexColor("#16a34a")
SUCCESS_SOFT = colors.HexColor("#dcfce7")
WARNING      = colors.HexColor("#d97706")
WARNING_SOFT = colors.HexColor("#fef3c7")
DANGER       = colors.HexColor("#dc2626")
DANGER_SOFT  = colors.HexColor("#fee2e2")
INFO         = colors.HexColor("#3b82f6")
INFO_SOFT    = colors.HexColor("#dbeafe")
PINK         = colors.HexColor("#db2777")
PINK_SOFT    = colors.HexColor("#fce7f3")
PURPLE       = colors.HexColor("#a855f7")
PURPLE_SOFT  = colors.HexColor("#f3e8ff")
INK          = colors.HexColor("#0f172a")
INK_MUTED    = colors.HexColor("#475569")
INK_FAINT    = colors.HexColor("#94a3b8")
SURFACE      = colors.HexColor("#ffffff")
SURFACE_2    = colors.HexColor("#f1f5f9")
BORDER       = colors.HexColor("#e2e8f0")


PAGE_W, PAGE_H = A4
MARGIN = 14 * mm


# ──────────────────────── Drawing helpers ────────────────────────
def draw_card(c, x, y, w, h, fill=SURFACE, stroke=BORDER, radius=6, accent=None):
    """Rounded card with optional inline-start accent stripe."""
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(0.6)
    c.roundRect(x, y, w, h, radius, stroke=1, fill=1)
    if accent is not None:
        # Accent stripe on the inline-start side (right in RTL — we draw on the right edge)
        c.setFillColor(accent)
        c.setStrokeColor(accent)
        c.roundRect(x + w - 3, y, 3, h, 1, stroke=1, fill=1)


def draw_label_chip(c, x, y, w, h, text, fill, ink, font="Arabic-Bold", size=8):
    """Pill-shaped label."""
    c.setFillColor(fill)
    c.setStrokeColor(fill)
    c.roundRect(x, y, w, h, h / 2, stroke=1, fill=1)
    c.setFillColor(ink)
    c.setFont(font, size)
    # Center text
    text_w = c.stringWidth(text, font, size)
    c.drawString(x + (w - text_w) / 2, y + (h - size) / 2 + 1, text)


def draw_arrow(c, x1, y1, x2, y2, color=INK_MUTED, width=0.8, head=2.5, dashed=False):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(width)
    if dashed:
        c.setDash(2, 2)
    c.line(x1, y1, x2, y2)
    if dashed:
        c.setDash()
    # Arrow head — triangle
    import math
    angle = math.atan2(y2 - y1, x2 - x1)
    hx1 = x2 - head * 2 * math.cos(angle - math.pi / 7)
    hy1 = y2 - head * 2 * math.sin(angle - math.pi / 7)
    hx2 = x2 - head * 2 * math.cos(angle + math.pi / 7)
    hy2 = y2 - head * 2 * math.sin(angle + math.pi / 7)
    p = c.beginPath()
    p.moveTo(x2, y2)
    p.lineTo(hx1, hy1)
    p.lineTo(hx2, hy2)
    p.close()
    c.drawPath(p, stroke=1, fill=1)


def draw_text_rtl(c, x, y, text, font="Arabic", size=10, color=INK):
    """Draw Arabic text right-anchored at x."""
    reshaped = ar(text)
    c.setFillColor(color)
    c.setFont(font, size)
    text_w = c.stringWidth(reshaped, font, size)
    c.drawString(x - text_w, y, reshaped)


def draw_text_center(c, x, y, text, font="Arabic", size=10, color=INK):
    """Draw Arabic text centered at x."""
    reshaped = ar(text)
    c.setFillColor(color)
    c.setFont(font, size)
    text_w = c.stringWidth(reshaped, font, size)
    c.drawString(x - text_w / 2, y, reshaped)


def draw_text_ltr(c, x, y, text, font="Arabic", size=10, color=INK):
    """Draw text from left at x (for English / code labels)."""
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x, y, text)


def page_header(c, title, subtitle="", page_num=None, total=None, theme_color=PRIMARY):
    """Standardized page header with gradient-ish title bar + page number."""
    # Title bar (filled)
    c.setFillColor(INK)
    c.rect(0, PAGE_H - 22 * mm, PAGE_W, 22 * mm, fill=1, stroke=0)
    # Accent line
    c.setFillColor(theme_color)
    c.rect(0, PAGE_H - 23 * mm, PAGE_W, 1 * mm, fill=1, stroke=0)

    # Title (right-anchored)
    draw_text_rtl(c, PAGE_W - MARGIN, PAGE_H - 12 * mm, title, "Arabic-Bold", 18, SURFACE)
    if subtitle:
        draw_text_rtl(c, PAGE_W - MARGIN, PAGE_H - 18 * mm, subtitle, "Arabic", 9, colors.HexColor("#cbd5e1"))

    # Page indicator (left)
    if page_num is not None:
        page_label = ar("صفحة") + f"  {page_num} / {total}"
        c.setFillColor(SURFACE)
        c.setFont("Arabic", 9)
        c.drawString(MARGIN, PAGE_H - 12 * mm, page_label)

    # Subtle bottom margin line
    c.setStrokeColor(BORDER)
    c.setLineWidth(0.3)
    c.line(MARGIN, MARGIN, PAGE_W - MARGIN, MARGIN)
    draw_text_rtl(c, PAGE_W - MARGIN, MARGIN - 4 * mm, "Moroccan Taste POS · نظام المستودعات v5.10.48", "Arabic", 7, INK_FAINT)


# ──────────────────────── Pages ────────────────────────
def page_cover(c, total_pages):
    """Cover page."""
    # Full bleed gradient background
    c.setFillColor(INK)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

    # Decorative gradient bars
    for i, color in enumerate([PRIMARY, INFO, SUCCESS, WARNING, DANGER]):
        c.setFillColor(color)
        c.rect(0, PAGE_H - (30 + i * 4) * mm, PAGE_W, 4 * mm, fill=1, stroke=0)

    # Title
    cx = PAGE_W / 2
    draw_text_center(c, cx, PAGE_H - 75 * mm, "الخريطة الذهنية الشاملة", "Arabic-Bold", 26, SURFACE)
    draw_text_center(c, cx, PAGE_H - 90 * mm, "لنظام المستودعات والمخزون", "Arabic-Bold", 22, colors.HexColor("#cbd5e1"))

    # Project badge
    badge_w, badge_h = 120 * mm, 12 * mm
    bx = (PAGE_W - badge_w) / 2
    by = PAGE_H - 110 * mm
    c.setFillColor(PRIMARY)
    c.setStrokeColor(PRIMARY)
    c.roundRect(bx, by, badge_w, badge_h, badge_h / 2, fill=1, stroke=1)
    draw_text_center(c, cx, by + 4 * mm, "Moroccan Taste POS · نسخة v5.10.48", "Arabic-Bold", 11, SURFACE)

    # Description (right-anchored, multi-line)
    desc_y = PAGE_H - 140 * mm
    lines = [
        "هذا الملف يوضّح بنية نظام المستودعات في المشروع — كل الكيانات،",
        "الدفاتر، دورات الحياة، الأذرع، الشاشات، والصلاحيات — في 9 أوراق منظَّمة",
        "مرتَّبة بأسلوب الخريطة الذهنية (Mind Map).",
    ]
    for i, line in enumerate(lines):
        draw_text_center(c, cx, desc_y - i * 6 * mm, line, "Arabic", 11, colors.HexColor("#e2e8f0"))

    # Bottom contents list
    contents_box_y = 60 * mm
    contents_box_h = 90 * mm
    c.setFillColor(colors.HexColor("#1e293b"))
    c.setStrokeColor(colors.HexColor("#334155"))
    c.roundRect(MARGIN, contents_box_y, PAGE_W - 2 * MARGIN, contents_box_h, 8, fill=1, stroke=1)

    draw_text_rtl(c, PAGE_W - MARGIN - 8 * mm, contents_box_y + contents_box_h - 10 * mm,
                  "محتويات الخريطة الذهنية", "Arabic-Bold", 14, SURFACE)

    toc = [
        (2, "النظرة المعمارية (UI · API · DB)"),
        (3, "الكيانات الأساسية وعلاقاتها"),
        (4, "دفتر حركات المخزون (Movement Ledger)"),
        (5, "دورة حياة إذونات الصرف (Stock Issues)"),
        (6, "دورة حياة أوامر الإنتاج"),
        (7, "تدفّق الجرد وتعديل الكمية"),
        (8, "خريطة شاشات الواجهة (15 قسم)"),
        (9, "مصفوفة الصلاحيات + قواعد التحقّق"),
    ]
    for i, (page, label) in enumerate(toc):
        y = contents_box_y + contents_box_h - 22 * mm - i * 8 * mm
        # bullet
        c.setFillColor(PRIMARY)
        c.circle(PAGE_W - MARGIN - 10 * mm, y + 2, 2.2, fill=1, stroke=0)
        # label
        draw_text_rtl(c, PAGE_W - MARGIN - 15 * mm, y, label, "Arabic", 11, SURFACE)
        # page-num chip
        c.setFillColor(PRIMARY_SOFT)
        c.setStrokeColor(PRIMARY)
        chip_w = 22
        chip_x = MARGIN + 8 * mm
        c.roundRect(chip_x, y - 2, chip_w, 12, 6, fill=1, stroke=1)
        c.setFillColor(PRIMARY)
        c.setFont("Arabic-Bold", 9)
        c.drawString(chip_x + 5, y + 1, f"P {page}")

    c.showPage()


def page_architecture(c, total):
    """Page 2 — Three-layer architecture."""
    page_header(c, "النظرة المعمارية الشاملة", "ثلاث طبقات: واجهة المستخدم — الخادم — قاعدة البيانات", 2, total, INFO)
    top = PAGE_H - 30 * mm

    # ── Layer 1: UI ──
    layer_h = 38 * mm
    y1 = top - 8 * mm - layer_h
    draw_card(c, MARGIN, y1, PAGE_W - 2 * MARGIN, layer_h, fill=INFO_SOFT, stroke=INFO, accent=INFO)
    draw_text_rtl(c, PAGE_W - MARGIN - 8, y1 + layer_h - 8 * mm, "1) واجهة المستخدم (Browser)", "Arabic-Bold", 13, INK)
    draw_text_rtl(c, PAGE_W - MARGIN - 8, y1 + layer_h - 14 * mm, "Vanilla JS + Enterprise UI Kit (ent-ui)", "Arabic", 9, INK_MUTED)

    # UI components inside layer 1
    ui_items = [
        ("الجرد", SUCCESS_SOFT, SUCCESS),
        ("التعديلات", DANGER_SOFT, DANGER),
        ("التحويلات (GL)", INFO_SOFT, INFO),
        ("أوامر الإنتاج", WARNING_SOFT, WARNING),
        ("الصلاحية", DANGER_SOFT, DANGER),
        ("التحليلات", PURPLE_SOFT, PURPLE),
    ]
    chip_w = 28 * mm
    chip_h = 8 * mm
    chip_gap = 2 * mm
    total_chips_w = len(ui_items) * chip_w + (len(ui_items) - 1) * chip_gap
    start_x = (PAGE_W - total_chips_w) / 2
    for i, (label, bg, ink) in enumerate(ui_items):
        x = start_x + i * (chip_w + chip_gap)
        draw_label_chip(c, x, y1 + 4 * mm, chip_w, chip_h, ar(label), bg, ink)

    # Connector arrows down ↓
    draw_arrow(c, PAGE_W / 2, y1, PAGE_W / 2, y1 - 8 * mm, color=INK_MUTED, width=1.2)
    c.setFillColor(INK_MUTED)
    c.setFont("Arabic-Bold", 7)
    c.drawString(PAGE_W / 2 + 4, y1 - 4 * mm, "HTTP / fetch")

    # ── Layer 2: API ──
    y2 = y1 - 16 * mm - layer_h
    draw_card(c, MARGIN, y2, PAGE_W - 2 * MARGIN, layer_h, fill=PRIMARY_SOFT, stroke=PRIMARY, accent=PRIMARY)
    draw_text_rtl(c, PAGE_W - MARGIN - 8, y2 + layer_h - 8 * mm, "2) خادم Node.js + Express", "Arabic-Bold", 13, INK)
    draw_text_rtl(c, PAGE_W - MARGIN - 8, y2 + layer_h - 14 * mm, "Routes موزَّعة على modules — كل router مسؤول عن مجال", "Arabic", 9, INK_MUTED)

    api_routes = [
        "/erp/stock-issues",
        "/erp/production-orders",
        "/erp/warehouses",
        "/inventory/stocktakes",
        "/inventory/adjustments",
        "/erp/movements",
    ]
    route_chip_w = 32 * mm
    route_chip_h = 6 * mm
    rcw = 6 * route_chip_w + 5 * 2 * mm
    rsx = (PAGE_W - rcw) / 2
    for i, route in enumerate(api_routes):
        x = rsx + i * (route_chip_w + 2 * mm)
        c.setFillColor(SURFACE)
        c.setStrokeColor(PRIMARY)
        c.roundRect(x, y2 + 5 * mm, route_chip_w, route_chip_h, 3, fill=1, stroke=1)
        c.setFillColor(PRIMARY)
        c.setFont("Arabic-Bold", 7)
        c.drawString(x + 3, y2 + 5 * mm + 2, route)

    draw_arrow(c, PAGE_W / 2, y2, PAGE_W / 2, y2 - 8 * mm, color=INK_MUTED, width=1.2)
    c.setFillColor(INK_MUTED)
    c.setFont("Arabic-Bold", 7)
    c.drawString(PAGE_W / 2 + 4, y2 - 4 * mm, "SQL")

    # ── Layer 3: DB ──
    y3 = y2 - 16 * mm - layer_h
    draw_card(c, MARGIN, y3, PAGE_W - 2 * MARGIN, layer_h, fill=SUCCESS_SOFT, stroke=SUCCESS, accent=SUCCESS)
    draw_text_rtl(c, PAGE_W - MARGIN - 8, y3 + layer_h - 8 * mm, "3) قاعدة بيانات MariaDB / MySQL", "Arabic-Bold", 13, INK)
    draw_text_rtl(c, PAGE_W - MARGIN - 8, y3 + layer_h - 14 * mm, "جداول معاملاتية + جدول حركات أساسي (single source of truth)", "Arabic", 9, INK_MUTED)

    db_tables = [
        "warehouse_stock", "inventory_movements", "stock_issues", "stock_issue_items",
        "production_orders", "stocktakes", "adjustments", "gl_journals",
    ]
    tcw = 28 * mm
    tch = 6 * mm
    cols = 4
    rows = 2
    grid_w = cols * tcw + (cols - 1) * 2 * mm
    sx = (PAGE_W - grid_w) / 2
    for i, t in enumerate(db_tables):
        row = i // cols
        col = i % cols
        x = sx + col * (tcw + 2 * mm)
        y = y3 + 8 * mm - row * 8 * mm
        c.setFillColor(SURFACE)
        c.setStrokeColor(SUCCESS)
        c.roundRect(x, y, tcw, tch, 2, fill=1, stroke=1)
        c.setFillColor(SUCCESS)
        c.setFont("Arabic-Bold", 7)
        c.drawString(x + 3, y + 2, t)

    # Side notes (right panel)
    notes_y = y3 - 12 * mm
    draw_text_rtl(c, PAGE_W - MARGIN, notes_y, "ملاحظات معمارية:", "Arabic-Bold", 10, INK)
    notes = [
        "• warehouse_stock يحمل الرصيد الفعلي لكل (item × warehouse)",
        "• inventory_movements هو ledger أساسي — لا يُحذف، فقط يُضاف",
        "• كل تعديل في warehouse_stock يجب أن يقابله سطر في inventory_movements",
        "• gl_journals يُسجَّل عند الترحيل المحاسبي (issue/receive/reverse)",
    ]
    for i, note in enumerate(notes):
        draw_text_rtl(c, PAGE_W - MARGIN - 4, notes_y - (i + 1) * 5 * mm, note, "Arabic", 8.5, INK_MUTED)

    c.showPage()


def page_entities(c, total):
    """Page 3 — Core entities ERD-style."""
    page_header(c, "الكيانات الأساسية وعلاقاتها", "Entity-Relationship Diagram مبسَّط", 3, total, PURPLE)

    # Layout: warehouses ← inv_items ← warehouse_stock → inventory_movements
    #                        ↑                              ↑
    #         brands → categories                  stock_issue_items, adjustments...

    # Define entity boxes
    def entity(x, y, w, h, name, fields, color):
        c.setFillColor(color)
        c.setStrokeColor(colors.HexColor("#1e293b"))
        c.setLineWidth(0.6)
        c.roundRect(x, y, w, h, 4, fill=1, stroke=1)
        # Title bar
        c.setFillColor(colors.HexColor("#0f172a"))
        c.rect(x, y + h - 7 * mm, w, 7 * mm, fill=1, stroke=0)
        # Name
        c.setFillColor(SURFACE)
        c.setFont("Arabic-Bold", 9)
        text_w = c.stringWidth(name, "Arabic-Bold", 9)
        c.drawString(x + (w - text_w) / 2, y + h - 7 * mm + 1.5, name)
        # Fields
        c.setFillColor(INK)
        c.setFont("Arabic", 7)
        for i, field in enumerate(fields):
            c.drawString(x + 3, y + h - 7 * mm - 5 - i * 9, field)

    # ── Top row: brands, branches, warehouses, users ──
    y_top = PAGE_H - 50 * mm
    entity_h = 25 * mm
    entity_w = 32 * mm
    spacing = 8 * mm

    cols_top = 4
    total_w = cols_top * entity_w + (cols_top - 1) * spacing
    sx = (PAGE_W - total_w) / 2

    entities_top = [
        ("brands",     ["id (PK)", "name", "code", "status"],                      INFO_SOFT),
        ("branches",   ["id (PK)", "brand_id (FK)", "name", "city"],               INFO_SOFT),
        ("warehouses", ["id (PK)", "brand_id (FK)", "branch_id (FK)", "type"],     INFO_SOFT),
        ("users",      ["username (PK)", "role", "full_name", "branch_id"],        PRIMARY_SOFT),
    ]
    for i, (n, f, color) in enumerate(entities_top):
        x = sx + i * (entity_w + spacing)
        entity(x, y_top, entity_w, entity_h, n, f, color)

    # ── Middle row: inv_items, warehouse_stock ──
    y_mid = y_top - 38 * mm
    entities_mid = [
        ("inv_items",         ["id (PK)", "name", "unit", "category", "is_semi_finished", "default_cost"], SUCCESS_SOFT),
        ("warehouse_stock",   ["item_id (FK)", "warehouse_id (FK)", "stock (qty)", "value", "PK(item,wh)"], SUCCESS_SOFT),
        ("inventory_movements", ["id (PK)", "item_id", "warehouse_id", "direction (in/out)", "qty", "reason", "ref_type", "ref_id"], WARNING_SOFT),
    ]
    mid_w = 50 * mm
    mid_h = 38 * mm
    total_mid = 3 * mid_w + 2 * spacing
    sx_mid = (PAGE_W - total_mid) / 2
    for i, (n, f, color) in enumerate(entities_mid):
        x = sx_mid + i * (mid_w + spacing)
        entity(x, y_mid, mid_w, mid_h, n, f, color)

    # ── Bottom row: transaction entities ──
    y_bot = y_mid - 50 * mm
    entities_bot = [
        ("stock_issues / items",  ["id (PK)", "issue_number", "from_wh", "to_wh", "status", "items[]"],    INFO_SOFT),
        ("stocktakes / items",    ["id (PK)", "warehouse_id", "username", "items[]", "totalVariance"],     SUCCESS_SOFT),
        ("adjustments / items",   ["id (PK)", "warehouse_id", "reason", "items[]", "totalCost"],           DANGER_SOFT),
        ("production_orders",     ["id (PK)", "qty", "raw_wh", "finished_wh", "status"],                   WARNING_SOFT),
        ("gl_journals",           ["id (PK)", "tx_ref", "debit_acct", "credit_acct", "amount"],            PURPLE_SOFT),
    ]
    bot_w = 32 * mm
    bot_h = 32 * mm
    total_bot = 5 * bot_w + 4 * spacing
    sx_bot = (PAGE_W - total_bot) / 2
    for i, (n, f, color) in enumerate(entities_bot):
        x = sx_bot + i * (bot_w + spacing)
        entity(x, y_bot, bot_w, bot_h, n, f, color)

    # Relationships — top→mid
    # brands→warehouses (left arrow)
    draw_arrow(c, sx + entity_w / 2, y_top,
               sx_mid + mid_w / 2, y_mid + mid_h,
               color=INK_FAINT, width=0.5, head=1.5, dashed=True)
    # warehouses→warehouse_stock
    draw_arrow(c, sx + 2 * (entity_w + spacing) + entity_w / 2, y_top,
               sx_mid + mid_w + spacing + mid_w / 2, y_mid + mid_h,
               color=INK_FAINT, width=0.5, head=1.5, dashed=True)
    # inv_items→warehouse_stock
    draw_arrow(c, sx_mid + mid_w / 2, y_mid,
               sx_mid + mid_w + spacing + mid_w / 4, y_mid - 2,
               color=INK_MUTED, width=0.7, head=2)
    # warehouse_stock→inventory_movements
    draw_arrow(c, sx_mid + mid_w + spacing + mid_w, y_mid + mid_h / 2,
               sx_mid + 2 * (mid_w + spacing), y_mid + mid_h / 2,
               color=INK_MUTED, width=0.7, head=2)
    c.setFillColor(INK_MUTED)
    c.setFont("Arabic-Bold", 6)
    c.drawString(sx_mid + mid_w + spacing + mid_w + 2, y_mid + mid_h / 2 + 1, "writes ledger row")

    # transaction → inventory_movements (dashed up)
    for i in range(4):  # 4 transaction entities feed the ledger
        x_start = sx_bot + i * (bot_w + spacing) + bot_w / 2
        x_end = sx_mid + 2 * (mid_w + spacing) + mid_w / 2
        draw_arrow(c, x_start, y_bot + bot_h, x_end, y_mid, color=INK_FAINT, width=0.4, head=1.5, dashed=True)

    # Legend
    leg_y = y_bot - 20 * mm
    draw_text_rtl(c, PAGE_W - MARGIN, leg_y, "ملاحظة: كل المعاملات تُسجَّل في inventory_movements بدون استثناء.", "Arabic-Bold", 9, DANGER)
    draw_text_rtl(c, PAGE_W - MARGIN, leg_y - 5 * mm, "هذا هو المصدر الموثوق الوحيد (Single Source of Truth) لتاريخ المخزون.", "Arabic", 9, INK_MUTED)

    c.showPage()


def page_movement_ledger(c, total):
    """Page 4 — Movement ledger model."""
    page_header(c, "دفتر حركات المخزون (Movement Ledger)", "كل ما يتحرَّك يُسجَّل — لا حذف، فقط إضافة", 4, total, WARNING)

    # Center diagram: bidirectional flows IN/OUT
    cx = PAGE_W / 2
    top = PAGE_H - 35 * mm

    # Central node: inventory_movements
    central_w, central_h = 70 * mm, 18 * mm
    central_x = (PAGE_W - central_w) / 2
    central_y = PAGE_H / 2 - central_h / 2
    c.setFillColor(WARNING)
    c.setStrokeColor(WARNING)
    c.roundRect(central_x, central_y, central_w, central_h, 4, fill=1, stroke=1)
    draw_text_center(c, cx, central_y + central_h / 2 + 3, "inventory_movements", "Arabic-Bold", 12, SURFACE)
    draw_text_center(c, cx, central_y + 2, "(append-only ledger)", "Arabic", 8, colors.HexColor("#fef3c7"))

    # IN sources (right side — feeds INTO ledger as direction='in')
    in_sources = [
        ("شراء (purchases)",          "ref_type='purchase'",      INFO),
        ("استلام تحويل",                  "ref_type='transfer'",      INFO),
        ("إنتاج (finished good)",  "ref_type='production'",    WARNING),
        ("إرجاع تحويل (للمصدر)",      "ref_type='transfer_reverse'", PINK),
        ("تسوية بزيادة",              "ref_type='adjustment'",    SUCCESS),
        ("جرد بزيادة",                   "ref_type='stocktake'",     SUCCESS),
    ]
    # OUT sources (left side — feeds OUT as direction='out')
    out_sources = [
        ("بيع (sales)",                "ref_type='sale'",          DANGER),
        ("إرسال تحويل",                  "ref_type='transfer'",      INFO),
        ("استهلاك إنتاج",              "ref_type='production'",    WARNING),
        ("إرجاع تحويل (للوجهة)",       "ref_type='transfer_reverse'", PINK),
        ("تسوية بنقص",                "ref_type='adjustment'",    DANGER),
        ("جرد بنقص",                  "ref_type='stocktake'",     DANGER),
        ("هدر / تلف",                   "ref_type='waste'",         DANGER),
      ]

    # Draw IN sources on the right (column)
    src_w = 56 * mm
    src_h = 11 * mm
    in_x = PAGE_W - MARGIN - src_w
    in_top = PAGE_H - 40 * mm
    for i, (label, code, color) in enumerate(in_sources):
        y = in_top - i * (src_h + 3 * mm)
        # Card
        c.setFillColor(SURFACE)
        c.setStrokeColor(color)
        c.setLineWidth(0.8)
        c.roundRect(in_x, y, src_w, src_h, 3, fill=1, stroke=1)
        # Accent stripe on right (start in RTL)
        c.setFillColor(color)
        c.rect(in_x + src_w - 2.5, y, 2.5, src_h, fill=1, stroke=0)
        # Label
        draw_text_rtl(c, in_x + src_w - 6, y + src_h / 2 + 1, label, "Arabic-Bold", 8.5, INK)
        draw_text_rtl(c, in_x + src_w - 6, y + 1.5, code, "Arabic", 6.5, INK_FAINT)

        # Arrow → center (only for visible flow indication, drawn to one anchor)
        arrow_end_x = central_x + central_w
        arrow_end_y = central_y + central_h / 2 + (i - 2) * 1.5  # spread vertically
        draw_arrow(c, in_x, y + src_h / 2, arrow_end_x + 2, arrow_end_y,
                   color=color, width=0.5, head=1.8)

    # IN header
    draw_text_rtl(c, in_x + src_w, PAGE_H - 30 * mm, "مصادر الإدخال (direction = 'in')", "Arabic-Bold", 11, SUCCESS)

    # OUT sources on the left
    out_x = MARGIN
    out_top = PAGE_H - 40 * mm
    for i, (label, code, color) in enumerate(out_sources):
        y = out_top - i * (src_h + 3 * mm)
        c.setFillColor(SURFACE)
        c.setStrokeColor(color)
        c.setLineWidth(0.8)
        c.roundRect(out_x, y, src_w, src_h, 3, fill=1, stroke=1)
        c.setFillColor(color)
        c.rect(out_x, y, 2.5, src_h, fill=1, stroke=0)
        draw_text_rtl(c, out_x + src_w - 4, y + src_h / 2 + 1, label, "Arabic-Bold", 8.5, INK)
        draw_text_rtl(c, out_x + src_w - 4, y + 1.5, code, "Arabic", 6.5, INK_FAINT)
        # Arrow from center → left source
        arrow_start_x = central_x
        arrow_start_y = central_y + central_h / 2 + (i - 3) * 1.5
        draw_arrow(c, arrow_start_x - 2, arrow_start_y, out_x + src_w, y + src_h / 2,
                   color=color, width=0.5, head=1.8)

    draw_text_rtl(c, out_x + src_w, PAGE_H - 30 * mm, "مصادر الإخراج (direction = 'out')", "Arabic-Bold", 11, DANGER)

    # Bottom: schema reminder
    schema_y = MARGIN + 12 * mm
    draw_card(c, MARGIN, schema_y, PAGE_W - 2 * MARGIN, 32 * mm, fill=colors.HexColor("#fffbeb"), stroke=WARNING, accent=WARNING)
    draw_text_rtl(c, PAGE_W - MARGIN - 6, schema_y + 26 * mm, "بنية inventory_movements", "Arabic-Bold", 11, INK)
    fields = [
        "id · item_id · warehouse_id · direction (in/out) · qty · unit_cost · total_cost",
        "reason (نصّي بالعربية) · reference_type (sale/purchase/transfer/...) · reference_id",
        "created_by · created_at · branch_id (لتسهيل التقارير)",
    ]
    for i, f in enumerate(fields):
        draw_text_ltr(c, MARGIN + 8, schema_y + 20 * mm - i * 5 * mm, "  " + f, "Arabic", 8, INK_MUTED)

    c.showPage()


def page_stock_issue_lifecycle(c, total):
    """Page 5 — Stock Issues state machine."""
    page_header(c, "دورة حياة إذونات الصرف (Transfers)", "حالة → حالة | كل انتقال يُسجَّل في الـ ledger", 5, total, INFO)

    # State machine: draft → approved → issued → received | + reversed (side-track), + cancelled
    states = [
        ("draft",     "مسودة",       INK_FAINT,  -1),
        ("approved",  "معتمَد",     INFO,      0),
        ("issued",    "تم الصرف",    WARNING,    0),
        ("received",  "تم الاستلام", SUCCESS,    0),
    ]

    state_w = 32 * mm
    state_h = 18 * mm
    gap = 14 * mm
    total_w = 4 * state_w + 3 * gap
    sx = (PAGE_W - total_w) / 2
    sy = PAGE_H / 2 + 30 * mm

    for i, (key, label, color, _) in enumerate(states):
        x = sx + i * (state_w + gap)
        c.setFillColor(color)
        c.setStrokeColor(color)
        c.roundRect(x, sy, state_w, state_h, 6, fill=1, stroke=1)
        draw_text_center(c, x + state_w / 2, sy + state_h / 2 + 3, label, "Arabic-Bold", 12, SURFACE)
        draw_text_center(c, x + state_w / 2, sy + 3, key, "Arabic", 8, colors.HexColor("#cbd5e1") if color != INK_FAINT else INK_MUTED)
        # Arrow to next
        if i < len(states) - 1:
            draw_arrow(c, x + state_w + 2, sy + state_h / 2,
                       sx + (i + 1) * (state_w + gap) - 2, sy + state_h / 2,
                       color=INK_MUTED, width=1.2, head=3)
            # Action label
            actions = ["siApprove()", "siIssue()", "siReceive()"]
            draw_text_center(c, x + state_w + gap / 2, sy + state_h / 2 + 4, actions[i], "Arabic-Bold", 7, INK_MUTED)

    # Cancelled (side route from draft)
    cancel_y = sy - 28 * mm
    cancel_x = sx
    c.setFillColor(DANGER)
    c.setStrokeColor(DANGER)
    c.roundRect(cancel_x, cancel_y, state_w, state_h, 6, fill=1, stroke=1)
    draw_text_center(c, cancel_x + state_w / 2, cancel_y + state_h / 2 + 3, "ملغى", "Arabic-Bold", 12, SURFACE)
    draw_text_center(c, cancel_x + state_w / 2, cancel_y + 3, "cancelled", "Arabic", 8, colors.HexColor("#fecaca"))
    draw_arrow(c, sx + state_w / 2, sy, cancel_x + state_w / 2, cancel_y + state_h,
               color=DANGER, width=0.8, head=2.5, dashed=True)
    c.setFillColor(DANGER)
    c.setFont("Arabic-Bold", 7)
    c.drawString(sx + state_w / 2 + 3, sy - 10 * mm, "siCancel()")

    # Reversed (side route from issued/received)
    rev_x = sx + 2.5 * (state_w + gap) + 8
    rev_y = cancel_y
    c.setFillColor(PINK)
    c.setStrokeColor(PINK)
    c.roundRect(rev_x, rev_y, state_w + 6, state_h, 6, fill=1, stroke=1)
    draw_text_center(c, rev_x + (state_w + 6) / 2, rev_y + state_h / 2 + 3, "مُرجَع", "Arabic-Bold", 12, SURFACE)
    draw_text_center(c, rev_x + (state_w + 6) / 2, rev_y + 3, "reversed", "Arabic", 8, colors.HexColor("#fbcfe8"))
    # From issued
    draw_arrow(c, sx + 2 * (state_w + gap) + state_w / 2, sy,
               rev_x + (state_w + 6) / 4, rev_y + state_h,
               color=PINK, width=0.8, head=2.5, dashed=True)
    # From received
    draw_arrow(c, sx + 3 * (state_w + gap) + state_w / 2, sy,
               rev_x + 3 * (state_w + 6) / 4, rev_y + state_h,
               color=PINK, width=0.8, head=2.5, dashed=True)
    c.setFillColor(PINK)
    c.setFont("Arabic-Bold", 7)
    c.drawString(rev_x + (state_w + 6) / 2 - 8, rev_y + state_h + 4, "siOpenReverseConfirm()")

    # Bottom: validations & side-effects table
    val_y = cancel_y - 35 * mm
    draw_card(c, MARGIN, val_y, PAGE_W - 2 * MARGIN, 32 * mm, fill=INFO_SOFT, stroke=INFO, accent=INFO)
    draw_text_rtl(c, PAGE_W - MARGIN - 6, val_y + 26 * mm, "تحققات حرجة في الخادم (v5.10.40)", "Arabic-Bold", 11, INK)
    validations = [
        "• SAME_WAREHOUSE — يُرفض إنشاء إذن المصدر = الوجهة (سطر 258 في routes/warehouse-ops.js)",
        "• OVER_RECEIPT — يُرفض qty_received > qty_issued عند الاستلام (سطر 452)",
        "• REASON_REQUIRED — السبب إلزامي عند الإرجاع (سطر 531)",
        "• الإرجاع يكتب صفّين في inventory_movements (in للمصدر + out للوجهة) بـ ref_type='transfer_reverse'",
        "• الترحيل المحاسبي gl_journals تلقائي عند issue + reverse",
    ]
    for i, v in enumerate(validations):
        draw_text_rtl(c, PAGE_W - MARGIN - 6, val_y + 20 * mm - i * 4 * mm, v, "Arabic", 8.5, INK_MUTED)

    c.showPage()


def page_production_lifecycle(c, total):
    """Page 6 — Production orders."""
    page_header(c, "دورة حياة أوامر الإنتاج", "تصنيع المنتجات من المواد الخام وفق BOM (Recipe)", 6, total, WARNING)

    # States: planned → released → completed | cancelled
    states = [
        ("مخطَّط",   "planned",   INK_FAINT),
        ("مُطلق",   "released",  WARNING),
        ("مكتمل",  "completed", SUCCESS),
    ]
    state_w = 38 * mm
    state_h = 18 * mm
    gap = 16 * mm
    total_w = 3 * state_w + 2 * gap
    sx = (PAGE_W - total_w) / 2
    sy = PAGE_H - 60 * mm

    for i, (label, key, color) in enumerate(states):
        x = sx + i * (state_w + gap)
        c.setFillColor(color)
        c.setStrokeColor(color)
        c.roundRect(x, sy, state_w, state_h, 6, fill=1, stroke=1)
        draw_text_center(c, x + state_w / 2, sy + state_h / 2 + 3, label, "Arabic-Bold", 12, SURFACE)
        draw_text_center(c, x + state_w / 2, sy + 3, key, "Arabic", 8, colors.HexColor("#cbd5e1"))
        if i < len(states) - 1:
            draw_arrow(c, x + state_w + 2, sy + state_h / 2,
                       sx + (i + 1) * (state_w + gap) - 2, sy + state_h / 2,
                       color=INK_MUTED, width=1.2, head=3)
            actions = ["prdRelease()", "prdComplete()"]
            draw_text_center(c, x + state_w + gap / 2, sy + state_h / 2 + 4, actions[i], "Arabic-Bold", 7, INK_MUTED)

    # Side-effects diagram
    se_y = sy - 50 * mm

    # On release: consume raw materials
    rel_w = 80 * mm
    rel_x = PAGE_W - MARGIN - rel_w
    draw_card(c, rel_x, se_y, rel_w, 38 * mm, fill=WARNING_SOFT, stroke=WARNING, accent=WARNING)
    draw_text_rtl(c, rel_x + rel_w - 6, se_y + 32 * mm, "عند release", "Arabic-Bold", 11, INK)
    items = [
        "• خصم مكوّنات BOM من المستودع (warehouse_stock--)",
        "• سطر OUT في inventory_movements لكل مكوّن",
        "• reason='إنتاج' · ref_type='production'",
        "• حساب التكلفة الإجمالية = Σ(qty × unit_cost)",
    ]
    for i, x in enumerate(items):
        draw_text_rtl(c, rel_x + rel_w - 6, se_y + 25 * mm - i * 5 * mm, x, "Arabic", 8, INK_MUTED)

    # On complete: add finished good
    cmp_x = MARGIN
    draw_card(c, cmp_x, se_y, rel_w, 38 * mm, fill=SUCCESS_SOFT, stroke=SUCCESS, accent=SUCCESS)
    draw_text_rtl(c, cmp_x + rel_w - 6, se_y + 32 * mm, "عند complete", "Arabic-Bold", 11, INK)
    items_c = [
        "• إضافة المنتج التام للمستودع (warehouse_stock++)",
        "• سطر IN في inventory_movements للمنتج",
        "• reason='إنتاج' · ref_type='production'",
        "• حساب unit_cost للمنتج التام (يُحفظ في inv_items)",
    ]
    for i, x in enumerate(items_c):
        draw_text_rtl(c, cmp_x + rel_w - 6, se_y + 25 * mm - i * 5 * mm, x, "Arabic", 8, INK_MUTED)

    # BOM visualization at bottom
    bom_y = se_y - 50 * mm
    draw_text_rtl(c, PAGE_W - MARGIN, bom_y + 30 * mm, "مثال BOM (Bill of Materials)", "Arabic-Bold", 11, INK)
    # Header
    bom_w = PAGE_W - 2 * MARGIN
    c.setFillColor(SURFACE_2)
    c.setStrokeColor(BORDER)
    c.rect(MARGIN, bom_y + 18 * mm, bom_w, 7 * mm, fill=1, stroke=1)
    cols = ["المنتج", "المكوّن", "كمية", "الوحدة", "التكلفة"]
    col_w = bom_w / 5
    for i, col in enumerate(cols):
        draw_text_center(c, MARGIN + (5 - i - 0.5) * col_w, bom_y + 22 * mm, col, "Arabic-Bold", 8.5, INK)

    rows = [
        ("كابتشينو (1 كوب)", "حليب", "90", "مل", "0.45"),
        ("",                  "حبوب قهوة", "8", "غرام", "0.80"),
        ("",                  "سكر", "5", "غرام", "0.10"),
    ]
    for r, row in enumerate(rows):
        y = bom_y + 18 * mm - (r + 1) * 5 * mm
        c.setStrokeColor(BORDER)
        c.line(MARGIN, y, MARGIN + bom_w, y)
        for ci, cell in enumerate(row):
            draw_text_center(c, MARGIN + (5 - ci - 0.5) * col_w, y + 1.5, cell, "Arabic", 8, INK_MUTED)

    c.showPage()


def page_stocktake_adjustments(c, total):
    """Page 7 — Stocktake + Adjustments flows."""
    page_header(c, "تدفّق الجرد وتعديل الكمية", "حركة المخزون اللحظية → فرق → تسوية", 7, total, SUCCESS)

    # Stocktake flow (top half)
    top = PAGE_H - 35 * mm
    draw_text_rtl(c, PAGE_W - MARGIN, top, "أ) الجرد (Stocktake)", "Arabic-Bold", 13, SUCCESS)

    steps = [
        ("اختيار مستودع",   "warehouse_id",       INFO),
        ("إدخال الكميات",   "actualQty",         INFO),
        ("حساب الفروق",      "variance = actualQty − systemQty", WARNING),
        ("تسجيل الحركة",     "ledger row + warehouse_stock", SUCCESS),
        ("إغلاق المحضر",     "status = closed",    SUCCESS),
    ]
    sw = 32 * mm
    sh = 14 * mm
    gap = 6 * mm
    total_w = 5 * sw + 4 * gap
    sx = (PAGE_W - total_w) / 2
    sy = top - 22 * mm
    for i, (label, code, color) in enumerate(steps):
        x = sx + i * (sw + gap)
        c.setFillColor(color)
        c.setStrokeColor(color)
        c.roundRect(x, sy, sw, sh, 4, fill=1, stroke=1)
        draw_text_center(c, x + sw / 2, sy + sh / 2 + 2, label, "Arabic-Bold", 9, SURFACE)
        draw_text_center(c, x + sw / 2, sy + 2, code, "Arabic", 6, colors.HexColor("#cbd5e1"))
        if i < len(steps) - 1:
            draw_arrow(c, x + sw + 1, sy + sh / 2, sx + (i + 1) * (sw + gap) - 1, sy + sh / 2,
                       color=INK_MUTED, width=0.8, head=2)

    # Adjustment flow (bottom half)
    mid = PAGE_H / 2
    draw_text_rtl(c, PAGE_W - MARGIN, mid + 10 * mm, "ب) تعديل الكمية (Adjustment)", "Arabic-Bold", 13, DANGER)

    adj_steps = [
        ("اختيار المستودع", "warehouse_id",         INFO),
        ("اختيار السبب",  "damaged / admin / settlement / waste", WARNING),
        ("إدخال الكميات", "qty per item",          DANGER),
        ("اعتماد", "approveAdjustment()", SUCCESS),
        ("ترحيل + ledger", "stock-- · gl_journal++", PURPLE),
    ]
    asy = mid - 8 * mm
    for i, (label, code, color) in enumerate(adj_steps):
        x = sx + i * (sw + gap)
        c.setFillColor(color)
        c.setStrokeColor(color)
        c.roundRect(x, asy, sw, sh, 4, fill=1, stroke=1)
        draw_text_center(c, x + sw / 2, asy + sh / 2 + 2, label, "Arabic-Bold", 9, SURFACE)
        draw_text_center(c, x + sw / 2, asy + 2, code, "Arabic", 6, colors.HexColor("#cbd5e1"))
        if i < len(adj_steps) - 1:
            draw_arrow(c, x + sw + 1, asy + sh / 2, sx + (i + 1) * (sw + gap) - 1, asy + sh / 2,
                       color=INK_MUTED, width=0.8, head=2)

    # Bottom rules card
    rules_y = MARGIN + 10 * mm
    draw_card(c, MARGIN, rules_y, PAGE_W - 2 * MARGIN, 50 * mm, fill=DANGER_SOFT, stroke=DANGER, accent=DANGER)
    draw_text_rtl(c, PAGE_W - MARGIN - 6, rules_y + 44 * mm, "قواعد التحقّق (Validation Rules)", "Arabic-Bold", 11, INK)
    rules = [
        "الجرد:",
        "  • لا تُعتمد محاضر بدون كميات فعلية",
        "  • الكمية الفعلية ≥ 0 (لا يمكن أن تكون سالبة)",
        "  • سبب الفرق مطلوب إن كانت |variance| > threshold",
        "تعديل الكمية:",
        "  • السبب مطلوب لكل محضر",
        "  • الكمية الجديدة ≥ 0",
        "  • التعديل يجب أن يكون له نوع (damaged/admin/settlement/waste)",
        "التحويلات:",
        "  • المصدر ≠ الوجهة (SAME_WAREHOUSE rejected)",
        "  • qty المُرسلة ≤ المتاحة في المصدر",
        "  • qty المستلمة ≤ qty المُرسلة (OVER_RECEIPT rejected)",
    ]
    col1_x = PAGE_W - MARGIN - 6
    col2_x = PAGE_W / 2
    for i, r in enumerate(rules):
        x_anchor = col1_x if i < 6 else col2_x
        offset_y = i if i < 6 else i - 6
        draw_text_rtl(c, x_anchor, rules_y + 38 * mm - offset_y * 4.5 * mm, r, "Arabic-Bold" if r.endswith(":") else "Arabic", 8.5, INK if r.endswith(":") else INK_MUTED)

    c.showPage()


def page_ui_sections(c, total):
    """Page 8 — All 15 UI screens with themes."""
    page_header(c, "خريطة شاشات واجهة المستخدم", "15 قسم — منظَّمة في 3 مجموعات", 8, total, PURPLE)

    groups = [
        ("الإعداد (Setup)", PURPLE, [
            ("إدارة مواد المخزون",   "sec_invCatalog",       PURPLE_SOFT, PURPLE),
            ("المستودعات المتعددة",  "erpMultiWarehouses",   INFO_SOFT, INFO),
            ("هيكل المستودعات",       "erpWhHierarchy",       INFO_SOFT, INFO),
            ("نوع الجرد وقيمة المخزون", "erpRptInventoryVal",   PURPLE_SOFT, PURPLE),
        ]),
        ("العمليات (Operations)", INFO, [
            ("تقارير المستودعات",     "erpRptWarehouseLedger", INFO_SOFT, INFO),
            ("إذونات الصرف (GL) ★",  "erpStockIssues",         INFO_SOFT, INFO),
            ("قيود الهدر",              "erpWasteEntries",        DANGER_SOFT, DANGER),
            ("أوامر الإنتاج",            "erpProductionOrders",    WARNING_SOFT, WARNING),
        ]),
        ("التحليلات (Analytics)", WARNING, [
            ("تنبيهات الصلاحية",       "erpExpiryAlerts",        DANGER_SOFT, DANGER),
            ("بطيئة الحركة",            "erpSlowMoving",          WARNING_SOFT, WARNING),
            ("دوران المخزون",            "erpTurnover",            INFO_SOFT, INFO),
            ("إعادة الطلب",             "erpReorderAlerts",       WARNING_SOFT, WARNING),
            ("أيام التغطية",            "erpDaysOfStock",         INFO_SOFT, INFO),
            ("تحليل ABC",               "erpAbcAnalysis",         PURPLE_SOFT, PURPLE),
            ("سجل محاضر الجرد",        "erpStocktakeHistory",    SUCCESS_SOFT, SUCCESS),
        ]),
    ]

    y = PAGE_H - 35 * mm
    for group_name, group_color, items in groups:
        # Group header bar
        gh_h = 8 * mm
        c.setFillColor(group_color)
        c.setStrokeColor(group_color)
        c.roundRect(MARGIN, y - gh_h, PAGE_W - 2 * MARGIN, gh_h, 3, fill=1, stroke=1)
        draw_text_rtl(c, PAGE_W - MARGIN - 6, y - gh_h + 2, group_name, "Arabic-Bold", 11, SURFACE)

        # Items grid (4 per row)
        item_w = 42 * mm
        item_h = 14 * mm
        cols = 4
        for i, (label, id_, bg, ink) in enumerate(items):
            row = i // cols
            col = i % cols
            x = PAGE_W - MARGIN - 6 - (col + 1) * (item_w + 2 * mm) + 2 * mm
            iy = y - gh_h - 4 * mm - row * (item_h + 2 * mm) - item_h
            c.setFillColor(bg)
            c.setStrokeColor(ink)
            c.setLineWidth(0.8)
            c.roundRect(x, iy, item_w, item_h, 4, fill=1, stroke=1)
            # Accent left edge
            c.setFillColor(ink)
            c.rect(x + item_w - 2.5, iy, 2.5, item_h, fill=1, stroke=0)
            # Title
            draw_text_rtl(c, x + item_w - 6, iy + item_h - 4 * mm, label, "Arabic-Bold", 9, INK)
            # ID
            draw_text_rtl(c, x + item_w - 6, iy + 2, id_, "Arabic", 6.5, INK_FAINT)

        rows_count = (len(items) + cols - 1) // cols
        y -= gh_h + 4 * mm + rows_count * (item_h + 2 * mm) + 4 * mm

    # Footer note
    draw_text_rtl(c, PAGE_W - MARGIN, MARGIN + 8 * mm, "★ القسم الأساسي — مرجع تطبيق Enterprise UI Kit الكامل", "Arabic-Bold", 9, INFO)
    draw_text_rtl(c, PAGE_W - MARGIN, MARGIN + 3 * mm, "جميع الأقسام تستخدم بطاقة header gradient + شريط فلاتر موحَّد + KPI cards + جدول enterprise.", "Arabic", 8, INK_MUTED)

    c.showPage()


def page_permissions(c, total):
    """Page 9 — Permission matrix + validation rules summary."""
    page_header(c, "مصفوفة الصلاحيات + ملخص قواعد التحقّق", "PermissionGuard من EntUI · roles × actions", 9, total, DANGER)

    # Permission matrix table
    actions = [
        ("transfers.approve",  "اعتماد التحويل"),
        ("transfers.issue",    "صرف التحويل"),
        ("transfers.receive",  "استلام التحويل"),
        ("transfers.reverse",  "إرجاع التحويل"),
        ("transfers.delete",   "حذف التحويل"),
        ("stocktake.approve",  "اعتماد الجرد"),
        ("stocktake.delete",   "حذف الجرد"),
        ("adjustments.approve","اعتماد التعديل"),
        ("adjustments.create", "إنشاء تعديل"),
        ("adjustments.delete", "حذف تعديل"),
    ]
    roles = [
        ("admin",     "أدمن",    DANGER),
        ("manager",   "مدير",    WARNING),
        ("warehouse", "مستودع",  INFO),
        ("custody",   "عهدة",    PURPLE),
        ("cashier",   "كاشير",   INK_MUTED),
    ]
    # Matrix of (action, role) → allowed?
    # Built from EntUI.Permission.actions
    allow = {
        "transfers.approve":    ["admin", "manager"],
        "transfers.issue":      ["admin", "manager", "warehouse"],
        "transfers.receive":    ["admin", "manager", "warehouse", "custody"],
        "transfers.reverse":    ["admin", "manager"],
        "transfers.delete":     ["admin"],
        "stocktake.approve":    ["admin", "manager"],
        "stocktake.delete":     ["admin"],
        "adjustments.approve":  ["admin", "manager"],
        "adjustments.create":   ["admin", "manager", "warehouse"],
        "adjustments.delete":   ["admin"],
    }

    # Draw table
    table_x = MARGIN
    table_y_top = PAGE_H - 35 * mm
    col_w_action = 50 * mm
    col_w_role = (PAGE_W - 2 * MARGIN - col_w_action) / len(roles)
    row_h = 7 * mm
    header_h = 9 * mm

    # Header row
    c.setFillColor(INK)
    c.rect(table_x, table_y_top - header_h, col_w_action, header_h, fill=1, stroke=1)
    draw_text_center(c, table_x + col_w_action / 2, table_y_top - header_h + 2.5, "الإجراء", "Arabic-Bold", 9.5, SURFACE)
    for i, (role_key, role_label, role_color) in enumerate(roles):
        x = table_x + col_w_action + i * col_w_role
        c.setFillColor(role_color)
        c.rect(x, table_y_top - header_h, col_w_role, header_h, fill=1, stroke=1)
        draw_text_center(c, x + col_w_role / 2, table_y_top - header_h + 2.5, role_label, "Arabic-Bold", 9.5, SURFACE)

    # Data rows
    for r, (action_key, action_label) in enumerate(actions):
        y = table_y_top - header_h - (r + 1) * row_h
        # Action label
        fill = SURFACE if r % 2 == 0 else SURFACE_2
        c.setFillColor(fill)
        c.setStrokeColor(BORDER)
        c.rect(table_x, y, col_w_action, row_h, fill=1, stroke=1)
        draw_text_rtl(c, table_x + col_w_action - 3, y + 2, action_label, "Arabic-Bold", 8.5, INK)
        draw_text_rtl(c, table_x + col_w_action - 3, y + row_h - 4, action_key, "Arabic", 6, INK_FAINT)
        # Role cells
        for i, (role_key, _, _) in enumerate(roles):
            cx = table_x + col_w_action + i * col_w_role
            allowed = role_key in allow.get(action_key, []) or role_key == "admin"
            c.setFillColor(fill)
            c.setStrokeColor(BORDER)
            c.rect(cx, y, col_w_role, row_h, fill=1, stroke=1)
            mark = "✓" if allowed else "✗"
            mark_color = SUCCESS if allowed else DANGER
            c.setFillColor(mark_color)
            c.setFont("Arabic-Bold", 13)
            text_w = c.stringWidth(mark, "Arabic-Bold", 13)
            c.drawString(cx + (col_w_role - text_w) / 2, y + 1.5, mark)

    # Bottom: error codes reference card
    err_y = MARGIN + 12 * mm
    draw_card(c, MARGIN, err_y, PAGE_W - 2 * MARGIN, 38 * mm, fill=DANGER_SOFT, stroke=DANGER, accent=DANGER)
    draw_text_rtl(c, PAGE_W - MARGIN - 6, err_y + 32 * mm, "أكواد أخطاء الخادم (Server Error Codes)", "Arabic-Bold", 11, INK)
    codes = [
        ("SAME_WAREHOUSE",  "لا يمكن أن يكون المصدر = الوجهة في تحويل"),
        ("OVER_RECEIPT",    "qty_received > qty_issued — مرفوض"),
        ("REASON_REQUIRED", "سبب الإرجاع مطلوب (>= 4 أحرف)"),
        ("INSUFFICIENT_STOCK", "الكمية المطلوبة أكبر من المتاحة"),
        ("INVALID_STATUS_TRANSITION", "انتقال حالة غير مسموح"),
    ]
    code_x = PAGE_W - MARGIN - 6
    for i, (code, desc) in enumerate(codes):
        y = err_y + 26 * mm - i * 5 * mm
        # Chip
        chip_w = 38 * mm
        c.setFillColor(DANGER)
        c.setStrokeColor(DANGER)
        c.roundRect(code_x - chip_w, y - 1, chip_w, 4 * mm, 2, fill=1, stroke=1)
        c.setFillColor(SURFACE)
        c.setFont("Arabic-Bold", 7.5)
        text_w = c.stringWidth(code, "Arabic-Bold", 7.5)
        c.drawString(code_x - chip_w + (chip_w - text_w) / 2, y + 0.5, code)
        # Description
        draw_text_rtl(c, code_x - chip_w - 4, y + 1, desc, "Arabic", 8.5, INK_MUTED)

    c.showPage()


# ──────────────────────── Build the PDF ────────────────────────
def main():
    out_path = Path(__file__).resolve().parent.parent / "warehouse-system-mindmap.pdf"
    c = canvas.Canvas(str(out_path), pagesize=A4)
    c.setTitle(ar("الخريطة الذهنية لنظام المستودعات — Moroccan Taste POS"))
    c.setAuthor("Moroccan Taste POS")
    c.setSubject(ar("خريطة ذهنية شاملة لبنية نظام المستودع v5.10.48"))

    total = 9
    page_cover(c, total)
    page_architecture(c, total)
    page_entities(c, total)
    page_movement_ledger(c, total)
    page_stock_issue_lifecycle(c, total)
    page_production_lifecycle(c, total)
    page_stocktake_adjustments(c, total)
    page_ui_sections(c, total)
    page_permissions(c, total)

    c.save()
    print(f"OK: {out_path}")
    return out_path


if __name__ == "__main__":
    main()
