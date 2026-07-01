"""Build the over-the-call presenter script PDF.

This is NOT a slide deck. It's a script the presenter reads before and
during the call: every section has a DO line (what to share on screen)
and a SAY block (the actual words to use). Tone is conversational and
beginner-friendly — the audience is Pontus folks, not engineers.

Run: python3 scripts/build_call_script_pdf.py
Output: ~/Desktop/Pontus_Tools_Call_Script.pdf
"""

from __future__ import annotations

import os

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

OUT = os.path.expanduser("~/Desktop/Pontus_Tools_Call_Script.pdf")

# Pontus palette (same as the existing presentation builder)
INK = HexColor("#0a0a0a")
MUTED = HexColor("#525252")
SUBTLE = HexColor("#737373")
LINE = HexColor("#e5e5e5")
BG = HexColor("#fafafa")
ACCENT = HexColor("#2563eb")
ACCENT_SOFT = HexColor("#dbeafe")
GREEN = HexColor("#15803d")
GREEN_SOFT = HexColor("#dcfce7")
AMBER = HexColor("#b45309")
AMBER_SOFT = HexColor("#fef3c7")
RED = HexColor("#b91c1c")
RED_SOFT = HexColor("#fee2e2")
GREY_SOFT = HexColor("#f5f5f5")

PAGE_W, PAGE_H = LETTER  # portrait 8.5 x 11
MARGIN = 0.7 * inch

styles = getSampleStyleSheet()

H1 = ParagraphStyle(
    "H1", parent=styles["Heading1"], fontName="Helvetica-Bold",
    fontSize=22, leading=26, textColor=INK, spaceAfter=4,
)
H2 = ParagraphStyle(
    "H2", parent=styles["Heading2"], fontName="Helvetica-Bold",
    fontSize=15, leading=19, textColor=INK, spaceAfter=4,
)
SLIDE_TAG = ParagraphStyle(
    "Tag", parent=styles["Normal"], fontName="Helvetica-Bold",
    fontSize=9, leading=11, textColor=ACCENT, spaceAfter=4,
)
SECTION_SUB = ParagraphStyle(
    "Sub", parent=styles["Normal"], fontName="Helvetica",
    fontSize=10.5, leading=14, textColor=MUTED, spaceAfter=8,
)
BODY = ParagraphStyle(
    "Body", parent=styles["Normal"], fontName="Helvetica",
    fontSize=11, leading=15.5, textColor=INK, spaceAfter=6,
    alignment=TA_LEFT,
)
SAY = ParagraphStyle(
    "Say", parent=BODY, fontSize=11.5, leading=17,
)
DO_LABEL = ParagraphStyle(
    "DoLbl", parent=styles["Normal"], fontName="Helvetica-Bold",
    fontSize=10, leading=12, textColor=AMBER, spaceAfter=2,
)
SAY_LABEL = ParagraphStyle(
    "SayLbl", parent=styles["Normal"], fontName="Helvetica-Bold",
    fontSize=10, leading=12, textColor=ACCENT, spaceAfter=2,
)
NOTE_LABEL = ParagraphStyle(
    "NoteLbl", parent=styles["Normal"], fontName="Helvetica-Bold",
    fontSize=10, leading=12, textColor=GREEN, spaceAfter=2,
)
SMALL = ParagraphStyle(
    "Small", parent=styles["Normal"], fontName="Helvetica",
    fontSize=9, leading=12, textColor=MUTED,
)
TITLE_HUGE = ParagraphStyle(
    "TitleHuge", parent=styles["Title"], fontName="Helvetica-Bold",
    fontSize=36, leading=42, textColor=INK, alignment=TA_LEFT,
)
TITLE_SUB = ParagraphStyle(
    "TitleSub", parent=styles["Normal"], fontName="Helvetica",
    fontSize=13, leading=18, textColor=MUTED, alignment=TA_LEFT,
)


# ----------------------------------------------------------------------
# Page chrome
# ----------------------------------------------------------------------

def page_chrome(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, PAGE_H - 0.5 * inch, PAGE_W - MARGIN, PAGE_H - 0.5 * inch)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.setFillColor(ACCENT)
    canvas.drawString(MARGIN, PAGE_H - 0.36 * inch,
                      "PONTUS  ·  CALL SCRIPT  ·  TOOLS WALKTHROUGH")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 0.36 * inch,
                           "Read before the call")
    canvas.setStrokeColor(LINE)
    canvas.line(MARGIN, 0.55 * inch, PAGE_W - MARGIN, 0.55 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SUBTLE)
    canvas.drawRightString(PAGE_W - MARGIN, 0.38 * inch,
                           f"page {doc.page - 1:02d}")
    canvas.drawString(MARGIN, 0.38 * inch,
                      "Property Tax Checker  +  Tenant Credit Tracker")
    canvas.restoreState()


def cover_chrome(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(BG)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.setFillColor(ACCENT)
    canvas.rect(0, 0, 0.18 * inch, PAGE_H, fill=1, stroke=0)
    canvas.setFont("Helvetica-Bold", 10)
    canvas.setFillColor(ACCENT)
    canvas.drawString(MARGIN, PAGE_H - 0.7 * inch,
                      "PONTUS  ·  INTERNAL  ·  PRESENTER NOTES")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(PAGE_W - MARGIN, 0.4 * inch,
                           "Nicholas Revenco  ·  Pontus Capital")
    canvas.restoreState()


# ----------------------------------------------------------------------
# Block helpers
# ----------------------------------------------------------------------

def boxed_block(label_para, body_paras, border_color, fill_color, width=None):
    """A coloured side-bar box: label on top, body below."""
    if width is None:
        width = PAGE_W - 2 * MARGIN
    inner = [label_para] + body_paras
    t = Table([[inner]], colWidths=[width])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill_color),
        ("LINEBEFORE", (0, 0), (0, -1), 2.5, border_color),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return t


def do_block(text):
    """What the presenter does on screen — amber bar on the left."""
    return boxed_block(
        Paragraph("DO", DO_LABEL),
        [Paragraph(text, BODY)],
        AMBER, AMBER_SOFT,
    )


def say_block(paragraphs):
    """What the presenter says — blue bar on the left. Paragraphs is a list of strings."""
    return boxed_block(
        Paragraph("SAY", SAY_LABEL),
        [Paragraph(p, SAY) for p in paragraphs],
        ACCENT, ACCENT_SOFT,
    )


def note_block(text):
    """Side note to the presenter — green bar on the left."""
    return boxed_block(
        Paragraph("PRESENTER NOTE", NOTE_LABEL),
        [Paragraph(text, BODY)],
        GREEN, GREEN_SOFT,
    )


def slide_header(tag, title, sub=None):
    out = [
        Paragraph(tag.upper(), SLIDE_TAG),
        Paragraph(title, H1),
    ]
    if sub:
        out.append(Paragraph(sub, SECTION_SUB))
    out.append(Spacer(1, 0.08 * inch))
    return out


def section_break():
    return [Spacer(1, 0.15 * inch)]


# ----------------------------------------------------------------------
# Story
# ----------------------------------------------------------------------

story = []

# ---------- COVER ----------
story.append(Spacer(1, 1.6 * inch))
story.append(Paragraph("Pontus Internal Tools", TITLE_HUGE))
story.append(Spacer(1, 0.05 * inch))
story.append(Paragraph("Walkthrough script for the team call.", TITLE_SUB))
story.append(Spacer(1, 0.5 * inch))

story.append(Paragraph(
    "<b>What this document is</b>",
    ParagraphStyle("CovH", parent=BODY, fontName="Helvetica-Bold",
                   fontSize=13, leading=18, textColor=INK, spaceAfter=4),
))
story.append(Paragraph(
    "A presenter script for walking the Pontus team through two internal "
    "tools: the Property Tax Checker and the Tenant Credit Tracker. Every "
    "section has two pieces — <b>DO</b> (what to share on your screen) "
    "and <b>SAY</b> (the actual words). Read it once end-to-end before "
    "the call, then keep it open in a window next to your screen-share.",
    BODY,
))
story.append(Spacer(1, 0.2 * inch))

story.append(Paragraph(
    "<b>Total run-time</b>",
    ParagraphStyle("CovH2", parent=BODY, fontName="Helvetica-Bold",
                   fontSize=13, leading=18, textColor=INK, spaceAfter=4),
))
story.append(Paragraph(
    "About 18 to 22 minutes of talking, plus questions. The flow is built "
    "so you can stop and demo at any point without losing your place.",
    BODY,
))
story.append(Spacer(1, 0.2 * inch))

story.append(Paragraph(
    "<b>Important — about the live demo</b>",
    ParagraphStyle("CovH3", parent=BODY, fontName="Helvetica-Bold",
                   fontSize=13, leading=18, textColor=RED, spaceAfter=4),
))
story.append(Paragraph(
    "The Property Tax Checker is in a Skyvern credit pause right now (the "
    "browser-automation account has exhausted its monthly quota and every "
    "row comes back as <i>Unreachable</i>). The script is written to focus "
    "on <b>what the tool does and the value</b> rather than a live successful "
    "run. There is a prepared recovery line on the <i>Q&amp;A</i> page in "
    "case anyone asks why the dashboard is red.",
    BODY,
))
story.append(PageBreak())

# ---------- AGENDA ----------
story += slide_header(
    "Agenda",
    "What we'll cover, in order",
    "Each slide below corresponds to one screen to share and one block to read.",
)

agenda = [
    ("01", "Opening", "Why these two tools exist."),
    ("02", "The pain today",
        "What a Pontus analyst does by hand right now."),
    ("03", "The vision",
        "Spreadsheet in, spreadsheet out. Same file, just answered."),
    ("04", "Tax Checker — the user flow",
        "Upload, watch, download. Three screens."),
    ("05", "Tax Checker — under the hood",
        "How it visits a county portal it has never seen before."),
    ("06", "Tenant Credit Tracker — the user flow",
        "PDFs in, two numbers per tenant out, with an audit trail."),
    ("07", "Tenant Credit Tracker — under the hood",
        "Why the math is right, every quarter, for every tenant."),
    ("08", "What ties them together",
        "One philosophy: never invent data, always show your work."),
    ("09", "Where this is going",
        "The longer-term plan for internal tooling at Pontus."),
    ("10", "Q&A and prepared answers",
        "Including the <i>why is it red right now</i> question."),
]

rows = []
for n, title, sub in agenda:
    rows.append([
        Paragraph(
            f"<font color='#2563eb'><b>{n}</b></font>",
            ParagraphStyle("AN", parent=BODY, fontSize=12,
                           fontName="Helvetica-Bold", leading=16),
        ),
        Paragraph(
            f"<b>{title}</b><br/><font color='#525252'>{sub}</font>",
            ParagraphStyle("AT", parent=BODY, fontSize=10.5, leading=14),
        ),
    ])
ag = Table(rows, colWidths=[0.6 * inch, PAGE_W - 2 * MARGIN - 0.6 * inch])
ag.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
]))
story.append(ag)
story.append(PageBreak())

# ---------- 01 OPENING ----------
story += slide_header(
    "Slide 01  ·  Opening",
    "Why these tools exist",
    "Two minutes. Set the frame before sharing any screens.",
)
story.append(do_block(
    "Have your camera on. <b>Do not share your screen yet</b> — eye contact "
    "for the first 90 seconds. The first screen-share lands on slide 02."
))
story.append(say_block([
    "Thanks for the time today. I want to walk you through two internal "
    "tools I've been building for Pontus — the Property Tax Checker and the "
    "Tenant Credit Tracker. They look different on the surface, but they're "
    "built around the exact same idea, and I think understanding that idea "
    "is the most important part of this call.",
    "The idea is this: there is a category of work at Pontus where an "
    "analyst sits down with a spreadsheet and spends hours copying numbers "
    "into it from somewhere else. From a county tax website. From a tenant's "
    "income statement PDF. From a portal nobody enjoys logging into. The "
    "spreadsheet is the source of truth, the spreadsheet is what gets sent "
    "around the firm, and the spreadsheet is what gets updated. The work in "
    "between is just plumbing.",
    "These two tools take that plumbing and automate it. You hand the tool "
    "the same workbook you already use, it does the lookups and the math, "
    "and it hands you back the same workbook with the answers filled in. "
    "Nobody learns a new system. Nobody re-enters their data anywhere. The "
    "spreadsheet stays the spreadsheet.",
]))
story.append(note_block(
    "If the team looks engaged here, keep going. If they look skeptical or "
    "rushed, skip directly to slide 04 (the user flow) — the value lands "
    "faster when they see what it does first and hear the philosophy second."
))
story.append(PageBreak())

# ---------- 02 THE PAIN ----------
story += slide_header(
    "Slide 02  ·  The pain today",
    "What an analyst does by hand right now",
    "Two to three minutes. Concrete enough that everyone has felt it.",
)
story.append(do_block(
    "Share screen. Open one of the real workbooks — "
    "<b>PTAX_Master_Final.xlsx</b> on the Desktop is perfect. Scroll slowly "
    "through it so people see the number of rows, the variety of states, "
    "and the columns that are still blank waiting to be filled."
))
story.append(say_block([
    "Here is what one of our analysts is doing right now. This is the "
    "property tax tracker. Pontus owns properties across more than fifteen "
    "states. For every single row on this sheet, somebody needs to know "
    "four things: is the current tax bill paid, is there a balance, when is "
    "the next installment due, and is there a delinquency we should worry "
    "about. That is the job.",
    "Here is the problem. Every county has its own tax website. Some are "
    "modern. Most are not. There is no central database, there is no API, "
    "there is no spreadsheet you can just download. So the analyst opens a "
    "browser, picks the next row, copies the parcel number, finds the "
    "county portal, navigates through a search form or a disclaimer page, "
    "lands on the bill, reads the numbers, types them back into the "
    "spreadsheet, then moves to the next row. Eighty rows. Eighty portals. "
    "Maybe a week of one person's time, every quarter, forever.",
    "The Tenant Credit side is different inputs, same shape of work. Every "
    "quarter, our tenants send us their income statements as PDFs. Somebody "
    "has to open each PDF, find the right line items, do the math — Sales "
    "is this set of revenue lines added up, EBITDA is Net Income plus "
    "Depreciation plus Interest plus a few other add-backs — and type the "
    "two numbers into the tenant credit tracker. Sounds straightforward "
    "until you realize every tenant has a different chart of accounts and "
    "the recipe is different for each one.",
    "Both of these jobs are perfect for software. The inputs are well "
    "defined, the outputs are well defined, and the work in between is "
    "mechanical. That is exactly the shape of work that should not be "
    "consuming an analyst's afternoon.",
]))
story.append(PageBreak())

# ---------- 03 THE VISION ----------
story += slide_header(
    "Slide 03  ·  The vision",
    "Spreadsheet in. Spreadsheet out.",
    "About 90 seconds. This is the elevator pitch — say it slowly.",
)
story.append(do_block(
    "Switch the screen-share to the deployed app's landing page. If the "
    "URL is the production Vercel link, navigate there now. The home page "
    "should show both tools side by side."
))
story.append(say_block([
    "The vision for both of these tools is identical. Take the workbook "
    "that already exists, the workbook the analyst already uses, and make "
    "it the input and the output of the tool. Don't ask anyone to learn a "
    "new system. Don't ask anyone to re-enter their data into a database. "
    "Don't replace the spreadsheet. The spreadsheet is the contract.",
    "An analyst uploads the workbook they already have. The tool does the "
    "busywork — visiting portals, reading PDFs, doing the math — and the "
    "analyst downloads the same workbook back, with the answer cells "
    "filled in cleanly and a notes column explaining what was found. The "
    "file goes back into the same SharePoint folder it came from. Nothing "
    "else in our process changes.",
    "That's the whole product. Everything else — the dashboard, the "
    "Firestore database, the cloud workers — is plumbing in service of "
    "that one promise.",
]))
story.append(note_block(
    "If someone asks <i>what about a real database?</i> at this point, "
    "acknowledge it and move on: <b>yes, that's where this goes</b>. "
    "We're starting from the spreadsheet because that's where the data "
    "lives today. Once the tools are trusted, the workbook becomes a "
    "view onto the database, not the database itself."
))
story.append(PageBreak())

# ---------- 04 TAX CHECKER — USER FLOW ----------
story += slide_header(
    "Slide 04  ·  Tax Checker — the user flow",
    "Three screens: upload, watch, download.",
    "Four minutes. Walk through the screens slowly. This is the part "
    "everyone remembers.",
)
story.append(do_block(
    "Stay on the deployed app. Click into the Property Tax Checker. You "
    "should see the upload card. <b>Do not start a new run live</b> — see "
    "the credit pause note on the cover. Instead, walk through the UI "
    "as if you were about to."
))
story.append(say_block([
    "Three screens. That's all an analyst ever sees.",
    "<b>Screen one — upload.</b> The analyst drags the workbook onto this "
    "page. That's it. No configuration, no column mapping, no settings "
    "panel. The tool figures out the workbook's shape on its own, because "
    "every state's spreadsheet looks a little different — Florida has two "
    "stacked header rows, California has different columns, Texas has its "
    "own layout — and we don't want the analyst to think about any of that.",
]))
story.append(do_block(
    "Click into an <b>existing</b> run from the runs list — pick one that "
    "shows real activity in the rows. The 'live' progress view is what they "
    "should see now."
))
story.append(say_block([
    "<b>Screen two — watch.</b> Once the workbook is uploaded, the run is "
    "live. Every row of the spreadsheet becomes a row in this dashboard. "
    "You can see which properties are being checked right now, which ones "
    "have come back paid, which ones are showing a balance, which ones "
    "needed a human to take a second look. The counters at the top — paid, "
    "needs review, unreachable — update as the run progresses. The analyst "
    "doesn't have to sit and watch, they can close the tab and come back. "
    "But if they want a real-time view, it's right here.",
]))
story.append(do_block(
    "If a finished run is available, click the <b>Download workbook</b> "
    "button. If not, just hover over it and describe what happens."
))
story.append(say_block([
    "<b>Screen three — download.</b> When the run finishes, the analyst "
    "clicks one button and the same workbook they uploaded comes back, "
    "with three things added cleanly to the existing columns. The amount "
    "paid, the payment date, and a confidence marker so the analyst knows "
    "which rows the tool is sure about and which ones it wants them to "
    "look at. There is also a notes column with a one-sentence explanation "
    "per row, like <i>PAID in full $4,974.48 on 2025-12-29</i> or "
    "<i>DELINQUENT — $12,300 owed as of June 9, 2026</i>. No new tabs, no "
    "new sheets, no surprise columns. The formula cells that the analyst "
    "depends on are never touched. The original file is never overwritten "
    "— the tool writes a dated copy so the source stays intact.",
    "That's the whole user experience. Upload, watch, download.",
]))
story.append(PageBreak())

# ---------- 05 TAX CHECKER — UNDER THE HOOD ----------
story += slide_header(
    "Slide 05  ·  Tax Checker — under the hood",
    "How it visits a county portal it has never seen before.",
    "Three to four minutes. The audience is non-engineering — keep it concrete.",
)
story.append(do_block(
    "Switch to the Property Tax Checker run-detail screen for a row with "
    "rich evidence. If you have a recording URL from a Skyvern run, opening "
    "it is a strong visual moment — the audience watches the browser "
    "literally navigate the portal."
))
story.append(say_block([
    "Most of the audience does not need to know the architecture. But the "
    "one thing worth understanding is how this thing handles a county "
    "website it has never seen before. Because there are roughly three "
    "thousand counties in this country, and we are not going to write a "
    "custom script for each one.",
    "The tool uses a vision-based browser AI called Skyvern. Practically "
    "what that means is: instead of telling the computer <i>find the third "
    "input box on the page and type the parcel into it</i>, we tell the "
    "computer <i>look at this page like a human would, figure out whether "
    "you've landed on a search form, a results list, a bill detail, or a "
    "disclaimer, then take the next sensible step</i>. The same logic that "
    "works on a Florida county collector works on a Texas appraisal "
    "district works on a website built in 2003 that nobody has updated "
    "since. The tool classifies what it sees and follows the right path.",
    "When the page finally shows the bill, the tool extracts a small, "
    "well-defined set of facts — amount due, paid amount, payment date, "
    "receipt number, owner name. Nothing more. We deliberately keep this "
    "narrow because the more we ask the AI to interpret, the more it can "
    "get wrong. And before we accept any of those facts, the tool verifies "
    "the page actually belongs to the property we asked about. If the "
    "owner on the bill doesn't include the Pontus entity, or the address "
    "doesn't match, the row is flagged for review rather than written into "
    "the spreadsheet.",
    "There are a few absolute rules baked in. The tool is <b>strictly "
    "read-only</b> — it never adds anything to a cart, never enrolls in "
    "anything, never logs into a payment account, never even pretends to "
    "be eligible for something it is not. Pontus pays its bills; the tool "
    "only reads. And every value the tool writes back into the workbook "
    "carries a confidence marker, so an analyst can sort by confidence and "
    "spend their attention on the rows the tool is least sure about.",
]))
story.append(note_block(
    "If somebody asks <i>what does this cost to run</i>: the variable cost "
    "is the browser-automation provider (Skyvern), billed per browser step. "
    "A full eighty-row run costs on the order of a few dollars when it "
    "works end to end. Compare that to a week of analyst time."
))
story.append(PageBreak())

# ---------- 06 TENANT CREDIT — USER FLOW ----------
story += slide_header(
    "Slide 06  ·  Tenant Credit Tracker — the user flow",
    "PDFs in, two numbers per tenant out, with an audit trail.",
    "Three minutes. Same structure as slide 04, but for the other tool.",
)
story.append(do_block(
    "Navigate to the Tenant Credit Tracker section of the app. The upload "
    "screen takes both the tracker workbook and one or more PDFs."
))
story.append(say_block([
    "Same idea, different inputs. The analyst uploads two things — the "
    "tenant credit tracker workbook, and the tenant's quarterly income "
    "statement PDF. The tool figures out which tenant the PDF belongs to, "
    "looks up the recipe for that tenant, computes the two numbers that "
    "go into the tracker — Sales and EBITDA — and writes them into the "
    "right row of the workbook.",
    "What's important here is the audit trail. For every number the tool "
    "writes, you can click into it and see exactly which line items from "
    "the PDF were used, how they were added together, and how the tool "
    "got from <i>Net Income on page 3</i> to <i>EBITDA in cell G47</i>. "
    "If the answer ever looks wrong, the analyst can see the math. Nothing "
    "is hidden, nothing is magic.",
]))
story.append(do_block(
    "If a completed Tenant Credit run is available, open the audit drawer "
    "on one of the rows. The line-item breakdown is the moment people "
    "trust the tool — show it slowly."
))
story.append(say_block([
    "The output is, again, the same workbook the analyst uploaded — two "
    "cells filled in per tenant, in the right column for the right quarter, "
    "with the analyst's existing formatting preserved.",
]))
story.append(PageBreak())

# ---------- 07 TENANT CREDIT — UNDER THE HOOD ----------
story += slide_header(
    "Slide 07  ·  Tenant Credit Tracker — under the hood",
    "Why the math is right, every quarter, for every tenant.",
    "Two to three minutes.",
)
story.append(do_block(
    "Open one of the tenant config files if you want a visual aid — "
    "<b>lib/tenant-credit/tenant-configs/pinnacle.ts</b> is the canonical "
    "example. Otherwise stay on the audit drawer."
))
story.append(say_block([
    "The PDF reading is done by Claude, the same Anthropic model family "
    "we use elsewhere, with a structured output contract that guarantees "
    "the response is in a shape the rest of the tool can use. So we get "
    "a clean list of every line item on the income statement — label and "
    "amount, exactly as it appears.",
    "Then we apply the recipe. Every tenant has a small config file that "
    "says <i>for this tenant, Sales is these revenue lines summed; EBITDA "
    "starts from Net Income and adds back these specific items</i>. The "
    "config is the only thing that's different per tenant. The math engine "
    "itself is the same. Adding a new tenant is one new config file — no "
    "code changes, no deployment, no engineer required.",
    "If a required line item is missing from the PDF, the tool does not "
    "guess. It refuses to write a number and flags the row for human "
    "review with a clear explanation of what was missing. That refusal is "
    "the most important behaviour in the whole tool. The risk we are "
    "managing is not <i>the tool runs slowly</i>; it's <i>the tool puts "
    "the wrong number in a credit memo</i>. Wrong numbers are dangerous; "
    "a flagged row that an analyst handles in ten seconds is fine.",
]))
story.append(PageBreak())

# ---------- 08 WHAT TIES THEM TOGETHER ----------
story += slide_header(
    "Slide 08  ·  What ties them together",
    "One philosophy — never invent, always show your work.",
    "Two minutes. This is where you make the case for a category, "
    "not just two one-off tools.",
)
story.append(do_block(
    "Camera back on, sharing optional. If you've been sharing for ten "
    "minutes, this is a good moment to stop and reconnect with the audience."
))
story.append(say_block([
    "The two tools look different on the outside but they are built on the "
    "same five rules, and I think those rules are the case for doing more "
    "of this kind of internal tooling at Pontus.",
    "<b>One — the spreadsheet is the contract.</b> Inputs and outputs are "
    "the workbooks the analyst already uses. No new systems to learn.",
    "<b>Two — never invent data.</b> If the tool can't find something or "
    "isn't sure, it says so. It writes a confidence marker and a notes "
    "sentence rather than a fake answer. A flagged row is acceptable; a "
    "wrong number is not.",
    "<b>Three — always show your work.</b> Every number the tool writes "
    "comes with a trail — for tax, the portal it visited and what it saw; "
    "for tenant credit, the line items it summed and the recipe it used. "
    "An analyst can always audit the answer.",
    "<b>Four — read-only by default.</b> These tools touch external "
    "systems but they never spend money, never enroll us in anything, "
    "never modify the source data. Humans still pay the bills and approve "
    "the credit memos. The tool just removes the typing.",
    "<b>Five — resumable.</b> If a run dies halfway through, it picks up "
    "where it left off. The analyst doesn't lose work, and we don't waste "
    "money re-doing things that already succeeded.",
    "Those five rules together are what makes this safe to put in front of "
    "the team. And once we have one tool that follows them, the next one "
    "is easier — because the dashboard, the upload flow, the run "
    "infrastructure, the audit format, all of it carries over.",
]))
story.append(PageBreak())

# ---------- 09 WHERE THIS IS GOING ----------
story += slide_header(
    "Slide 09  ·  Where this is going",
    "The longer-term plan for internal tooling at Pontus.",
    "Two minutes. End on direction, not status.",
)
story.append(do_block(
    "Stay on camera. A roadmap slide on screen is fine if you have one — "
    "otherwise the words carry it."
))
story.append(say_block([
    "Both of these tools are step one of a bigger picture, and I want to "
    "name that explicitly so you know where we're headed.",
    "<b>Near term — make the existing tools boring.</b> Run them every "
    "quarter without anyone thinking about it. Get the analysts who use "
    "them to trust the confidence markers enough that they don't double-"
    "check the high-confidence rows. That's the win.",
    "<b>Middle term — coverage.</b> Every workbook that currently lives in "
    "a shared drive and gets updated by a human copy-pasting from "
    "somewhere is a candidate. Lease tracking, vendor follow-ups, payment "
    "confirmations from banks, anything where the data exists in a portal "
    "or a PDF and ends up typed into a spreadsheet by a person.",
    "<b>Longer term — the workbook becomes a view.</b> Once the tools are "
    "trusted, the underlying data — properties, tenants, payments, "
    "balances — lives in a real database that we maintain. The spreadsheet "
    "becomes a report against that database, not the source of truth. At "
    "that point, asking <i>what's our total tax exposure across the "
    "Florida portfolio</i> is a query, not a phone call.",
    "But we get there one tool at a time. Property Tax Checker first. "
    "Tenant Credit Tracker right behind it. Each one earns the right to "
    "the next one.",
]))
story.append(PageBreak())

# ---------- 10 Q&A ----------
story += slide_header(
    "Slide 10  ·  Q&A and prepared answers",
    "Including the <i>why is it red right now</i> question.",
    "Have these answers in your back pocket. Don't volunteer them — wait "
    "for the question.",
)

# Q&A as a table of prepared answers
qa = [
    (
        "Why is the dashboard showing every row as Unreachable today?",
        "Honest answer: the browser-automation service we use, Skyvern, is "
        "out of monthly credits. Every request is being rejected by their "
        "API before any portal is even visited — the rows come back as "
        "Unreachable because the tool correctly reports it couldn't reach "
        "anything. The fix is on the billing side — either enabling overage "
        "or upgrading the plan — not on our code side. I'm also patching "
        "the tool to fail-fast when this happens so it stops burning a full "
        "run and surfaces <i>credits exhausted</i> as the top-level reason.",
    ),
    (
        "What happens if a county changes their portal?",
        "Most changes are absorbed automatically because the tool uses "
        "vision to navigate, not hard-coded selectors. If a layout change "
        "actually breaks something, the affected rows fall into "
        "<i>Needs review</i> rather than producing wrong numbers, and we "
        "see the failure pattern in the dashboard before any bad data "
        "lands in a spreadsheet.",
    ),
    (
        "Could the tool ever pay a bill by mistake?",
        "No. The tool is hard-coded to refuse any action that would commit "
        "money, enroll us in a program, or modify portal state. That's not "
        "a configuration setting, it's enforced in code. The only thing it "
        "can do on a portal is read.",
    ),
    (
        "How do we know the numbers are right?",
        "Every row carries a confidence marker — High, Medium, or Low. "
        "High means the tool verified the property's owner and account "
        "match, found the bill, and read the numbers from a clear payment "
        "section. Low rows don't get written into the data columns at all "
        "— they go to Needs Review with an explanation. Analysts should "
        "spot-check High rows occasionally and always review the Low ones.",
    ),
    (
        "How long does a full run take?",
        "On a healthy day, an eighty-row tax run finishes in roughly twenty "
        "to forty minutes depending on how many of the portals are slow. "
        "An analyst doing it by hand is a multi-day job. The tenant credit "
        "side is much faster because PDFs read in seconds.",
    ),
    (
        "Who can use this?",
        "Right now anyone with the URL can — there's no login wall, by "
        "design, so the team isn't blocked. Locking it down to Pontus "
        "Google accounts is a one-day piece of work once we want it.",
    ),
    (
        "What's the failure mode I should worry about?",
        "The one I'm most careful about is silent wrong answers — the tool "
        "writes a number that looks right but came from the wrong property. "
        "Everything in the verification layer is built around preventing "
        "that. The visible failure mode — a row flagged Needs Review — is "
        "the safe failure mode and we have plenty of those.",
    ),
    (
        "What's it built on?",
        "Next.js on Vercel for the web app, Firebase for the database and "
        "file storage, a Python worker on Google Cloud Run for the long-"
        "running scrapes, Skyvern for the actual browser automation, and "
        "Claude for reading the PDFs and adjudicating tricky matches. "
        "Standard, off-the-shelf pieces — nothing exotic.",
    ),
]

for q, a in qa:
    block = KeepTogether([
        Paragraph(
            f"<b>Q.</b> {q}",
            ParagraphStyle("Q", parent=BODY, fontName="Helvetica-Bold",
                           fontSize=11, leading=15, textColor=INK,
                           spaceAfter=2),
        ),
        Paragraph(
            f"<b><font color='#15803d'>A.</font></b> {a}",
            ParagraphStyle("A", parent=BODY, fontSize=11, leading=15,
                           textColor=INK, leftIndent=14, spaceAfter=10),
        ),
    ])
    story.append(block)

story.append(Spacer(1, 0.1 * inch))
story.append(note_block(
    "If a question lands that you don't have an answer for, the right "
    "move is <i>I want to give you a real answer instead of guessing — "
    "let me check and follow up today.</i> That's a more credible answer "
    "than improvising. Then actually follow up the same day."
))
story.append(PageBreak())

# ---------- CLOSING / CHECKLIST ----------
story += slide_header(
    "Pre-call checklist",
    "Five minutes before you dial in.",
    "Run through this list. If any item is a problem, the call still goes "
    "ahead, but you know what to skip.",
)

checklist = [
    "Both demo URLs open in two separate tabs (Tax Checker, Tenant Credit Tracker).",
    "PTAX_Master_Final.xlsx is open in Excel and scrolled to the data rows.",
    "At least one finished tax run is visible in the runs list, so you can "
    "show the downloaded workbook even though new runs are paused.",
    "If a recording URL from a past Skyvern run is reachable, have that tab "
    "ready too — watching the browser navigate live is the strongest visual "
    "in the whole talk.",
    "This script is open in a separate window or on a second screen.",
    "Camera framing is good and you're not backlit.",
    "You've read slide 10 (Q&amp;A) once just now — those answers should "
    "come out without you reading them.",
    "You know the one-line explanation for the credit pause and you're "
    "okay being asked about it.",
]
rows = []
for item in checklist:
    rows.append([
        Paragraph(
            "<font color='#15803d'><b>☐</b></font>",
            ParagraphStyle("Chk", parent=BODY, fontSize=14, leading=18,
                           fontName="Helvetica-Bold"),
        ),
        Paragraph(
            item,
            ParagraphStyle("ChkT", parent=BODY, fontSize=11, leading=15),
        ),
    ])
ck = Table(rows, colWidths=[0.4 * inch, PAGE_W - 2 * MARGIN - 0.4 * inch])
ck.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
]))
story.append(ck)

story.append(Spacer(1, 0.25 * inch))
story.append(Paragraph(
    "<b>Closing line (read verbatim if you like it):</b>",
    ParagraphStyle("CloseH", parent=BODY, fontName="Helvetica-Bold",
                   fontSize=12, leading=15, textColor=INK, spaceAfter=4),
))
story.append(say_block([
    "Thanks for the time. To recap: these two tools take work that today "
    "consumes an analyst's afternoon and turn it into an upload and a "
    "download. They never invent numbers, they always show their work, and "
    "they're safe to put in front of the team. If anyone on this call has "
    "a workbook that gets updated by hand every quarter, send it to me — "
    "that's probably the next tool.",
]))


# ----------------------------------------------------------------------
# Document
# ----------------------------------------------------------------------

doc = BaseDocTemplate(
    OUT,
    pagesize=LETTER,
    leftMargin=MARGIN, rightMargin=MARGIN,
    topMargin=0.75 * inch, bottomMargin=0.7 * inch,
    title="Pontus Tools — Call Script",
    author="Nicholas Revenco, Pontus Capital",
)

cover_frame = Frame(
    MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN,
    id="cover", showBoundary=0,
)
content_frame = Frame(
    MARGIN, 0.7 * inch,
    PAGE_W - 2 * MARGIN, PAGE_H - 1.45 * inch,
    id="content", showBoundary=0,
)
doc.addPageTemplates([
    PageTemplate(id="Cover", frames=[cover_frame], onPage=cover_chrome),
    PageTemplate(id="Content", frames=[content_frame], onPage=page_chrome),
])

from reportlab.platypus import NextPageTemplate
story.insert(0, NextPageTemplate("Cover"))
for i, item in enumerate(story):
    if isinstance(item, PageBreak):
        story.insert(i, NextPageTemplate("Content"))
        break

doc.build(story)
print(f"Wrote {OUT}")
