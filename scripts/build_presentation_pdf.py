"""Build the Pontus Property Tax Checker presentation as a PDF."""

from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import landscape, LETTER
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
)

OUT = (
    "/Users/nicholasrevencomacbookair/Desktop/Pontus Capital/"
    "Pontus Projects/New Tax Project/"
    "Pontus_Property_Tax_Checker_Presentation.pdf"
)

# Pontus palette
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

PAGE_W, PAGE_H = landscape(LETTER)  # 11 x 8.5 in
MARGIN = 0.6 * inch

styles = getSampleStyleSheet()

H1 = ParagraphStyle(
    "H1", parent=styles["Heading1"], fontName="Helvetica-Bold",
    fontSize=30, leading=34, textColor=INK, spaceAfter=4,
)
H1_ACCENT = ParagraphStyle(
    "H1A", parent=H1, textColor=ACCENT,
)
H2 = ParagraphStyle(
    "H2", parent=styles["Heading2"], fontName="Helvetica-Bold",
    fontSize=20, leading=24, textColor=INK, spaceAfter=6,
)
EYEBROW = ParagraphStyle(
    "Eyebrow", parent=styles["Normal"], fontName="Helvetica-Bold",
    fontSize=9, leading=11, textColor=ACCENT, spaceAfter=6,
    letterSpacing=1.5,
)
BODY = ParagraphStyle(
    "Body", parent=styles["Normal"], fontName="Helvetica",
    fontSize=11.5, leading=16, textColor=INK, spaceAfter=8,
)
BODY_MUTED = ParagraphStyle(
    "BodyMuted", parent=BODY, textColor=MUTED,
)
BULLET = ParagraphStyle(
    "Bullet", parent=BODY, leftIndent=14, bulletIndent=2, spaceAfter=4,
)
SMALL = ParagraphStyle(
    "Small", parent=styles["Normal"], fontName="Helvetica",
    fontSize=9, leading=12, textColor=MUTED,
)
KICKER = ParagraphStyle(
    "Kicker", parent=styles["Normal"], fontName="Helvetica-Bold",
    fontSize=11, leading=14, textColor=ACCENT, spaceAfter=4,
)
MONO = ParagraphStyle(
    "Mono", parent=styles["Normal"], fontName="Courier",
    fontSize=10, leading=13, textColor=INK,
)
TITLE_HUGE = ParagraphStyle(
    "TitleHuge", parent=styles["Title"], fontName="Helvetica-Bold",
    fontSize=46, leading=52, textColor=INK, alignment=TA_LEFT,
)
TITLE_SUB = ParagraphStyle(
    "TitleSub", parent=styles["Normal"], fontName="Helvetica",
    fontSize=15, leading=20, textColor=MUTED, alignment=TA_LEFT,
)


def page_chrome(canvas, doc):
    """Header/footer drawn under every content slide."""
    canvas.saveState()
    # top hairline
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, PAGE_H - 0.45 * inch,
                PAGE_W - MARGIN, PAGE_H - 0.45 * inch)
    # eyebrow
    canvas.setFont("Helvetica-Bold", 8)
    canvas.setFillColor(ACCENT)
    canvas.drawString(MARGIN, PAGE_H - 0.32 * inch,
                      "PONTUS  ·  PROPERTY TAX CHECKER")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 0.32 * inch,
                           "Internal — June 2026")
    # footer hairline
    canvas.setStrokeColor(LINE)
    canvas.line(MARGIN, 0.55 * inch, PAGE_W - MARGIN, 0.55 * inch)
    # page number
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SUBTLE)
    canvas.drawRightString(PAGE_W - MARGIN, 0.38 * inch,
                           f"{doc.page - 1:02d}")
    canvas.drawString(MARGIN, 0.38 * inch,
                      "Excel in  →  AI portal lookup  →  Excel out")
    canvas.restoreState()


def title_page(canvas, doc):
    """Cover slide — no chrome, just a big mark."""
    canvas.saveState()
    canvas.setFillColor(BG)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    # accent slab on the left
    canvas.setFillColor(ACCENT)
    canvas.rect(0, 0, 0.18 * inch, PAGE_H, fill=1, stroke=0)
    # eyebrow
    canvas.setFont("Helvetica-Bold", 10)
    canvas.setFillColor(ACCENT)
    canvas.drawString(MARGIN, PAGE_H - 0.7 * inch, "PONTUS  ·  INTERNAL TOOL")
    # page number
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(PAGE_W - MARGIN, 0.4 * inch,
                           "Built June 2026  ·  Nicholas Revenco")
    canvas.restoreState()


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

def section_title(eyebrow, title):
    return [
        Paragraph(eyebrow.upper(), EYEBROW),
        Paragraph(title, H1),
        Spacer(1, 0.12 * inch),
    ]


def two_col(left_flow, right_flow, left_w=4.9, right_w=4.9):
    """A two-column row with no visible borders."""
    t = Table(
        [[left_flow, right_flow]],
        colWidths=[left_w * inch, right_w * inch],
        hAlign="LEFT",
    )
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def card(title, body_paragraphs, accent=ACCENT, bg=ACCENT_SOFT, width=4.7):
    """A coloured info card."""
    inner = [Paragraph(f"<b>{title}</b>",
                       ParagraphStyle(
                           "CardTitle", parent=BODY,
                           textColor=accent, fontName="Helvetica-Bold",
                           fontSize=12, leading=15, spaceAfter=4,
                       ))]
    for p in body_paragraphs:
        inner.append(p)
    t = Table([[inner]], colWidths=[width * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return t


def bullets(items):
    flow = []
    for it in items:
        flow.append(Paragraph(f"•&nbsp;&nbsp;{it}", BULLET))
    return flow


def stat_card(value, label, accent=ACCENT, bg=ACCENT_SOFT, width=2.2):
    inner = [
        Paragraph(value, ParagraphStyle(
            "StatNum", parent=BODY, fontName="Helvetica-Bold",
            fontSize=26, leading=30, textColor=accent, spaceAfter=2,
        )),
        Paragraph(label, ParagraphStyle(
            "StatLbl", parent=SMALL, textColor=INK, fontSize=10, leading=13,
        )),
    ]
    t = Table([[inner]], colWidths=[width * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return t


# ----------------------------------------------------------------------
# Build the story
# ----------------------------------------------------------------------

story = []

# ---------- SLIDE 1: COVER ----------
story.append(Spacer(1, 1.4 * inch))
story.append(Paragraph("Property Tax Checker", TITLE_HUGE))
story.append(Spacer(1, 0.05 * inch))
story.append(Paragraph(
    "Upload a workbook. We look up every property's tax status across "
    "any county portal in the country. Download the same workbook, "
    "now with answers.",
    TITLE_SUB,
))
story.append(Spacer(1, 0.5 * inch))

# inline stat row on cover
cover_stats = Table([[
    stat_card("15+", "U.S. states supported", ACCENT, ACCENT_SOFT, width=2.4),
    stat_card("Any", "county portal, even unseen ones",
              GREEN, GREEN_SOFT, width=2.4),
    stat_card("100%", "read-only — never pays a bill",
              AMBER, AMBER_SOFT, width=2.4),
    stat_card("1 file", "in, same file out, structure preserved",
              INK, BG, width=2.4),
]], colWidths=[2.5 * inch] * 4)
cover_stats.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 0),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
]))
story.append(cover_stats)

story.append(PageBreak())

# ---------- SLIDE 2: AGENDA ----------
story += section_title("Agenda", "What we'll cover")

agenda_items = [
    ("01", "The problem", "Manual portal-by-portal tax tracking across "
        "15+ states doesn't scale."),
    ("02", "The product", "Excel in → AI portal lookup → Excel out. "
        "One file, every property answered."),
    ("03", "How it works", "Four steps: classify the portal, find the "
        "property, read the bill, write the answer."),
    ("04", "Architecture", "Next.js frontend on Vercel, Python worker on "
        "Cloud Run, Skyvern for the browser, Firestore for state."),
    ("05", "What makes it smart", "Vision-based AI handles portals it has "
        "never seen, and writes itself a playbook for next time."),
    ("06", "Cost & operations", "What we pay each provider and the "
        "guardrails that keep it safe."),
    ("07", "What's next", "Roadmap from Excel workflow to live dashboard."),
]

rows = []
for n, title, sub in agenda_items:
    rows.append([
        Paragraph(f"<font color='#2563eb'><b>{n}</b></font>",
                  ParagraphStyle("AN", parent=BODY, fontSize=14,
                                 fontName="Helvetica-Bold", leading=18)),
        Paragraph(f"<b>{title}</b><br/>"
                  f"<font color='#525252'>{sub}</font>",
                  ParagraphStyle("AT", parent=BODY, fontSize=11.5,
                                 leading=15)),
    ])

agenda = Table(rows, colWidths=[0.7 * inch, 8.5 * inch])
agenda.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 10),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
]))
story.append(agenda)
story.append(PageBreak())

# ---------- SLIDE 3: THE PROBLEM ----------
story += section_title("01  ·  The problem", "Property taxes don't scale "
                       "by hand")

left = [
    Paragraph(
        "Pontus owns property across <b>15+ states and dozens of "
        "counties</b>. Each county has its own tax portal — different "
        "URL, different layout, different login flow, different way to "
        "show whether a bill is paid.",
        BODY,
    ),
    Paragraph(
        "An analyst opening every URL by hand, finding the property, "
        "reading the balance, and typing it into a spreadsheet is "
        "<b>hours of work per portfolio refresh</b>. Doing it monthly "
        "for hundreds of properties is unsustainable.",
        BODY,
    ),
    Paragraph(
        "Worse, the data ages fast. The minute the spreadsheet is "
        "saved, a new bill could be posted, a payment cleared, or a "
        "delinquency penalty applied.",
        BODY_MUTED,
    ),
]

right_card = card(
    "Why every portal is different",
    [
        Paragraph("• Government portals run on <b>5+ vendor platforms</b> "
                  "(Grant Street, Aumentum, PublicAccessNow, Tyler "
                  "Technologies, Pacific Blue, plus one-offs)", BODY),
        Paragraph("• Tax year semantics vary: Florida is calendar-year, "
                  "California is fiscal-year (2025-26), Texas bills in "
                  "October", BODY),
        Paragraph("• Some portals deep-link to the property; most don't "
                  "— you start at a search box", BODY),
        Paragraph("• Discounts, installment plans, exemptions: a "
                  "property paid in full often shows less than the "
                  "billed amount — and that's <b>correct</b>", BODY),
    ],
    accent=AMBER, bg=AMBER_SOFT, width=4.7,
)

story.append(two_col(left, right_card))
story.append(PageBreak())

# ---------- SLIDE 4: THE PRODUCT ----------
story += section_title("02  ·  The product",
                       "One workflow. One file. One answer per property.")

flow_cells = [
    [
        Paragraph("<b>1.  Upload</b>",
                  ParagraphStyle("S", parent=BODY, fontSize=13,
                                 fontName="Helvetica-Bold",
                                 textColor=ACCENT)),
        Paragraph("Drag the Excel tracker onto the web app. Any layout, "
                  "any state. Headers are detected by meaning, not column "
                  "letter.", BODY),
    ],
    [
        Paragraph("<b>2.  Read</b>",
                  ParagraphStyle("S", parent=BODY, fontSize=13,
                                 fontName="Helvetica-Bold",
                                 textColor=ACCENT)),
        Paragraph("For each property, an AI browser agent opens the row's "
                  "portal URL, classifies the page (deep link / search / "
                  "multi-step / PDF / blocked), and navigates to the "
                  "right account.", BODY),
    ],
    [
        Paragraph("<b>3.  Verify</b>",
                  ParagraphStyle("S", parent=BODY, fontSize=13,
                                 fontName="Helvetica-Bold",
                                 textColor=ACCENT)),
        Paragraph("Owner name, address, parcel — all cross-checked before "
                  "anything gets recorded. If the page doesn't match the "
                  "property, it's flagged, not guessed.", BODY),
    ],
    [
        Paragraph("<b>4.  Download</b>",
                  ParagraphStyle("S", parent=BODY, fontSize=13,
                                 fontName="Helvetica-Bold",
                                 textColor=ACCENT)),
        Paragraph("The original Excel file is returned with a new "
                  "<i>'&lt;Month&gt; Update'</i> column filled in — "
                  "formulas, formatting, merged headers all preserved.",
                  BODY),
    ],
]

flow = Table(flow_cells, colWidths=[1.5 * inch, 8.2 * inch])
flow.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 14),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
]))
story.append(flow)
story.append(Spacer(1, 0.15 * inch))
story.append(Paragraph(
    "<i>The crucial design choice:</i> the spreadsheet stays the source "
    "of truth. Analysts keep their workflow. We just make the lookup "
    "step disappear.",
    BODY_MUTED,
))
story.append(PageBreak())

# ---------- SLIDE 5: HOW IT WORKS — TAXONOMY ----------
story += section_title(
    "03  ·  The smart part",
    "We classify any portal we've never seen into one of 7 shapes",
)

tax_rows = [
    ["A", "Direct account page",
     "URL deep-links straight to the property. Read and move on."],
    ["B", "Search form",
     "Type an account #, parcel, or address — handle the results list."],
    ["C", "Multi-step flow",
     "Disclaimer page, roll-type selector, then the search. Click through."],
    ["D", "Year selector",
     "Some portals pin the tax year in the URL. We confirm the year matches."],
    ["E", "Blocked",
     "Login wall, CAPTCHA, paywall. We mark NEEDS_REVIEW — never bypass."],
    ["F", "PDF-only",
     "Some counties expose only PDF bills. We download, OCR if needed, parse."],
    ["G", "Split assessor/collector",
     "Texas-style: appraisal district and tax office are different sites."],
]

tdata = [["Type", "Pattern", "What we do"]] + tax_rows
tt = Table(tdata, colWidths=[0.7 * inch, 2.2 * inch, 6.8 * inch])
tt.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 10),
    ("BACKGROUND", (0, 0), (-1, 0), HexColor("#f5f5f5")),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEABOVE", (0, 0), (-1, 0), 0.5, LINE),
    ("LINEBELOW", (0, 0), (-1, 0), 0.5, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.3, LINE),
    ("FONT", (0, 1), (0, -1), "Helvetica-Bold", 11),
    ("TEXTCOLOR", (0, 1), (0, -1), ACCENT),
    ("FONT", (1, 1), (1, -1), "Helvetica-Bold", 10.5),
    ("FONT", (2, 1), (2, -1), "Helvetica", 10.5),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
]))
story.append(tt)
story.append(Spacer(1, 0.15 * inch))
story.append(Paragraph(
    "<b>If the vendor is brand new</b> — we look at the page footer "
    "('Powered by Grant Street Group', 'Tyler Technologies', etc.), "
    "solve it generically, and <b>write ourselves a playbook entry</b> "
    "for next time. The system gets smarter every run.",
    BODY,
))
story.append(PageBreak())

# ---------- SLIDE 6: ARCHITECTURE ----------
story += section_title(
    "04  ·  Architecture",
    "Six pieces. Each does one thing well.",
)

arch_rows = [
    ["Frontend", "Next.js 16 (App Router) + TypeScript + Tailwind + shadcn/ui",
     "Vercel"],
    ["API layer", "Next.js API routes — upload, list runs, download, cancel",
     "Vercel"],
    ["Database", "Firestore (NoSQL) — runs, rows, events, playbooks",
     "Firebase"],
    ["File storage", "Workbook uploads + processed outputs",
     "Firebase Storage"],
    ["Worker", "Python — orchestrator, intake, verify, validate, write-back",
     "Google Cloud Run Job"],
    ["Browser AI", "Vision-based scraping agent that drives any portal",
     "Skyvern (managed)"],
]

ahdr = ["Layer", "What it does", "Where it runs"]
adata = [ahdr] + arch_rows
at = Table(adata, colWidths=[1.5 * inch, 5.7 * inch, 2.5 * inch])
at.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 10),
    ("BACKGROUND", (0, 0), (-1, 0), HexColor("#f5f5f5")),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEABOVE", (0, 0), (-1, 0), 0.5, LINE),
    ("LINEBELOW", (0, 0), (-1, 0), 0.5, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.3, LINE),
    ("FONT", (0, 1), (0, -1), "Helvetica-Bold", 11),
    ("FONT", (1, 1), (1, -1), "Helvetica", 10.5),
    ("FONT", (2, 1), (2, -1), "Helvetica-Bold", 10),
    ("TEXTCOLOR", (2, 1), (2, -1), ACCENT),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 11),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 11),
]))
story.append(at)
story.append(Spacer(1, 0.15 * inch))
story.append(Paragraph(
    "<b>Why this stack?</b> Every layer is pay-as-you-go and "
    "platform-native. Vercel + Firebase + Cloud Run are all part of the "
    "same standard Pontus tooling template — every internal tool we "
    "build sits on the same foundation, so engineers move between "
    "projects without re-learning the plumbing.",
    BODY_MUTED,
))
story.append(PageBreak())

# ---------- SLIDE 7: DATA FLOW ----------
story += section_title(
    "04b  ·  Data flow",
    "What happens between upload and download",
)

steps = [
    ("User uploads .xlsx",
     "Browser POSTs the file to the Next.js API on Vercel."),
    ("File lands in Firebase Storage",
     "A new <i>tax_checker_runs</i> document is created with status "
     "<b>queued</b>, one sub-doc per property row."),
    ("Cloud Run Job picks up the run",
     "The Python worker claims the next queued run, "
     "groups rows by portal domain, and opens browser sessions."),
    ("Skyvern drives the portals",
     "For each row, the worker sends a structured task to Skyvern: "
     "'open URL, classify, find account, return amount due'."),
    ("Verify + validate",
     "Owner / parcel / address are cross-checked. Discount bands, "
     "delinquent-growth rules, year-match — all enforced before writing."),
    ("Write-back to Excel",
     "openpyxl opens the original workbook, fills the canonical "
     "columns + a new <i>'June 2026 Update'</i> column, preserves "
     "every formula and merged header."),
    ("Download",
     "The processed file is uploaded back to Firebase Storage; "
     "the UI gets a signed URL; the user clicks <b>Download</b>."),
]

step_cells = []
for i, (title, body) in enumerate(steps, 1):
    step_cells.append([
        Paragraph(
            f"<font color='#2563eb'><b>{i:02d}</b></font>",
            ParagraphStyle("F", parent=BODY, fontSize=15,
                           fontName="Helvetica-Bold", leading=18),
        ),
        Paragraph(f"<b>{title}</b><br/>"
                  f"<font color='#525252'>{body}</font>",
                  ParagraphStyle("FT", parent=BODY, leading=15)),
    ])

flow_t = Table(step_cells, colWidths=[0.55 * inch, 9.2 * inch])
flow_t.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
]))
story.append(flow_t)
story.append(PageBreak())

# ---------- SLIDE 8: HOW IT'S BUILT ----------
story += section_title(
    "05  ·  Under the hood",
    "The engine — what each module does",
)

modules = [
    ("intake.py", "Detect headers across any workbook. Florida uses "
        "stacked header rows; California uses single. Map columns by "
        "synonym matching, not column letter."),
    ("identifiers.py", "Normalize dirty account / parcel data. Strip "
        "'#', dashes, leading zeros; split multi-account cells; try "
        "each candidate in order until something hits."),
    ("taxonomy.py", "Classify whatever the portal landed on into one "
        "of the 7 shapes (A–G)."),
    ("playbooks.py", "Vendor-specific quirks library — recognizes "
        "Grant Street, Aumentum, PublicAccessNow, Pacific Blue, Tyler. "
        "Auto-extends with new vendors as we meet them."),
    ("skyvern_runner.py", "The bridge to Skyvern. One workflow per "
        "taxonomy type, parameterized by URL + identifiers."),
    ("verify.py", "Ownership + address cross-check before any "
        "extraction. Fuzzy match on owner names (county data entry is "
        "messy); exact match on parcel."),
    ("validate.py", "The discount-band, delinquent-growth, "
        "no-silent-erasure rules. A scraped $0 NEVER overwrites a "
        "real value."),
    ("writeback.py", "openpyxl writes the answers back. Cells with "
        "formulas are protected — Florida's Total column W and the "
        "SUM row are untouched."),
    ("orchestrator.py", "The conductor. Resumable per-row, polite "
        "rate-limiting per portal, on-the-spot cancel."),
]

mod_table_data = []
for name, desc in modules:
    mod_table_data.append([
        Paragraph(f"<font face='Courier'><b>{name}</b></font>",
                  ParagraphStyle("Mn", parent=MONO, fontSize=10,
                                 textColor=ACCENT, leading=14)),
        Paragraph(desc, ParagraphStyle("Md", parent=BODY, fontSize=10.5,
                                       leading=14)),
    ])

mod_t = Table(mod_table_data, colWidths=[1.9 * inch, 7.85 * inch])
mod_t.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.append(mod_t)
story.append(PageBreak())

# ---------- SLIDE 9: SAFETY ----------
story += section_title(
    "06  ·  Safety guardrails",
    "What the system will not do, by design",
)

left_safety = card(
    "Hard rules",
    [
        Paragraph("• <b>Absolute read-only</b> on portals. Never add to "
                  "cart, checkout, pay, enroll in installment plans, "
                  "create accounts, or log in to payment accounts.",
                  BODY),
        Paragraph("• <b>Never auto-bypass</b> a CAPTCHA wall or "
                  "eligibility gate. If genuinely blocked → mark "
                  "NEEDS_REVIEW.", BODY),
        Paragraph("• <b>No silent erasure</b>. A scraped $0 NEVER "
                  "overwrites a real existing value. Parse glitches "
                  "must not delete data.", BODY),
        Paragraph("• <b>Wrong-property protection</b>. Owner, address, "
                  "or parcel must match before anything is extracted.",
                  BODY),
    ],
    accent=RED, bg=RED_SOFT,
)

right_safety = card(
    "Confidence model",
    [
        Paragraph("Every row gets a confidence tag:", BODY),
        Paragraph("<b><font color='#15803d'>HIGH</font></b> — owner + "
                  "parcel verified, payment details read directly.",
                  BODY),
        Paragraph("<b><font color='#b45309'>MEDIUM</font></b> — fuzzy "
                  "match or proof section unavailable. Recorded with "
                  "evidence trail.", BODY),
        Paragraph("<b><font color='#b91c1c'>LOW</font> / "
                  "NEEDS_REVIEW</b> — anything inferred. Goes to the "
                  "status column only, never into data columns.", BODY),
        Paragraph("<i>The user always sees why we landed on each "
                  "answer.</i>", BODY_MUTED),
    ],
    accent=GREEN, bg=GREEN_SOFT,
)

story.append(two_col(left_safety, right_safety))
story.append(PageBreak())

# ---------- SLIDE 10: COST ----------
story += section_title(
    "07  ·  What it costs to run",
    "Pay-as-you-go across four providers",
)

cost_rows = [
    ["Skyvern (browser AI)",
     "Per-step pricing on the cloud plan — roughly $0.10 / step. "
     "A typical property lookup runs ~3–6 steps.",
     "≈ $0.30 – $0.60 / property"],
    ["Vercel (frontend + API)",
     "Hobby tier free for early use. Pro plan $20 / month covers our "
     "scale comfortably (function invocations, bandwidth).",
     "$0 – $20 / mo"],
    ["Firebase (database + storage)",
     "Blaze pay-as-you-go. Firestore reads/writes are sub-cent per 1k. "
     "Storage measured in pennies for our workbook sizes.",
     "Pennies / mo"],
    ["Google Cloud Run (worker)",
     "Pay for the seconds the job runs. The job sleeps between "
     "uploads, so we're billed only during active processing.",
     "Pennies–dollars / mo"],
]

cdata = [["Provider", "Pricing model", "Practical cost"]] + cost_rows
ct = Table(cdata, colWidths=[2.5 * inch, 5.5 * inch, 2.0 * inch])
ct.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 10),
    ("BACKGROUND", (0, 0), (-1, 0), HexColor("#f5f5f5")),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEABOVE", (0, 0), (-1, 0), 0.5, LINE),
    ("LINEBELOW", (0, 0), (-1, 0), 0.5, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.3, LINE),
    ("FONT", (0, 1), (0, -1), "Helvetica-Bold", 11),
    ("FONT", (1, 1), (1, -1), "Helvetica", 10.5),
    ("FONT", (2, 1), (2, -1), "Helvetica-Bold", 10.5),
    ("TEXTCOLOR", (2, 1), (2, -1), ACCENT),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 10),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
]))
story.append(ct)
story.append(Spacer(1, 0.15 * inch))
story.append(Paragraph(
    "<b>Bottom line for a 100-property portfolio refresh:</b> "
    "the bulk of the bill is Skyvern's per-step pricing — roughly "
    "<b>$30–$60 of variable cost</b> per full run. Fixed infrastructure "
    "is under $25/month. Compare that with one analyst-hour at any "
    "reasonable rate, and a refresh that used to take a full afternoon "
    "now costs less than lunch.",
    BODY,
))
story.append(Spacer(1, 0.05 * inch))
story.append(Paragraph(
    "Skyvern pricing tiers are subject to change — confirm against "
    "the current cloud plan before quoting externally.",
    SMALL,
))
story.append(PageBreak())

# ---------- SLIDE 11: WHY SKYVERN ----------
story += section_title(
    "07b  ·  Why Skyvern, specifically",
    "The AI browser that handles portals it's never seen",
)

left = [
    Paragraph(
        "Traditional scrapers (Playwright, Puppeteer, BeautifulSoup) "
        "need a script per portal. Five portals = five scripts. "
        "Fifty portals = a maintenance nightmare.",
        BODY,
    ),
    Paragraph(
        "Skyvern uses <b>vision-based AI</b> — it looks at the page "
        "like a person would, reads the labels, and decides what to "
        "click. One workflow generalizes across vendors.",
        BODY,
    ),
    Paragraph(
        "It also handles CAPTCHAs natively, supports persistent "
        "browser sessions, and exposes a clean HTTP API. We point at "
        "a URL, give it a schema for what we want extracted, and let "
        "it work.",
        BODY,
    ),
]

right = card(
    "What Skyvern handles for us",
    [
        Paragraph("• Visual element detection — no CSS selectors to "
                  "maintain", BODY),
        Paragraph("• CAPTCHA solving (many types)", BODY),
        Paragraph("• Multi-step navigation (disclaimers, search → "
                  "results → detail)", BODY),
        Paragraph("• Schema-validated extraction — the LLM is forced "
                  "into the shape we asked for", BODY),
        Paragraph("• Browser session reuse — polite to the same "
                  "portal across many rows", BODY),
    ],
    accent=ACCENT, bg=ACCENT_SOFT,
)

story.append(two_col(left, right))
story.append(PageBreak())

# ---------- SLIDE 12: OPS / RESILIENCE ----------
story += section_title(
    "08  ·  Operations & resilience",
    "Built to survive the things that go wrong in production",
)

ops = [
    ("Resumable per-row",
     "If the worker crashes mid-run, the next execution picks up "
     "exactly where the last one left off. Nothing is re-paid for, "
     "nothing is lost."),
    ("Polite same-portal queuing",
     "Rows on the same portal domain run sequentially, not in "
     "parallel. We never hammer a county tax office."),
    ("Cancel-on-the-spot",
     "Hit cancel in the UI → in-flight Skyvern tasks abort within "
     "five seconds. No waiting out an 8-minute scrape."),
    ("Browser session reaping",
     "Crashed runs are detected at startup and their orphaned "
     "browser sessions are closed before any new ones open — keeps "
     "us under Skyvern's session cap."),
    ("Service-account isolation",
     "The frontend never touches Firestore directly; all writes "
     "go through server-side API routes. Security rules deny "
     "everything by default."),
    ("Append-history, never overwrite",
     "Every property has a history sub-collection in Firestore. "
     "Past run results are queryable forever."),
]

ops_cells = []
for title, body in ops:
    ops_cells.append([
        Paragraph(f"<b>{title}</b>",
                  ParagraphStyle("OT", parent=BODY,
                                 fontName="Helvetica-Bold",
                                 fontSize=11.5, leading=14,
                                 textColor=ACCENT)),
        Paragraph(body, ParagraphStyle("OB", parent=BODY,
                                       fontSize=10.5, leading=14)),
    ])
ops_t = Table(ops_cells, colWidths=[2.7 * inch, 7.05 * inch])
ops_t.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 11),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 11),
]))
story.append(ops_t)
story.append(PageBreak())

# ---------- SLIDE 13: INTERESTING DETAILS ----------
story += section_title(
    "09  ·  Things that make this fun",
    "Edge cases nobody thinks about until they break you",
)

deets = [
    ("Florida row 4 has THREE accounts in one cell",
     "<font color='#525252'>"
     "<font face='Courier'>#T815151/#T813795/#R444958</font> — "
     "we split, look each up, and only mark the row PAID if "
     "<i>all three</i> are paid.</font>"),
    ("4% discount in November is not a partial payment",
     "<font color='#525252'>Florida gives a 4%/3%/2%/1% early-pay "
     "discount by month. A property that paid $4,974 of a $5,128 bill "
     "in December isn't delinquent — it's smart. Our validation "
     "rules know this.</font>"),
    ("'2025 bill paid 03/2026' is normal",
     "<font color='#525252'>Florida bills are payable through March of "
     "the following year. Texas, California, and every other state "
     "have their own calendar. The system knows the rules per state.</font>"),
    ("Tangible vs real estate is not the same parcel",
     "<font color='#525252'>One Pontus URL decodes to "
     "<font face='Courier'>charlotte:tangible:&lt;uuid&gt;</font> — "
     "personal property tax, not real estate. The same address can "
     "have both rolls. We pick the right one.</font>"),
    ("Recently-acquired properties show the seller's name",
     "<font color='#525252'>Counties don't update owner records "
     "instantly. If owner doesn't match but parcel AND address both "
     "match, we proceed with medium confidence and flag the owner "
     "mismatch in the evidence trail.</font>"),
    ("'Total Payable: $0.00' isn't proof of payment",
     "<font color='#525252'>It means no current balance — the actual "
     "receipt usually hides in a collapsed 'Recently Paid Bills' "
     "section. We expand it. (Or in fast-mode, we just record PAID "
     "and move on — that's the user's call.)</font>"),
]

for t, b in deets:
    story.append(Paragraph(
        f"<b>{t}</b>",
        ParagraphStyle("DT", parent=BODY, fontName="Helvetica-Bold",
                       fontSize=11.5, leading=15, spaceAfter=2,
                       textColor=ACCENT)))
    story.append(Paragraph(b, ParagraphStyle("DB", parent=BODY,
                                             fontSize=10.5, leading=14,
                                             spaceAfter=10)))

story.append(PageBreak())

# ---------- SLIDE 14: WHAT'S NEXT ----------
story += section_title("10  ·  What's next", "Roadmap")

roadmap = [
    ("Live dashboard view",
     "Today the output is Excel. Next: a real-time portfolio view "
     "in the web app, with status badges and per-property history "
     "charts pulled straight from Firestore."),
    ("Scheduled refresh",
     "A daily Cloud Function that re-runs the latest workbook "
     "automatically and emails a diff: who became delinquent, who "
     "paid, what changed."),
    ("Appeals & assessment monitoring",
     "Same engine, different schema — track assessed value over time "
     "and flag opportunities to appeal."),
    ("Coverage expansion",
     "Each new state adds a few county playbook entries. The system "
     "is designed to handle 'never seen this before' on day one — "
     "every new portal we meet writes its own playbook."),
    ("Tighter integrations",
     "Slack alert when a property goes delinquent. Webhook into the "
     "accounting system to reconcile payments automatically."),
]

rm_rows = []
for t, b in roadmap:
    rm_rows.append([
        Paragraph(f"<b>{t}</b>",
                  ParagraphStyle("RT", parent=BODY,
                                 fontName="Helvetica-Bold",
                                 fontSize=12, leading=15,
                                 textColor=ACCENT)),
        Paragraph(b, ParagraphStyle("RB", parent=BODY,
                                    fontSize=11, leading=15)),
    ])
rt = Table(rm_rows, colWidths=[2.7 * inch, 7.05 * inch])
rt.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 12),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
]))
story.append(rt)
story.append(PageBreak())

# ---------- SLIDE 15: CLOSING ----------
story += section_title("In one slide", "Why this matters")

closing = [
    Paragraph(
        "Property tax tracking has been the kind of work that "
        "<i>has to be done</i> but nobody has time for. The portals "
        "are fragmented, the data ages fast, and the consequences of "
        "missing a delinquency are real money in penalties.",
        BODY,
    ),
    Paragraph(
        "This tool turns the loop — <b>open URL, find property, read "
        "balance, type into spreadsheet</b> — from analyst hours into "
        "an upload and a download.",
        BODY,
    ),
    Paragraph(
        "It's <b>generic across every state</b>. It's <b>safe by "
        "construction</b>: read-only on the portals, deny-by-default "
        "on the database, no silent erasure of existing data, and a "
        "confidence model on every row.",
        BODY,
    ),
    Paragraph(
        "And it <b>gets smarter with every run</b> — each new vendor "
        "portal we see adds a playbook entry that future runs reuse.",
        BODY,
    ),
    Spacer(1, 0.15 * inch),
    Paragraph(
        "<font color='#2563eb'><b>One Excel file in. The same file, "
        "answered, out.</b></font>",
        ParagraphStyle("Final", parent=BODY,
                       fontName="Helvetica-Bold",
                       fontSize=16, leading=20,
                       textColor=ACCENT),
    ),
]
for f in closing:
    story.append(f)

story.append(PageBreak())

# ---------- SLIDE 16: APPENDIX ----------
story += section_title("Appendix", "Where things live")

ap = [
    ("Code repo", "Local: New Tax Project/ — Next.js at root, Python "
        "worker under <font face='Courier'>worker/</font>."),
    ("Live site", "Vercel project <font face='Courier'>tax-project-qso5"
        "</font> (env vars marked Sensitive)."),
    ("Firebase", "Project <font face='Courier'>pontustax</font> "
        "(Blaze tier). Bucket "
        "<font face='Courier'>pontustax.firebasestorage.app</font>."),
    ("Cloud Run job", "<font face='Courier'>tax-checker-worker</font> "
        "— deployed via <font face='Courier'>gcloud run jobs deploy "
        "--source worker</font>."),
    ("Skyvern", "Cloud account, ~10 concurrent portals configured "
        "(effective ceiling is plan-dependent)."),
    ("Tests", "36 tests on synthetic workbook + dry-run pipeline "
        "(<font face='Courier'>npm run worker:test</font>)."),
]

ap_rows = []
for k, v in ap:
    ap_rows.append([
        Paragraph(f"<b>{k}</b>",
                  ParagraphStyle("APK", parent=BODY,
                                 fontName="Helvetica-Bold",
                                 fontSize=11, leading=14)),
        Paragraph(v, ParagraphStyle("APV", parent=BODY,
                                    fontSize=10.5, leading=14)),
    ])
apt = Table(ap_rows, colWidths=[1.7 * inch, 8.05 * inch])
apt.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 10),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
]))
story.append(apt)

# ----------------------------------------------------------------------
# Build the document with a cover-page template + content template
# ----------------------------------------------------------------------

doc = BaseDocTemplate(
    OUT,
    pagesize=landscape(LETTER),
    leftMargin=MARGIN, rightMargin=MARGIN,
    topMargin=0.7 * inch, bottomMargin=0.75 * inch,
    title="Pontus Property Tax Checker",
    author="Nicholas Revenco, Pontus Capital",
)

cover_frame = Frame(
    MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN,
    id="cover", showBoundary=0,
)
content_frame = Frame(
    MARGIN, 0.75 * inch,
    PAGE_W - 2 * MARGIN, PAGE_H - 1.5 * inch,
    id="content", showBoundary=0,
)

doc.addPageTemplates([
    PageTemplate(id="Cover", frames=[cover_frame], onPage=title_page),
    PageTemplate(id="Content", frames=[content_frame], onPage=page_chrome),
])

# Switch to content template after the cover
from reportlab.platypus import NextPageTemplate
story.insert(0, NextPageTemplate("Cover"))
# After cover's PageBreak (which lives after the cover content), switch:
# We need to insert NextPageTemplate("Content") right before the first
# PageBreak — simplest is to do it right after the cover stats.
# The cover is index 0..N; let's find first PageBreak and insert before it.
# story[0] is NextPageTemplate("Cover"). Insert NextPageTemplate("Content")
# right before the first PageBreak.
for i, item in enumerate(story):
    if isinstance(item, PageBreak):
        story.insert(i, NextPageTemplate("Content"))
        break

doc.build(story)
print(f"Wrote {OUT}")
