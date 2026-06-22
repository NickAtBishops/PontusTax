"""Pontus Property Tax Checker — High-level overview report.

Portrait letter, 10+ pages. Concept-first. No source code. Explains how the
pieces relate to each other, what each one does in plain language, and why
the system was built this way.
"""

from __future__ import annotations

from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_LEFT, TA_JUSTIFY, TA_CENTER
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    KeepTogether,
)

OUT = (
    "/Users/nicholasrevencomacbookair/Desktop/Pontus Capital/"
    "Pontus Projects/New Tax Project/"
    "Pontus_Tax_Checker_Overview_Report.pdf"
)

# Palette
INK = HexColor("#0a0a0a")
MUTED = HexColor("#525252")
SUBTLE = HexColor("#737373")
LINE = HexColor("#e5e5e5")
LINE_SOFT = HexColor("#f1f5f9")
ACCENT = HexColor("#2563eb")
ACCENT_SOFT = HexColor("#eff6ff")
ACCENT_BORDER = HexColor("#bfdbfe")
GREEN = HexColor("#15803d")
GREEN_SOFT = HexColor("#dcfce7")
AMBER = HexColor("#b45309")
AMBER_SOFT = HexColor("#fef3c7")
NEUTRAL_BG = HexColor("#fafafa")
ARROW = HexColor("#94a3b8")

PAGE_W, PAGE_H = LETTER
MARGIN = 0.85 * inch
CONTENT_W = PAGE_W - 2 * MARGIN

styles = getSampleStyleSheet()

# --- Typography ---
H1 = ParagraphStyle(
    "H1", parent=styles["Heading1"], fontName="Helvetica-Bold",
    fontSize=22, leading=26, textColor=INK,
    spaceBefore=8, spaceAfter=10,
)
H2 = ParagraphStyle(
    "H2", parent=styles["Heading2"], fontName="Helvetica-Bold",
    fontSize=14, leading=18, textColor=INK,
    spaceBefore=14, spaceAfter=6,
)
H3 = ParagraphStyle(
    "H3", parent=styles["Heading3"], fontName="Helvetica-Bold",
    fontSize=11.5, leading=15, textColor=ACCENT,
    spaceBefore=10, spaceAfter=4,
)
EYEBROW = ParagraphStyle(
    "Eyebrow", parent=styles["Normal"], fontName="Helvetica-Bold",
    fontSize=8.5, leading=11, textColor=ACCENT, spaceAfter=4,
)
BODY = ParagraphStyle(
    "Body", parent=styles["Normal"], fontName="Helvetica",
    fontSize=11, leading=16, textColor=INK,
    spaceAfter=10, alignment=TA_JUSTIFY,
)
BODY_LEFT = ParagraphStyle(
    "BodyLeft", parent=BODY, alignment=TA_LEFT,
)
LEAD = ParagraphStyle(
    "Lead", parent=BODY, fontSize=12.5, leading=18, spaceAfter=12,
    alignment=TA_LEFT,
)
BULLET = ParagraphStyle(
    "Bullet", parent=BODY_LEFT, leftIndent=18, bulletIndent=4,
    spaceAfter=6,
)
SMALL = ParagraphStyle(
    "Small", parent=styles["Normal"], fontName="Helvetica",
    fontSize=8.5, leading=11, textColor=MUTED, alignment=TA_LEFT,
)
CAPTION = ParagraphStyle(
    "Caption", parent=SMALL, fontName="Helvetica-Oblique",
    alignment=TA_CENTER, spaceBefore=4,
)
COVER_TITLE = ParagraphStyle(
    "CT", parent=styles["Title"], fontName="Helvetica-Bold",
    fontSize=36, leading=40, textColor=INK, alignment=TA_LEFT, spaceAfter=8,
)
COVER_SUB = ParagraphStyle(
    "CS", parent=BODY, fontSize=14, leading=20, textColor=MUTED,
    alignment=TA_LEFT, spaceAfter=4,
)


# --- Building blocks ---

def bullets(items):
    return [Paragraph(f"•&nbsp;&nbsp;{it}", BULLET) for it in items]


def box(label, color, bg, border, width, height_padding=10,
        font_size=10.5, sub=None):
    """A labeled box for diagram layouts."""
    inner = [Paragraph(
        f"<b>{label}</b>",
        ParagraphStyle("BL", parent=BODY_LEFT, fontSize=font_size,
                       textColor=color, alignment=TA_CENTER, leading=14,
                       fontName="Helvetica-Bold", spaceAfter=0))]
    if sub:
        inner.append(Paragraph(
            sub,
            ParagraphStyle("BLS", parent=BODY_LEFT, fontSize=8.5,
                           textColor=MUTED, alignment=TA_CENTER, leading=11,
                           spaceBefore=2)))
    t = Table([[inner]], colWidths=[width])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.7, border),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), height_padding),
        ("BOTTOMPADDING", (0, 0), (-1, -1), height_padding),
    ]))
    return t


def arrow(direction="→", w=0.4 * inch):
    return Paragraph(
        f"<font color='#94a3b8' size='14'><b>{direction}</b></font>",
        ParagraphStyle("A", parent=BODY_LEFT, alignment=TA_CENTER,
                       fontSize=14, leading=14))


def callout(title, body_paragraphs, color, bg, border):
    inner = [Paragraph(
        f"<b>{title}</b>",
        ParagraphStyle("CT", parent=BODY_LEFT, fontSize=10.5, leading=13,
                       textColor=color, fontName="Helvetica-Bold",
                       spaceAfter=4)
    )]
    for p in body_paragraphs:
        inner.append(p)
    t = Table([[inner]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("LINEBEFORE", (0, 0), (-1, -1), 3, border),
    ]))
    return KeepTogether(t)


# --- Page chrome ---

def cover_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(ACCENT)
    canvas.rect(0, 0, 0.22 * inch, PAGE_H, fill=1, stroke=0)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.setFillColor(ACCENT)
    canvas.drawString(MARGIN, PAGE_H - 0.75 * inch,
                      "PONTUS  ·  INTERNAL OVERVIEW")
    canvas.setFont("Helvetica", 8.5)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 0.75 * inch,
                           "June 2026")
    canvas.restoreState()


def chrome(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.3)
    canvas.line(MARGIN, PAGE_H - 0.55 * inch,
                PAGE_W - MARGIN, PAGE_H - 0.55 * inch)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.setFillColor(ACCENT)
    canvas.drawString(MARGIN, PAGE_H - 0.42 * inch,
                      "PONTUS PROPERTY TAX CHECKER  ·  HOW IT WORKS")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 0.42 * inch,
                           "Internal — June 2026")

    canvas.setStrokeColor(LINE)
    canvas.line(MARGIN, 0.6 * inch, PAGE_W - MARGIN, 0.6 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, 0.42 * inch,
                      "Excel in  →  AI portal lookup  →  Excel out")
    canvas.drawRightString(PAGE_W - MARGIN, 0.42 * inch,
                           f"Page {doc.page - 1}")
    canvas.restoreState()


# ======================================================================
# CONTENT
# ======================================================================

story = []

# ------------------ COVER ------------------
story.append(Spacer(1, 1.8 * inch))
story.append(Paragraph("How the Property", COVER_TITLE))
story.append(Paragraph("Tax Checker Works", ParagraphStyle(
    "CT2", parent=COVER_TITLE, textColor=ACCENT)))
story.append(Spacer(1, 0.15 * inch))
story.append(Paragraph(
    "A guided tour of every moving part — the upload, the queue, the AI "
    "that drives the browser, the database that keeps score, and the "
    "Excel file that comes back answered. Written without source code: "
    "the goal is for any reader to come away knowing what each piece "
    "is, who talks to whom, and why the system was built this way.",
    COVER_SUB))
story.append(Spacer(1, 0.6 * inch))

cover_meta = Table([
    [Paragraph("<b>Author</b>", BODY_LEFT),
     Paragraph("Nicholas Revenco", BODY_LEFT)],
    [Paragraph("<b>Audience</b>", BODY_LEFT),
     Paragraph("Anyone who wants to understand the system — engineers "
               "and non-engineers alike. No coding background assumed.",
               BODY_LEFT)],
    [Paragraph("<b>Status</b>", BODY_LEFT),
     Paragraph("Production — first full pipeline shipped June 2026",
               BODY_LEFT)],
    [Paragraph("<b>How to read</b>", BODY_LEFT),
     Paragraph("Linear, front to back. Each section builds on the "
               "ones before it.", BODY_LEFT)],
], colWidths=[1.3 * inch, 5.0 * inch])
cover_meta.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
]))
story.append(cover_meta)
story.append(PageBreak())

# ------------------ TOC ------------------
story.append(Paragraph("Contents", H1))
story.append(Paragraph(
    "This report is twelve sections. The first three explain the problem "
    "and introduce the cast. The middle six follow a single upload "
    "through the system. The last three step back to talk about safety, "
    "cost, and the trade-offs.",
    BODY))

toc_items = [
    ("1", "The one-paragraph version",
     "If you read nothing else"),
    ("2", "Why this exists",
     "The problem the system solves"),
    ("3", "The cast of characters",
     "What each piece is, in plain language"),
    ("4", "The upload — what happens in the first 10 seconds",
     "From clicking the button to a queued run"),
    ("5", "The queue — how the work waits its turn",
     "What 'queued' means here, and why it matters"),
    ("6", "The worker wakes up",
     "How the Python engine picks up a run"),
    ("7", "The AI driving the browser",
     "How Skyvern reads a portal like a person would"),
    ("8", "Verification & validation",
     "The safety net before anything gets written"),
    ("9", "The Excel file comes back",
     "Write-back and download"),
    ("10", "What happens when things go wrong",
     "Cancels, crashes, retries, blocked portals"),
    ("11", "What it costs to run",
     "Per-property economics + fixed infrastructure"),
    ("12", "Why this stack, not another",
     "The design choices and what they bought us"),
]
toc_rows = []
for n, t, d in toc_items:
    toc_rows.append([
        Paragraph(f"<font color='#2563eb'><b>{n}</b></font>",
                  ParagraphStyle("TN", parent=BODY_LEFT,
                                 fontName="Helvetica-Bold",
                                 fontSize=12, leading=15)),
        Paragraph(f"<b>{t}</b><br/>"
                  f"<font color='#525252'>{d}</font>",
                  ParagraphStyle("TT", parent=BODY_LEFT, fontSize=11,
                                 leading=14)),
    ])
toc = Table(toc_rows, colWidths=[0.4 * inch, 6.2 * inch])
toc.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ("TOPPADDING", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
]))
story.append(toc)
story.append(PageBreak())

# ============== §1 ONE-PARAGRAPH ==============
story.append(Paragraph("1. The one-paragraph version", H1))
story.append(Paragraph(
    "The Property Tax Checker takes an Excel spreadsheet of properties "
    "Pontus owns, looks up each property's current tax status on "
    "whichever county website handles that property, and gives the "
    "spreadsheet back with the answers filled in. The tricky part is "
    "that every county runs its own website, no two look alike, and "
    "Pontus owns property in fifteen-plus states. The system handles "
    "that by using an AI that <b>looks at a webpage the way a person "
    "would</b> instead of being hard-coded for each site. A web "
    "dashboard accepts the upload, a database keeps track of which "
    "rows have been done, a background worker drives the AI through "
    "each portal one row at a time, and the same Excel file — "
    "preserving every formula and bit of formatting — comes back out "
    "the other end. That's it. The rest of this document is just "
    "<i>how</i>.",
    LEAD))

story.append(Paragraph("The single picture you should hold in your head", H2))
story.append(Paragraph(
    "Three boxes, two arrows, and a loop:",
    BODY))

# Big top-level diagram
row = Table([[
    box("EXCEL FILE", ACCENT, ACCENT_SOFT, ACCENT_BORDER,
        1.6 * inch, height_padding=18, font_size=12,
        sub="What the user has at the start"),
    arrow("→"),
    box("THE SYSTEM", INK, NEUTRAL_BG, LINE,
        2.6 * inch, height_padding=18, font_size=12,
        sub="Dashboard + queue + worker + AI"),
    arrow("→"),
    box("EXCEL FILE", ACCENT, ACCENT_SOFT, ACCENT_BORDER,
        1.6 * inch, height_padding=18, font_size=12,
        sub="Same file, with answers"),
]], colWidths=[1.6 * inch, 0.4 * inch, 2.6 * inch, 0.4 * inch,
               1.6 * inch])
row.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
]))
story.append(row)
story.append(Paragraph(
    "The middle box is what this report unpacks.",
    CAPTION))
story.append(Spacer(1, 0.15 * inch))

story.append(callout(
    "What we deliberately are NOT doing",
    [Paragraph(
        "We are not building a database of property-tax history. We are "
        "not paying any bills. We are not sending alerts. We are not "
        "logging into anyone's account. The job is read-only and "
        "single-purpose: <b>find out what's owed right now, write it "
        "back to the spreadsheet</b>. Everything else is out of scope on "
        "purpose. That focus is what makes the system reliable.",
        ParagraphStyle("CB", parent=BODY_LEFT, fontSize=10.5,
                       leading=14))],
    AMBER, AMBER_SOFT, HexColor("#fbbf24")))

story.append(PageBreak())

# ============== §2 WHY ==============
story.append(Paragraph("2. Why this exists", H1))
story.append(Paragraph(
    "Pontus owns real estate across more than fifteen U.S. states. Each "
    "property has a property-tax bill that has to be tracked. Bills "
    "come from a different government office in every county — and "
    "every county runs its own website to show those bills. Some of "
    "those websites are modern; many are not. They use different "
    "search boxes, different login flows, different ways to display "
    "whether a bill is paid.",
    BODY))
story.append(Paragraph(
    "An analyst doing this work by hand has to:",
    BODY))
story.extend(bullets([
    "Open the spreadsheet, find a row.",
    "Open the county's website.",
    "Type or paste the account number into a search box.",
    "Click through to the property's record.",
    "Read the balance (and double-check it's the right property).",
    "Type the answer back into the spreadsheet.",
    "Move to the next row. Repeat.",
]))
story.append(Paragraph(
    "For one property, this is maybe two minutes. For a hundred "
    "properties spread across thirteen counties, this is the better "
    "part of an afternoon — and it has to happen every month, because "
    "the moment the spreadsheet is saved a new bill could be posted "
    "or a payment could clear. The data ages fast.",
    BODY))

story.append(Paragraph(
    "Worse: the same spreadsheet lookup happens for every Pontus "
    "portfolio. Multiply by the firm's full footprint and the work is "
    "no longer humanly sustainable. That's the problem this system "
    "exists to solve.",
    BODY))

story.append(Paragraph("Three things made this hard", H2))
hard_table = [
    [Paragraph("<b>1.  No two portals look alike.</b>", BODY_LEFT),
     Paragraph("There are at least eight different vendors building "
               "these government websites — Grant Street, Aumentum, "
               "Tyler, Pacific Blue, and so on. Each has its own "
               "layout. A custom scraper for one doesn't help with the "
               "next one.", BODY_LEFT)],
    [Paragraph("<b>2.  The work scales weirdly.</b>", BODY_LEFT),
     Paragraph("It's not big-data — we're talking dozens of rows per "
               "upload, not millions. But each row needs an actual "
               "browser to fetch the answer, so we can't just hit an "
               "API in a tight loop. The bottleneck is the portal "
               "being polite to.", BODY_LEFT)],
    [Paragraph("<b>3.  The answer can't be wrong.</b>", BODY_LEFT),
     Paragraph("If the system writes 'paid' when a property is "
               "actually delinquent, Pontus eats a late fee. Every "
               "answer has to be verified, and the verification has to "
               "work even when county data entry is messy.",
               BODY_LEFT)],
]
ht = Table(hard_table, colWidths=[2.2 * inch, 4.4 * inch])
ht.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 10),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
]))
story.append(ht)

story.append(PageBreak())

# ============== §3 THE CAST ==============
story.append(Paragraph("3. The cast of characters", H1))
story.append(Paragraph(
    "Seven distinct components share the work. Think of them like "
    "people in a small office, each with one job, who hand things to "
    "each other in a predictable order.",
    BODY))

cast = [
    ("The Dashboard",
     "The website the user opens. Lives at a Vercel URL. Shows the "
     "upload button, the list of runs, the progress of each one, and "
     "the Download button when a run finishes. It does no processing "
     "itself — it's the storefront."),
    ("The API",
     "A thin layer that sits behind the dashboard. When the user "
     "uploads a file, the API takes it, puts it in storage, records "
     "the run in the database, and tells the worker to start. When "
     "the user clicks cancel or download, the API handles that too. "
     "Also lives on Vercel. Think of it as the receptionist."),
    ("The Database",
     "Firestore (part of Firebase). Holds three things: the list of "
     "runs and their status, one record per property row with its "
     "answer, and a library of what we know about each portal vendor. "
     "Every component talks to the database to find out what's going "
     "on."),
    ("The File Store",
     "Cloud Storage (also part of Firebase). Holds the original "
     "uploaded Excel file and, when the run is done, the answered "
     "version. The database tells everyone where to find the file; "
     "the file store actually holds the bytes."),
    ("The Worker",
     "A Python program that runs in the background on Google Cloud "
     "Run. It's the engine — it does the actual work of parsing the "
     "Excel file, walking through each row, driving the AI, verifying "
     "the answers, and writing the result back. It is the only "
     "component that ever runs for a long time."),
    ("Skyvern — the Browser AI",
     "An outside service we pay for. It runs a real Chrome browser "
     "in its cloud and uses a vision model to navigate webpages. We "
     "send it a URL and a description of what we want; it returns "
     "structured data. This is the piece that handles the part where "
     "'every portal looks different.'"),
    ("Claude — the Tie-Breaker (optional)",
     "Anthropic's language model. The worker only calls it when the "
     "deterministic owner/address matching can't decide whether the "
     "page we read is the right property. Claude looks at the row "
     "and the page side-by-side and gives a yes/no verdict."),
]

cast_rows = []
for i, (name, desc) in enumerate(cast, 1):
    cast_rows.append([
        Paragraph(f"<font color='#2563eb'><b>{i}</b></font>",
                  ParagraphStyle("CN", parent=BODY_LEFT,
                                 fontName="Helvetica-Bold",
                                 fontSize=14, leading=18)),
        Paragraph(f"<b>{name}</b>",
                  ParagraphStyle("CHd", parent=BODY_LEFT,
                                 fontName="Helvetica-Bold",
                                 fontSize=11.5, leading=14,
                                 textColor=INK)),
        Paragraph(desc, ParagraphStyle("CD", parent=BODY_LEFT,
                                       fontSize=10.5, leading=14)),
    ])
ct = Table(cast_rows, colWidths=[0.35 * inch, 1.6 * inch, 4.65 * inch])
ct.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 10),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
]))
story.append(ct)

story.append(PageBreak())

# ============== §3b Wiring diagram ==============
story.append(Paragraph("How they're wired", H2))
story.append(Paragraph(
    "Here's who talks to whom. Solid arrows mean direct calls; the "
    "database is the shared blackboard nearly everyone reads from and "
    "writes to.",
    BODY))

story.append(Spacer(1, 0.15 * inch))

# Build a wiring diagram with three columns: client, middle, services
diag_w = CONTENT_W
col_w = diag_w / 5

# Row 1: Dashboard / API / Worker / Skyvern / Browser-on-portal
def diag_box(label, sub, color, bg, border, w=1.3 * inch, h=14):
    inner = [Paragraph(
        f"<b>{label}</b>",
        ParagraphStyle("DB", parent=BODY_LEFT, fontSize=10.5,
                       fontName="Helvetica-Bold", textColor=color,
                       alignment=TA_CENTER, leading=13))]
    inner.append(Paragraph(
        sub, ParagraphStyle("DBS", parent=BODY_LEFT, fontSize=8,
                            textColor=MUTED, alignment=TA_CENTER,
                            leading=10, spaceBefore=2)))
    t = Table([[inner]], colWidths=[w])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.7, border),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), h),
        ("BOTTOMPADDING", (0, 0), (-1, -1), h),
    ]))
    return t


row1 = Table([[
    diag_box("Dashboard", "what the user sees", ACCENT, ACCENT_SOFT,
             ACCENT_BORDER, 1.25 * inch),
    arrow("→"),
    diag_box("API", "the receptionist", ACCENT, ACCENT_SOFT,
             ACCENT_BORDER, 1.1 * inch),
    arrow("→"),
    diag_box("Worker", "the engine", INK, NEUTRAL_BG, LINE,
             1.3 * inch),
    arrow("→"),
    diag_box("Skyvern", "browser AI", GREEN, GREEN_SOFT,
             HexColor("#86efac"), 1.1 * inch),
]], colWidths=[1.25 * inch, 0.25 * inch, 1.1 * inch, 0.25 * inch,
               1.3 * inch, 0.25 * inch, 1.1 * inch])
row1.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
]))
story.append(row1)
story.append(Spacer(1, 0.1 * inch))

# Down arrows from each
story.append(Table([[
    arrow("↓"), Paragraph("", BODY), arrow("↓"),
    Paragraph("", BODY), arrow("↓"), Paragraph("", BODY),
    arrow("↓"),
]], colWidths=[1.25 * inch, 0.25 * inch, 1.1 * inch, 0.25 * inch,
               1.3 * inch, 0.25 * inch, 1.1 * inch]))

# Database row
db_box = diag_box(
    "DATABASE  (Firestore)",
    "Everyone reads and writes here — it's the shared blackboard. "
    "Holds run status, per-row answers, the vendor playbook library.",
    ACCENT, ACCENT_SOFT, ACCENT_BORDER,
    w=CONTENT_W - 0.2 * inch, h=14)
db_table = Table([[db_box]], colWidths=[CONTENT_W])
db_table.setStyle(TableStyle([
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
]))
story.append(db_table)

story.append(Spacer(1, 0.1 * inch))
# arrows down to file store + portal
story.append(Table([[
    Paragraph("", BODY), arrow("↓"), Paragraph("", BODY),
    Paragraph(""), arrow("↓"), Paragraph(""),
]], colWidths=[1.3 * inch, 1.5 * inch, 0.5 * inch,
               1.0 * inch, 1.5 * inch, 0.9 * inch]))

# bottom row
bot = Table([[
    Paragraph(""),
    diag_box("File Store", "uploaded + answered .xlsx files",
             ACCENT, ACCENT_SOFT, ACCENT_BORDER, 1.6 * inch),
    Paragraph(""),
    diag_box("County Portal", "the website Skyvern actually drives",
             GREEN, GREEN_SOFT, HexColor("#86efac"), 1.8 * inch),
    Paragraph(""),
]], colWidths=[0.8 * inch, 1.6 * inch, 1.2 * inch, 1.8 * inch,
               1.3 * inch])
bot.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
]))
story.append(bot)

story.append(Spacer(1, 0.1 * inch))
story.append(Paragraph(
    "The Dashboard talks only to the API. The API saves files in the "
    "File Store, records the run in the Database, and asks the Worker "
    "to start. The Worker is the only thing that talks to Skyvern. "
    "Skyvern is the only thing that talks to a county portal — Pontus "
    "code never touches the portal directly.",
    CAPTION))

story.append(PageBreak())

# ============== §4 UPLOAD ==============
story.append(Paragraph("4. The upload — the first 10 seconds", H1))
story.append(Paragraph(
    "Imagine an analyst, Excel file in hand, opening the dashboard. "
    "Here's exactly what happens between clicking the upload button "
    "and seeing the run start.",
    BODY))

up_steps = [
    ("The user drops the file and clicks Start.",
     "The browser packages the file and sends it to the API. The "
     "dashboard does no processing — it's just a polite messenger."),
    ("The API checks the file.",
     "Is it really an Excel file (.xlsx)? Is it under 4 MB? (Real "
     "trackers are well under 1 MB, so anything bigger is probably a "
     "mistake.) If yes, accept it; if no, return an error message."),
    ("The API hands the file to the File Store.",
     "Cloud Storage holds the bytes. The file gets a unique path "
     "based on a new run ID — that path is the address the worker "
     "will look up later."),
    ("The API creates a 'run' record in the Database.",
     "A new entry in the runs collection. Status: <b>queued</b>. "
     "The record knows the file's name, where it lives in the File "
     "Store, when it was created, and that it has not been processed "
     "yet. All counters (paid / unpaid / delinquent / needs review) "
     "start at zero."),
    ("The API pokes the Worker.",
     "It sends a quick message to Google Cloud Run: 'wake up your "
     "worker job.' The message has no payload — the API doesn't say "
     "which run. The Worker will figure that out on its own."),
    ("The user's screen updates.",
     "The dashboard, which has been listening to the runs collection "
     "in the Database, sees the new entry appear and shows it. "
     "Within a few seconds, the status will flip from 'queued' to "
     "'running' as the worker picks it up."),
]
up_rows = []
for i, (head, body) in enumerate(up_steps, 1):
    up_rows.append([
        Paragraph(f"<font color='#2563eb'><b>{i}</b></font>",
                  ParagraphStyle("UN", parent=BODY_LEFT,
                                 fontName="Helvetica-Bold",
                                 fontSize=13, leading=16)),
        Paragraph(f"<b>{head}</b><br/>"
                  f"<font color='#374151'>{body}</font>",
                  ParagraphStyle("UB", parent=BODY_LEFT,
                                 fontSize=10.5, leading=14)),
    ])
ut = Table(up_rows, colWidths=[0.4 * inch, 6.2 * inch])
ut.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
]))
story.append(ut)

story.append(callout(
    "Why doesn't the API tell the Worker which run to do?",
    [Paragraph(
        "Because then we'd have to make sure the message is delivered "
        "reliably, that no run gets started twice, that no run gets "
        "lost. Instead, the API just says 'wake up.' When the Worker "
        "wakes up, it asks the Database 'what's the oldest run that "
        "needs doing?' and grabs it. If two pokes arrive at once, the "
        "Worker only handles one at a time anyway, so nothing "
        "duplicates. The Database becomes the single source of truth "
        "for what needs doing — and a much simpler thing to reason "
        "about.",
        ParagraphStyle("WB", parent=BODY_LEFT, fontSize=10.5,
                       leading=14))],
    ACCENT, ACCENT_SOFT, ACCENT_BORDER))

story.append(PageBreak())

# ============== §5 QUEUE ==============
story.append(Paragraph("5. The queue — how the work waits its turn", H1))
story.append(Paragraph(
    "The word 'queued' is doing a lot of work in this system. Let's "
    "unpack it.",
    LEAD))
story.append(Paragraph(
    "A queue is just a line. Runs that haven't been processed yet sit "
    "in the line in the order they arrived. The Worker takes one off "
    "the front of the line, finishes it, then takes the next one. If "
    "the line is empty, the Worker stops; if a new run shows up, the "
    "next worker invocation picks it up.",
    BODY))

story.append(Paragraph("Where the queue actually lives", H2))
story.append(Paragraph(
    "There is no separate queue server. The 'queue' is just the "
    "collection of run records in the Database whose status is "
    "'queued'. When the Worker wakes up, it runs a query: 'find me "
    "the oldest run with status equal to queued.' It then atomically "
    "flips that run's status from 'queued' to 'running' in the same "
    "operation — so even if two workers ever happened to query at the "
    "exact same instant, only one could win.",
    BODY))

# Queue visualization
qrow = Table([[
    box("Run A", ACCENT, ACCENT_SOFT, ACCENT_BORDER, 0.9 * inch,
        height_padding=10, font_size=9.5, sub="queued"),
    box("Run B", ACCENT, ACCENT_SOFT, ACCENT_BORDER, 0.9 * inch,
        height_padding=10, font_size=9.5, sub="queued"),
    box("Run C", ACCENT, ACCENT_SOFT, ACCENT_BORDER, 0.9 * inch,
        height_padding=10, font_size=9.5, sub="queued"),
    arrow("→"),
    box("Worker", INK, NEUTRAL_BG, LINE, 1.2 * inch,
        height_padding=10, font_size=10, sub="picks A first"),
    arrow("→"),
    box("Run A", GREEN, GREEN_SOFT, HexColor("#86efac"),
        0.9 * inch, height_padding=10, font_size=9.5,
        sub="running"),
]], colWidths=[0.9 * inch, 0.9 * inch, 0.9 * inch, 0.3 * inch,
               1.2 * inch, 0.3 * inch, 0.9 * inch])
qrow.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 2),
    ("RIGHTPADDING", (0, 0), (-1, -1), 2),
]))
story.append(qrow)
story.append(Paragraph(
    "Three runs in the line. The Worker picks the oldest, marks it "
    "running, and starts. B and C stay in line.",
    CAPTION))

story.append(Paragraph("One worker at a time, on purpose", H2))
story.append(Paragraph(
    "The Worker is intentionally single-file: only one run is "
    "processed at a time. Inside a run, many properties can be "
    "checked in parallel (up to ten different portals at once), but "
    "two runs cannot overlap. The reason is Skyvern: we pay for a "
    "limited number of simultaneous browser sessions, and stacking "
    "two runs' browsers on top of each other would put us over the "
    "limit and cause everything to fail.",
    BODY))

story.append(Paragraph("What this buys us", H2))
story.extend(bullets([
    "<b>No work gets lost.</b> If the Worker crashes mid-run, the run "
    "is left in a 'running' state. The next time a Worker wakes up, "
    "it sees a stale run, finalizes it as failed, and moves on.",
    "<b>No work gets duplicated.</b> The atomic status flip — flipping "
    "to 'running' in the same database operation as reading the "
    "queue — means a run can only be claimed once.",
    "<b>The queue drains itself.</b> If five runs are queued, one "
    "Worker invocation handles all five back-to-back. No need to fire "
    "five separate Worker starts.",
    "<b>The dashboard always knows the truth.</b> Because the "
    "Database is the queue, the dashboard sees real status updates "
    "live — no separate progress system to keep in sync.",
]))

story.append(PageBreak())

# ============== §6 WORKER WAKES UP ==============
story.append(Paragraph("6. The worker wakes up", H1))
story.append(Paragraph(
    "Once the Worker has claimed a run, it goes to work. This section "
    "is the inside-the-engine view — what it actually does, without "
    "getting into how it does it.",
    BODY))

worker_steps = [
    ("Read the file.",
     "The Worker fetches the Excel file from the File Store using the "
     "address it found in the run record."),
    ("Figure out the spreadsheet.",
     "Spreadsheets vary. The header row might be the first row, the "
     "second row, or a pair of stacked rows. Column letters mean "
     "nothing — column F in one workbook is the account number, in "
     "another it's the owner. The Worker reads the header text and "
     "matches columns by meaning, not position. It also notices "
     "which columns contain formulas (those are protected — they will "
     "never be overwritten)."),
    ("Plan the work.",
     "For each property row, the Worker creates a record in the "
     "Database with status 'pending'. The run record's totals update "
     "to show how many rows it's about to process. The dashboard sees "
     "this and shows the user."),
    ("Group rows by portal.",
     "Two properties in the same county usually share a website. The "
     "Worker groups them so a single browser session can handle all "
     "the Broward properties one after another — that's polite to the "
     "county's server and faster than opening five separate browsers."),
    ("Open browsers — but not too many.",
     "Different portals can be handled at the same time, up to a "
     "ceiling. Right now that's ten different portals at once, "
     "though Skyvern's plan caps the practical number lower."),
    ("Drive each row.",
     "For each property, the Worker hands Skyvern a URL, an English "
     "description of what to find, and a structured form to fill in. "
     "Skyvern returns the answer. The Worker verifies and validates "
     "(see §8) and saves the result to the Database."),
    ("Write the Excel file back.",
     "When every row is done — or when the user cancels — the Worker "
     "reopens the original Excel file, fills in the answers, and "
     "uploads the result to the File Store. The run is marked done. "
     "The dashboard's Download button lights up."),
]
ws_rows = []
for i, (head, body) in enumerate(worker_steps, 1):
    ws_rows.append([
        Paragraph(f"<font color='#2563eb'><b>{i}</b></font>",
                  ParagraphStyle("WN", parent=BODY_LEFT,
                                 fontName="Helvetica-Bold",
                                 fontSize=13, leading=16)),
        Paragraph(f"<b>{head}</b><br/>"
                  f"<font color='#374151'>{body}</font>",
                  ParagraphStyle("WB", parent=BODY_LEFT,
                                 fontSize=10.5, leading=14)),
    ])
wst = Table(ws_rows, colWidths=[0.4 * inch, 6.2 * inch])
wst.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
]))
story.append(wst)

story.append(PageBreak())

# ============== §7 THE AI ==============
story.append(Paragraph("7. The AI driving the browser", H1))
story.append(Paragraph(
    "This is the part of the system most people want to understand. "
    "How does an AI 'use' a webpage?",
    LEAD))

story.append(Paragraph("How traditional scrapers work — and why they fail here",
                       H2))
story.append(Paragraph(
    "A classic web scraper is written for a specific website. The "
    "developer figures out that the account number goes into the box "
    "with HTML id <b>txtAccount</b>, the search button has class "
    "<b>btn-primary</b>, and the balance shows up in a table with "
    "label 'Total Due'. They write code that targets each of those "
    "elements by name.",
    BODY))
story.append(Paragraph(
    "This approach has two problems for us. First, every county "
    "website is different — a scraper for Broward County doesn't help "
    "with Pinellas County. Second, the moment the county redesigns "
    "their website or changes a label, the scraper breaks silently. "
    "Maintenance is constant.",
    BODY))

story.append(Paragraph("How Skyvern works", H2))
story.append(Paragraph(
    "Skyvern is built around a vision model — a large AI model "
    "trained to look at images of webpages and answer questions about "
    "them. It works the way a person would:",
    BODY))
story.extend(bullets([
    "Take a screenshot of the current page.",
    "Show the screenshot to the vision model along with a description "
    "of what the user is trying to do.",
    "Ask the model: 'where should I click? what should I type?'",
    "Execute the model's answer in a real browser.",
    "Repeat until the goal is reached.",
]))
story.append(Paragraph(
    "Because the model is looking at the page rather than parsing its "
    "HTML, it doesn't care whether the search box is called "
    "<b>txtAccount</b> or <b>parcel_input</b> or anything else. It "
    "sees a labeled box that looks like an account-number field and "
    "uses it.",
    BODY))

story.append(Paragraph("What we send and what we get back", H2))

send_table = [
    [Paragraph("<b>What the Worker sends to Skyvern</b>",
               ParagraphStyle("ST", parent=BODY_LEFT,
                              fontName="Helvetica-Bold",
                              textColor=ACCENT, fontSize=10.5))],
    [Paragraph(
        "<b>A URL.</b> Where to start.", BODY_LEFT)],
    [Paragraph(
        "<b>An English prompt.</b> 'Find the total amount owed for "
        "this property. Here's the address and account number. Don't "
        "click any payment buttons. Verify you're on the right "
        "property before you read the number.'", BODY_LEFT)],
    [Paragraph(
        "<b>A form to fill out.</b> A list of fields like "
        "<i>amount_due_now</i>, <i>owner_on_page</i>, and "
        "<i>page_outcome</i>. Skyvern is required to fill out this "
        "form, not write free text — that's how we get reliable, "
        "structured answers.", BODY_LEFT)],
]
st_t = Table(send_table, colWidths=[CONTENT_W])
st_t.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), ACCENT_SOFT),
    ("BACKGROUND", (0, 1), (-1, -1), HexColor("#fbfbfb")),
    ("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 12),
    ("RIGHTPADDING", (0, 0), (-1, -1), 12),
    ("TOPPADDING", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
]))
story.append(st_t)

recv_table = [
    [Paragraph("<b>What comes back</b>",
               ParagraphStyle("RT", parent=BODY_LEFT,
                              fontName="Helvetica-Bold",
                              textColor=GREEN, fontSize=10.5))],
    [Paragraph(
        "<b>The filled-out form.</b> The amount owed, whether any of "
        "it is delinquent, what owner the page showed, what address "
        "the page showed, what parcel number the page showed.",
        BODY_LEFT)],
    [Paragraph(
        "<b>An outcome tag.</b> One of: 'account_found' (best case), "
        "'landed_on_search' (deep link broke), 'no_matching_property' "
        "(search returned nothing), 'login_required', 'blocked', "
        "'pdf_only', or 'error'. The Worker uses this to decide what "
        "to do next.", BODY_LEFT)],
    [Paragraph(
        "<b>A video.</b> A recording of what Skyvern actually did. We "
        "save the link in the Database so anyone can re-watch the "
        "session if a result looks wrong.", BODY_LEFT)],
]
rt_t = Table(recv_table, colWidths=[CONTENT_W])
rt_t.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), GREEN_SOFT),
    ("BACKGROUND", (0, 1), (-1, -1), HexColor("#fbfdfb")),
    ("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 12),
    ("RIGHTPADDING", (0, 0), (-1, -1), 12),
    ("TOPPADDING", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
]))
story.append(rt_t)

story.append(PageBreak())

# ============== §7b The portals look like ==============
story.append(Paragraph("Why this generalizes", H2))
story.append(Paragraph(
    "Thousands of county portals exist in the U.S., but they come in "
    "only a handful of <b>shapes</b>. The Worker classifies any "
    "portal it sees into one of seven categories, and then drives it "
    "with a path it already knows.",
    BODY))

shapes_table = [
    ["Shape", "What it looks like", "How we handle it"],
    ["Direct page",
     "URL lands straight on the property.",
     "Verify owner; read the balance."],
    ["Search form",
     "URL lands on a search box.",
     "Type the account number; click through to the property."],
    ["Multi-step",
     "Disclaimer page first, then maybe a 'real estate vs tangible' "
     "selector, then search.",
     "Accept disclaimer; choose the right roll; search."],
    ["Year-pinned",
     "URL has the tax year baked in.",
     "Read the current total — labels handle the year."],
    ["Blocked",
     "Login wall, CAPTCHA, paywall.",
     "Mark NEEDS_REVIEW. Never bypass."],
    ["PDF-only",
     "Portal only exposes the bill as a downloadable PDF.",
     "Download the PDF, extract text, parse the amount."],
    ["Split sites",
     "Assessor data on one site, payment data on another.",
     "Read what's shown; chase the other site only if linked."],
]
sht = Table(shapes_table, colWidths=[1.0 * inch, 2.7 * inch,
                                      2.9 * inch])
sht.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("FONT", (0, 1), (0, -1), "Helvetica-Bold", 9.5),
    ("FONT", (1, 1), (-1, -1), "Helvetica", 9.5),
    ("TEXTCOLOR", (0, 1), (0, -1), ACCENT),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 7),
    ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ("TOPPADDING", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
]))
story.append(sht)

story.append(Paragraph("The playbook library — the system gets smarter", H2))
story.append(Paragraph(
    "The Database holds a library of what we know about each portal "
    "vendor. Eight of the major ones (Grant Street, Aumentum, Tyler, "
    "Pacific Blue, and so on) are pre-loaded with hints — 'on this "
    "vendor, the balance is shown as a banner at the top; expand the "
    "Recently Paid Bills section to verify.' When the Worker meets a "
    "vendor for the first time, it solves the page generically <b>and "
    "writes a new playbook entry</b> for next time. The library grows "
    "with every run.",
    BODY))

story.append(callout(
    "The 'fast mode' decision",
    [Paragraph(
        "Early on, the system tried to extract <i>everything</i> — "
        "receipts, payment dates, per-year history, exemptions. That "
        "took 20+ steps per property and timed out on real portals. "
        "The product question is actually simpler: 'how much is owed "
        "right now?' We re-scoped to answer just that one question, "
        "and Skyvern runs dropped to 3-6 steps. The full-detail mode "
        "is preserved in the code for a future phase, but the live "
        "system is fast-mode by default.",
        ParagraphStyle("FB", parent=BODY_LEFT, fontSize=10.5,
                       leading=14))],
    AMBER, AMBER_SOFT, HexColor("#fbbf24")))

story.append(PageBreak())

# ============== §8 VERIFICATION ==============
story.append(Paragraph("8. Verification & validation — the safety net", H1))
story.append(Paragraph(
    "Skyvern's answer is the raw material. Before any number gets "
    "written into the Excel file, the Worker runs two checks: "
    "verification (is this even the right property?) and validation "
    "(does the answer make sense?).",
    BODY))

story.append(Paragraph("8.1  Verification — did we read the right property?",
                       H2))
story.append(Paragraph(
    "Pontus owns lots of properties; counties have millions of "
    "records. A wrong deep link, a typo in the spreadsheet, or a "
    "stale token could all cause Skyvern to land on the wrong page "
    "and read someone else's balance. So the Worker checks three "
    "things against what Skyvern reports:",
    BODY))

ver_table = [
    ["Check", "What it does", "Tolerant of"],
    ["Owner name",
     "Does the page show 'PONTUS' or the row's owner entity?",
     "County data-entry mangling (PNTUS, PONTOUS, etc.)"],
    ["Address",
     "Does the page's address resemble the row's address?",
     "Abbreviations (Street/St, Highway/Hwy), unit suffixes"],
    ["Parcel / account",
     "Does the parcel shown match the row's account number?",
     "Different formats with/without dashes and leading zeros"],
]
vt = Table(ver_table, colWidths=[1.2 * inch, 2.6 * inch,
                                   2.8 * inch])
vt.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("FONT", (0, 1), (0, -1), "Helvetica-Bold", 9.5),
    ("FONT", (1, 1), (-1, -1), "Helvetica", 9.5),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 7),
    ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ("TOPPADDING", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
]))
story.append(vt)

story.append(Paragraph(
    "The three checks combine into a confidence level — HIGH, MEDIUM, "
    "or LOW. If all three agree, it's HIGH. If two agree but one is "
    "missing (the page didn't show an owner, say), it's MEDIUM. If "
    "nothing matches, the property is flagged as wrong and nothing is "
    "extracted.",
    BODY))

story.append(Paragraph(
    "One special case: <b>recently acquired properties may still show "
    "the seller's name</b>, because county records take months to "
    "update after a sale. So if the parcel and address both match but "
    "the owner doesn't, the Worker proceeds with MEDIUM confidence "
    "and records the owner mismatch in the evidence trail. The "
    "spreadsheet gets the answer; the audit trail records that the "
    "owner needs review.",
    BODY))

story.append(Paragraph("When the checks are inconclusive, ask Claude", H2))
story.append(Paragraph(
    "Sometimes the deterministic checks can't decide. The page's owner "
    "field is 'JOHN A. SMITH JR & CO. LLC' and the row's owner is "
    "'PONTUS HOLDINGS V SERIES A LLC' — clearly different — but the "
    "address is a partial match because of abbreviations the rules "
    "don't cover. In those cases, the Worker can call Claude (the "
    "Anthropic language model), hand it the row and the page side-by-"
    "side, and ask: 'is this the same property?' Claude returns a "
    "yes/no and a confidence number. This is the tie-breaker, not "
    "the default — most rows never need it.",
    BODY))

story.append(Paragraph("8.2  Validation — does the answer make sense?", H2))
story.append(Paragraph(
    "Validation is the second filter. It decides what reaches the "
    "spreadsheet cell and what only reaches the audit trail:",
    BODY))
story.extend(bullets([
    "<b>Zero or near-zero balance + HIGH confidence</b> → status "
    "<b>PAID</b>, amount-owed cell stays blank.",
    "<b>Positive balance + HIGH or MEDIUM confidence</b> → status "
    "<b>UNPAID</b> (or <b>DELINQUENT</b> if the page says any is past "
    "due), balance written to the amount cell.",
    "<b>No number found, confidence is LOW, or page reported "
    "blocked/login/error</b> → status <b>NEEDS_REVIEW</b>. The "
    "spreadsheet's data cells are not touched. A note in the status "
    "column explains what happened.",
]))

story.append(callout(
    "Three guarantees on every cell write",
    [Paragraph(
        "<b>Formulas are never overwritten.</b> Florida's Total column "
        "and the row-26 SUM stay intact.<br/><br/>"
        "<b>A blank or zero from the scraper never erases a real "
        "existing value.</b> If the portal glitched and returned "
        "nothing, the spreadsheet's old data stays.<br/><br/>"
        "<b>An existing different value is not silently replaced.</b> "
        "If the portal says one thing and the spreadsheet says "
        "another, the spreadsheet keeps its value and the discrepancy "
        "goes in the status column. The human decides.",
        ParagraphStyle("FB", parent=BODY_LEFT, fontSize=10.5,
                       leading=14))],
    GREEN, GREEN_SOFT, HexColor("#86efac")))

story.append(PageBreak())

# ============== §9 EXCEL COMES BACK ==============
story.append(Paragraph("9. The Excel file comes back", H1))
story.append(Paragraph(
    "When every row has been processed, the Worker enters write-back. "
    "This is the phase that matters most for the user experience: "
    "they get their <i>own</i> Excel file back, not some new format "
    "they have to learn.",
    BODY))

story.append(Paragraph("What gets preserved", H2))
story.extend(bullets([
    "Every formula, including the totals row.",
    "Every merged header cell.",
    "Every column width and font.",
    "Every hyperlink (the Website column stays clickable).",
    "Every existing piece of data the user typed in.",
    "Sheet order, tab colors, frozen panes.",
]))

story.append(Paragraph("What gets added", H2))
story.extend(bullets([
    "Answers go into the existing canonical columns: amount owed, "
    "date paid, receipt — wherever the workbook has those columns.",
    "A new status column is added at the right edge. The column "
    "header follows the workbook's existing naming pattern — if the "
    "workbook already has 'April 2026 Update', the new column will "
    "be 'June 2026 Update'.",
    "Each row gets one human-readable status line: '<i>Paid in full "
    "$4,974.48 on 12/29/2025</i>' or '<i>DELINQUENT — $123,456.78 "
    "owed as of 6/15/2026</i>' or '<i>NEEDS REVIEW — account not "
    "found</i>'.",
]))

story.append(Paragraph("Where the file lives", H2))
story.append(Paragraph(
    "The answered file is uploaded to the File Store. The user clicks "
    "Download in the dashboard; the API generates a one-hour signed "
    "link to the file in storage and redirects the browser to it. "
    "The original upload is never modified — we always produce a "
    "copy named with the run date.",
    BODY))

story.append(PageBreak())

# ============== §10 THINGS GO WRONG ==============
story.append(Paragraph("10. When things go wrong", H1))
story.append(Paragraph(
    "Production is messy. Portals time out, browsers crash, users "
    "change their mind mid-run. Every failure mode in this system has "
    "a containment.",
    BODY))

failure_table = [
    ["What happens", "How the system handles it"],
    ["The user clicks Cancel halfway through.",
     "Within five seconds, the Worker sees the cancel signal in the "
     "Database, aborts whatever Skyvern tasks are in flight, marks "
     "the cancelled rows as 'not checked', writes back the completed "
     "rows, and finalizes the run as 'canceled'."],
    ["A portal returns nothing or shows an error.",
     "The row becomes NEEDS_REVIEW with a reason. The other rows "
     "continue. One bad portal never aborts the whole run."],
    ["The Worker crashes mid-run (out of memory, hit the 6-hour limit).",
     "The run is left in the 'running' state. The next Worker "
     "invocation sees no recent activity and marks it failed. The "
     "user can click Retry to reset the unfinished rows and try "
     "again."],
    ["Skyvern is having a bad day (its session API returns errors).",
     "The Worker retries three times with growing backoff. If still "
     "failing, it falls back to one-off browser sessions instead of "
     "shared ones — slower, but the run continues."],
    ["The deep-link URL is stale and lands on a search page.",
     "The Worker detects this from the outcome tag and falls back to "
     "search-mode for that row, using the account number from the "
     "spreadsheet."],
    ["The portal requires login or a CAPTCHA we can't solve.",
     "The row becomes NEEDS_REVIEW with the reason 'portal requires "
     "login'. We never log into payment accounts on principle."],
    ["The spreadsheet has no URL column at all.",
     "The Worker does a web search for the county's official tax "
     "portal, records the discovered URL, and proceeds. Next time the "
     "spreadsheet is updated, the URL can be filled in."],
    ["Browser sessions accumulate from prior crashed runs.",
     "Before opening any new browsers, the Worker scans Skyvern for "
     "leftover sessions and closes them all. This keeps us under "
     "Skyvern's concurrent-session cap."],
]

fail_t = Table(failure_table, colWidths=[2.5 * inch, 4.1 * inch])
fail_t.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("FONT", (0, 1), (0, -1), "Helvetica-Bold", 9.5),
    ("FONT", (1, 1), (-1, -1), "Helvetica", 9.5),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 7),
    ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ("TOPPADDING", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
]))
story.append(fail_t)

story.append(Paragraph(
    "The pattern in all of this: <b>nothing the system does is "
    "destructive, and nothing fails silently.</b> A row that couldn't "
    "be answered is flagged, not skipped. A crashed run is marked "
    "failed, not orphaned. A canceled run still produces an output "
    "file with whatever was completed.",
    BODY))

story.append(PageBreak())

# ============== §11 COST ==============
story.append(Paragraph("11. What it costs to run", H1))
story.append(Paragraph(
    "Every component of this system is pay-as-you-go. There are no "
    "servers we operate, no monthly minimums beyond a Vercel plan "
    "and Firebase's Blaze tier. The cost is dominated by Skyvern, "
    "because that's where the actual work happens.",
    BODY))

story.append(Paragraph("Per-property", H2))
story.append(Paragraph(
    "Skyvern bills by the step — roughly, one step is one "
    "look-at-the-page-and-decide-what-to-do cycle. A typical "
    "property lookup in fast mode runs three to six steps. The "
    "practical cost per property works out to roughly thirty to "
    "sixty cents.",
    BODY))

cost_summary = Table([
    [Paragraph("<b>For a typical 100-property portfolio refresh:</b>",
               BODY_LEFT)],
    [Paragraph("<b>$30 – $60</b> in Skyvern fees (variable, "
               "per-property)",
               ParagraphStyle("CSB", parent=BODY_LEFT, fontSize=11,
                              leading=14))],
    [Paragraph("<b>Under $25/month</b> in fixed infrastructure "
               "(Vercel + Firebase + Cloud Run)",
               ParagraphStyle("CSB", parent=BODY_LEFT, fontSize=11,
                              leading=14))],
    [Paragraph("<b>Less than lunch</b>, in total, to refresh data "
               "that used to take a full afternoon of analyst time",
               ParagraphStyle("CSB", parent=BODY_LEFT, fontSize=11,
                              leading=14, textColor=ACCENT,
                              fontName="Helvetica-Bold"))],
], colWidths=[CONTENT_W])
cost_summary.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), ACCENT_SOFT),
    ("BACKGROUND", (0, 1), (-1, -1), HexColor("#fbfbfb")),
    ("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 14),
    ("RIGHTPADDING", (0, 0), (-1, -1), 14),
    ("TOPPADDING", (0, 0), (-1, -1), 10),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
]))
story.append(cost_summary)

story.append(Paragraph("Where each dollar goes", H2))

cost_rows = [
    ["Provider", "What we pay for", "Practical scale"],
    ["Skyvern",
     "Per browser step — the AI looking, deciding, clicking.",
     "≈ $0.30 – $0.60 per property"],
    ["Vercel",
     "Hosting the dashboard and the API.",
     "$0 – $20 / month"],
    ["Firebase",
     "Database reads/writes, file storage.",
     "Pennies / month"],
    ["Google Cloud Run",
     "Seconds of CPU the Worker actually runs.",
     "Pennies – dollars / month"],
    ["Anthropic Claude",
     "Optional tie-break adjudication.",
     "Pennies per property, only when needed"],
]
ct2 = Table(cost_rows, colWidths=[1.4 * inch, 3.0 * inch,
                                    2.2 * inch])
ct2.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("FONT", (0, 1), (0, -1), "Helvetica-Bold", 9.5),
    ("FONT", (1, 1), (-1, -1), "Helvetica", 9.5),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 7),
    ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.append(ct2)

story.append(PageBreak())

# ============== §12 WHY THIS STACK ==============
story.append(Paragraph("12. Why this stack, not another", H1))
story.append(Paragraph(
    "A few of the architecture choices weren't obvious. They're "
    "worth explaining, because each one shaped what's possible — and "
    "what's not — with the system.",
    BODY))

story.append(Paragraph("Why an AI browser instead of traditional scrapers", H2))
story.append(Paragraph(
    "The alternative was Playwright or Puppeteer — well-understood "
    "tools that drive browsers by CSS selectors. We rejected them "
    "because the portal landscape is too fragmented. Writing and "
    "maintaining a separate scraper for each of a dozen vendors "
    "(plus occasional one-off counties) would be a full-time job. "
    "Skyvern lets us write one workflow and have it generalize.",
    BODY))

story.append(Paragraph(
    "The downside is that Skyvern is slower (real LLM calls cost "
    "seconds) and more expensive per call than selector scraping. We "
    "accept that trade-off because the maintenance savings dwarf it.",
    BODY))

story.append(Paragraph("Why a queue instead of a real-time API", H2))
story.append(Paragraph(
    "A real-time approach — analyst clicks 'check this property' and "
    "the answer comes back in 30 seconds — would be tempting. But "
    "the operation takes 30–90 seconds per property, which is too "
    "long for a synchronous request, and any failure would have to "
    "be retried by hand. A queue lets the user upload a whole batch, "
    "walk away, and come back to find it done. Cancel is one click.",
    BODY))

story.append(Paragraph("Why Firestore instead of a SQL database", H2))
story.append(Paragraph(
    "Firestore is part of Firebase, so it comes with a real-time "
    "feed the dashboard can subscribe to — when a row updates, the "
    "dashboard sees it without polling. It also has automatic "
    "scaling and no maintenance. The trade-off is no SQL joins, but "
    "this system's data is shallow (runs, rows, events) — we don't "
    "need joins.",
    BODY))

story.append(Paragraph(
    "It's also worth noting that this is Pontus's standard internal-"
    "tools stack. Engineers who work on other Pontus tools can move "
    "into this codebase without re-learning the plumbing.",
    BODY))

story.append(Paragraph("Why Cloud Run instead of a long-running server", H2))
story.append(Paragraph(
    "The Worker only does work when a run is queued. A long-running "
    "server would sit idle most of the time and we'd pay for it. "
    "Cloud Run charges only for the seconds the Worker is actually "
    "processing. The trade-off is that startup costs a few seconds "
    "of cold-start, but for a multi-minute batch job that's "
    "negligible.",
    BODY))

story.append(Paragraph("Why no authentication, for now", H2))
story.append(Paragraph(
    "The dashboard is public — anyone with the URL can use it. This "
    "was a deliberate trade-off made on 11 June 2026: authentication "
    "added complexity that wasn't earning its keep for an internal "
    "tool whose URL we control. If this ever becomes a tool exposed "
    "more broadly, auth comes back; for now, the URL is the secret.",
    BODY))

story.append(Spacer(1, 0.3 * inch))

# Closing summary
story.append(callout(
    "If you remember one thing",
    [Paragraph(
        "The Property Tax Checker is best understood as a "
        "<b>pipeline glued by a database</b>. The dashboard puts work "
        "into the database. The Worker takes work out of the "
        "database. Skyvern does the actual browsing on the Worker's "
        "behalf. The Worker writes results back into the database. "
        "The dashboard reads results from the database and shows "
        "them. Every component has one job, and the database is the "
        "shared notebook they all read from. That's the system.",
        ParagraphStyle("FB", parent=BODY_LEFT, fontSize=11,
                       leading=15))],
    ACCENT, ACCENT_SOFT, ACCENT_BORDER))

story.append(Spacer(1, 0.2 * inch))
story.append(Paragraph(
    "<i>End of report.</i>",
    ParagraphStyle("End", parent=BODY_LEFT, fontSize=10,
                   textColor=MUTED, alignment=TA_LEFT)))


# ======================================================================
# Build
# ======================================================================

doc = BaseDocTemplate(
    OUT,
    pagesize=LETTER,
    leftMargin=MARGIN, rightMargin=MARGIN,
    topMargin=0.85 * inch, bottomMargin=0.85 * inch,
    title="Pontus Property Tax Checker — How It Works",
    author="Nicholas Revenco, Pontus Capital",
)

cover_frame = Frame(
    MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN,
    id="cover", showBoundary=0,
)
body_frame = Frame(
    MARGIN, 0.75 * inch,
    PAGE_W - 2 * MARGIN, PAGE_H - 1.6 * inch,
    id="body", showBoundary=0,
)

doc.addPageTemplates([
    PageTemplate(id="Cover", frames=[cover_frame], onPage=cover_page),
    PageTemplate(id="Body", frames=[body_frame], onPage=chrome),
])

from reportlab.platypus import NextPageTemplate
story.insert(0, NextPageTemplate("Cover"))
for i, item in enumerate(story):
    if isinstance(item, PageBreak):
        story.insert(i, NextPageTemplate("Body"))
        break

doc.build(story)
print(f"Wrote {OUT}")
