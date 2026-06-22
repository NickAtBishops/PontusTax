"""Build the in-depth Pontus Property Tax Checker technical report PDF.

Portrait Letter, multi-page, body-text first, with code listings and
sidebars. Read like a real engineering memo — not a slide deck.
"""

from __future__ import annotations

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT, TA_JUSTIFY
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
    KeepTogether,
)

OUT = (
    "/Users/nicholasrevencomacbookair/Desktop/Pontus Capital/"
    "Pontus Projects/New Tax Project/"
    "Pontus_Tax_Checker_Technical_Report.pdf"
)

# Palette
INK = HexColor("#0a0a0a")
MUTED = HexColor("#525252")
LINE = HexColor("#e5e5e5")
LINE_SOFT = HexColor("#f1f5f9")
ACCENT = HexColor("#2563eb")
ACCENT_SOFT = HexColor("#eff6ff")
CODE_BG = HexColor("#f5f5f5")
SIDEBAR_BG = HexColor("#fffbeb")
SIDEBAR_BORDER = HexColor("#fbbf24")

PAGE_W, PAGE_H = LETTER
MARGIN = 0.85 * inch

styles = getSampleStyleSheet()

# --- Text styles ---
H1 = ParagraphStyle(
    "H1", parent=styles["Heading1"], fontName="Helvetica-Bold",
    fontSize=20, leading=24, textColor=INK,
    spaceBefore=18, spaceAfter=10,
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
BODY = ParagraphStyle(
    "Body", parent=styles["Normal"], fontName="Helvetica",
    fontSize=10.5, leading=15, textColor=INK,
    spaceAfter=8, alignment=TA_JUSTIFY,
)
BODY_LEFT = ParagraphStyle(
    "BodyLeft", parent=BODY, alignment=TA_LEFT,
)
BULLET = ParagraphStyle(
    "Bullet", parent=BODY, leftIndent=16, bulletIndent=4, spaceAfter=4,
    alignment=TA_LEFT,
)
SMALL = ParagraphStyle(
    "Small", parent=styles["Normal"], fontName="Helvetica",
    fontSize=8.5, leading=11, textColor=MUTED, alignment=TA_LEFT,
)
CAPTION = ParagraphStyle(
    "Caption", parent=SMALL, fontName="Helvetica-Oblique",
)
CODE = ParagraphStyle(
    "Code", parent=styles["Normal"], fontName="Courier",
    fontSize=8.5, leading=11.5, textColor=INK,
    leftIndent=8, rightIndent=8, spaceBefore=2, spaceAfter=2,
)
SIDE = ParagraphStyle(
    "Side", parent=BODY, fontSize=9.5, leading=13,
    textColor=INK, alignment=TA_LEFT, spaceAfter=4,
)
COVER_TITLE = ParagraphStyle(
    "CT", parent=styles["Title"], fontName="Helvetica-Bold",
    fontSize=34, leading=38, textColor=INK, alignment=TA_LEFT, spaceAfter=8,
)
COVER_SUB = ParagraphStyle(
    "CS", parent=BODY, fontSize=14, leading=20, textColor=MUTED,
    alignment=TA_LEFT, spaceAfter=4,
)

# --- Helpers ---

def code_block(code: str, caption: str | None = None):
    pre = Preformatted(code, CODE)
    t = Table([[pre]], colWidths=[PAGE_W - 2 * MARGIN])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODE_BG),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LINEBEFORE", (0, 0), (-1, -1), 3, ACCENT),
    ]))
    flow = [t]
    if caption:
        flow.append(Spacer(1, 2))
        flow.append(Paragraph(caption, CAPTION))
        flow.append(Spacer(1, 4))
    return KeepTogether(flow)


def sidebar(title: str, body_paragraphs):
    inner = [Paragraph(f"<b>{title}</b>",
                       ParagraphStyle("SH", parent=BODY,
                                      fontName="Helvetica-Bold",
                                      fontSize=10.5, leading=13,
                                      textColor=HexColor("#92400e"),
                                      spaceAfter=4))]
    inner += body_paragraphs
    t = Table([[inner]], colWidths=[PAGE_W - 2 * MARGIN])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SIDEBAR_BG),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("LINEBEFORE", (0, 0), (-1, -1), 3, SIDEBAR_BORDER),
    ]))
    return KeepTogether(t)


def bullets(items):
    return [Paragraph(f"•&nbsp;&nbsp;{it}", BULLET) for it in items]


# ----------------------------------------------------------------------
# Chrome
# ----------------------------------------------------------------------

def cover_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(ACCENT)
    canvas.rect(0, 0, 0.22 * inch, PAGE_H, fill=1, stroke=0)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.setFillColor(ACCENT)
    canvas.drawString(MARGIN, PAGE_H - 0.75 * inch,
                      "PONTUS  ·  INTERNAL TECHNICAL REPORT")
    canvas.setFont("Helvetica", 8.5)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 0.75 * inch,
                           "June 2026  ·  Revision 1")
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
                      "PONTUS PROPERTY TAX CHECKER  ·  TECHNICAL REPORT")
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


# ----------------------------------------------------------------------
# Content
# ----------------------------------------------------------------------

story = []

# ========================== COVER ==========================
story.append(Spacer(1, 2.0 * inch))
story.append(Paragraph("Pontus Property Tax Checker", COVER_TITLE))
story.append(Paragraph("Technical Report", ParagraphStyle(
    "CT2", parent=COVER_TITLE, fontSize=22, textColor=ACCENT, leading=26,
    spaceAfter=18)))
story.append(Spacer(1, 0.1 * inch))
story.append(Paragraph(
    "An end-to-end walkthrough of every moving part: how the Next.js "
    "frontend on Vercel hands a workbook off to a Python worker running "
    "on Google Cloud Run, how that worker uses Skyvern's vision-based "
    "AI to drive any county tax portal, how Firestore keeps state "
    "consistent across restarts, and how the original Excel file ends "
    "up back in the user's hands — answered.",
    COVER_SUB))
story.append(Spacer(1, 0.6 * inch))

cover_meta = Table([
    [Paragraph("<b>Authors</b>", BODY), Paragraph("Nicholas Revenco", BODY)],
    [Paragraph("<b>Audience</b>", BODY),
     Paragraph("Engineers and stakeholders who want to understand the "
               "system end-to-end", BODY)],
    [Paragraph("<b>Repository</b>", BODY),
     Paragraph("New Tax Project (Pontus Capital, internal)", BODY)],
    [Paragraph("<b>Status</b>", BODY),
     Paragraph("Production — first full pipeline shipped 2026-06-10", BODY)],
], colWidths=[1.4 * inch, 5.0 * inch])
cover_meta.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
]))
story.append(cover_meta)

story.append(PageBreak())

# ========================== TOC ==========================
story.append(Paragraph("Contents", H1))
toc_items = [
    ("1.", "Executive summary", "the one-paragraph version"),
    ("2.", "The user's journey", "what happens between Upload and Download"),
    ("3.", "The frontend & API layer (Next.js + Vercel)",
     "how a click becomes a queued run"),
    ("4.", "The Firebase data model",
     "Firestore collections, the queue, security rules"),
    ("5.", "The Cloud Run worker — entrypoint & main loop",
     "how it claims work and drains the queue"),
    ("6.", "The Python engine, module by module",
     "intake, identifiers, taxonomy, prompts, schema, runner, "
     "verify, validate, writeback"),
    ("7.", "Skyvern in depth",
     "vision-based browser AI, browser sessions, polite queuing, "
     "request payload, cancel mechanics"),
    ("8.", "The queue & lifecycle in detail",
     "state machine, on-the-spot cancel, retry, orphan reaping"),
    ("9.", "Safety, validation, and confidence",
     "the rules that decide what reaches a spreadsheet cell"),
    ("10.", "Failure modes & how each is handled",
     "the production realities"),
    ("11.", "Cost model & operational ceilings",
     "what we pay, where the limits are"),
    ("12.", "Appendix",
     "deployment commands, environment variables, file map"),
]
toc_rows = []
for n, t, d in toc_items:
    toc_rows.append([
        Paragraph(f"<font color='#2563eb'><b>{n}</b></font>",
                  ParagraphStyle("TN", parent=BODY,
                                 fontName="Helvetica-Bold",
                                 fontSize=11)),
        Paragraph(f"<b>{t}</b><br/>"
                  f"<font color='#525252'>{d}</font>",
                  ParagraphStyle("TT", parent=BODY, fontSize=11,
                                 leading=14)),
    ])
toc = Table(toc_rows, colWidths=[0.6 * inch, 6.0 * inch])
toc.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ("TOPPADDING", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
]))
story.append(toc)
story.append(PageBreak())

# ========================== §1 EXECUTIVE SUMMARY ==========================
story.append(Paragraph("1.  Executive summary", H1))
story.append(Paragraph(
    "The Pontus Property Tax Checker is an internal web tool that takes "
    "an Excel property-tax tracker, looks up the current tax status of "
    "every property in it across whichever county portal that property "
    "uses, and returns the same Excel file with the answers filled in. "
    "It is built to work for any U.S. state, any county, any portal — "
    "including portals nobody has seen before — because Pontus owns "
    "real estate across 15+ states and at least a dozen different "
    "portal vendors.",
    BODY))
story.append(Paragraph(
    "There are three things to know about the architecture before "
    "going any further. First, the system is a <b>pipeline of queues</b>: "
    "the user uploads a file, that creates a queued run in Firestore, "
    "a Google Cloud Run job claims it, processes it, and writes the "
    "result back. Second, the actual portal navigation is done by "
    "<b>Skyvern</b>, a vision-based browser AI we drive through an HTTP "
    "API — we never write CSS selectors or XPath, we just describe in "
    "English what we want and hand over a JSON schema. Third, every "
    "layer in this stack — Vercel, Firebase, Cloud Run, Skyvern — is "
    "pay-as-you-go and managed; we operate no servers of our own.",
    BODY))
story.append(Paragraph(
    "What follows is an end-to-end map of how a single upload moves "
    "through the system, with citations into the actual code paths so "
    "the reader can verify any claim. The report is written for "
    "engineers who will eventually own or extend the codebase. It is "
    "also written for non-engineering stakeholders who want to "
    "understand what they are looking at — every section opens with a "
    "plain-language overview before drilling down.",
    BODY))

story.append(Paragraph("The seven pieces", H2))
arch_table = [
    ["Layer", "Tech", "Where it runs", "Role"],
    ["Frontend dashboard", "Next.js 16, Tailwind, shadcn/ui",
     "Vercel", "Upload, watch progress, download"],
    ["API routes", "Next.js route handlers (Node runtime)",
     "Vercel", "Upload validation, signed URLs, cancel/retry"],
    ["Database & queue", "Firestore", "Firebase",
     "Run state, row outcomes, playbook library"],
    ["File store", "Cloud Storage", "Firebase Storage",
     "Input uploads + processed output workbooks"],
    ["Worker", "Python 3.12, asyncio", "Google Cloud Run Job",
     "Orchestration, intake, verify, writeback"],
    ["Browser AI", "Skyvern SDK + Skyvern cloud",
     "Skyvern's infrastructure",
     "Drives every county portal"],
    ["Adjudicator (optional)", "Anthropic Claude (tool use)",
     "Anthropic API",
     "Tie-breaks owner/address fuzziness"],
]
at = Table(arch_table, colWidths=[1.3 * inch, 1.8 * inch,
                                   1.4 * inch, 2.2 * inch])
at.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("FONT", (0, 1), (-1, -1), "Helvetica", 9.5),
    ("FONT", (0, 1), (0, -1), "Helvetica-Bold", 9.5),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
]))
story.append(at)

story.append(PageBreak())

# ========================== §2 USER JOURNEY ==========================
story.append(Paragraph("2.  The user's journey", H1))
story.append(Paragraph(
    "Before going into the architecture in detail, here is the same "
    "flow described as a story — what actually happens when an analyst "
    "drops a workbook onto the page.",
    BODY))

journey = [
    ("The user opens the dashboard at the Vercel-hosted URL.",
     "The page is public — there is no login. (Auth was deliberately "
     "removed on 2026-06-11; the dashboard reads run progress directly "
     "from Firestore via the browser client SDK using deny-by-default "
     "rules that allow reads on the run collection only.)"),
    ("They drop an Excel file onto the upload box and click Start.",
     "The browser POSTs a multipart form to <font face='Courier'>"
     "/api/runs</font>. The Next.js route handler validates the file "
     "(must be .xlsx, ≤ 4 MB), saves it to Cloud Storage at "
     "<font face='Courier'>tax_checker/uploads/&lt;runId&gt;/&lt;name&gt;"
     "</font>, creates a <font face='Courier'>tax_checker_runs"
     "</font> document with status <i>queued</i>, then fires one "
     "execution of the Cloud Run Job."),
    ("Within a few seconds the dashboard shows the run as 'running'.",
     "The Cloud Run Job has woken up and called <font face='Courier'>"
     "claim_next_queued()</font> — a Firestore transaction that flips "
     "the oldest queued run from <i>queued</i> to <i>running</i>. "
     "The worker downloads the workbook to a temp dir and starts "
     "parsing it."),
    ("Header detection runs. Per-row counts appear in the totals.",
     "The intake module finds the header row by content, not column "
     "letter. It writes one row document per property under <font "
     "face='Courier'>tax_checker_runs/{runId}/rows/{rowKey}</font> with "
     "<font face='Courier'>state: pending</font>, and a parallel "
     "<font face='Courier'>tax_checker_scrape_state</font> document "
     "with a deterministic ID so the run is resumable."),
    ("The worker groups rows by portal domain and starts browsers.",
     "Rows that share a portal (e.g. five Broward County properties) "
     "are processed sequentially on one shared Skyvern browser "
     "session, with polite delays between requests. Distinct portals "
     "run concurrently — up to <font face='Courier'>MAX_CONCURRENCY"
     "</font> at a time."),
    ("For each property, Skyvern opens the portal, finds the account, "
     "reads the balance, and returns structured JSON.",
     "The worker hands Skyvern a URL, an English prompt, and a JSON "
     "extraction schema. Skyvern's vision model navigates the page, "
     "fills out the search box, clicks through results, reads the "
     "amount due, and returns a typed answer."),
    ("The worker verifies that the page actually matches the property, "
     "validates the answer, and writes a row outcome.",
     "Fuzzy address/owner/parcel matching runs locally; if it's a tie, "
     "an optional Claude call adjudicates. The outcome is saved to "
     "Firestore. Run-level totals (counters per status, sum of "
     "amounts owed) update incrementally."),
    ("When every row is done, the worker enters the write-back phase.",
     "openpyxl opens the original workbook, fills in the canonical "
     "columns (Amount Owed, Date Paid, Receipt) and a NEW column "
     "named like <i>'June 2026 Update'</i> following the workbook's "
     "own naming pattern. Formulas, merged cells, formatting, "
     "hyperlinks all preserved."),
    ("The processed workbook is uploaded to Cloud Storage.",
     "Path: <font face='Courier'>tax_checker/outputs/&lt;runId&gt;/"
     "&lt;name — checked YYYY-MM-DD.xlsx&gt;</font>. The run is marked "
     "<i>done</i> (or <i>done_with_errors</i> if any rows need review)."),
    ("The dashboard's Download button lights up.",
     "Clicking it hits <font face='Courier'>/api/runs/&lt;id&gt;/download"
     "</font>, which generates a v4 signed URL valid for 1 hour and "
     "redirects the browser to it. The user gets their answered Excel "
     "file back."),
]

j_rows = []
for i, (head, body) in enumerate(journey, 1):
    j_rows.append([
        Paragraph(f"<font color='#2563eb'><b>{i:02d}</b></font>",
                  ParagraphStyle("JN", parent=BODY,
                                 fontName="Helvetica-Bold",
                                 fontSize=12, leading=15)),
        Paragraph(f"<b>{head}</b><br/><br/>"
                  f"<font color='#1f2937'>{body}</font>",
                  ParagraphStyle("JB", parent=BODY, fontSize=10,
                                 leading=14, alignment=TA_LEFT)),
    ])
jt = Table(j_rows, colWidths=[0.5 * inch, 6.1 * inch])
jt.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
]))
story.append(jt)

story.append(PageBreak())

# ========================== §3 FRONTEND/API ==========================
story.append(Paragraph("3.  The frontend & API layer", H1))
story.append(Paragraph(
    "The web app is a Next.js 16 application using the App Router and "
    "deployed to Vercel. It serves two purposes: a dashboard the user "
    "interacts with, and a set of API routes that act as a thin "
    "trusted shim between the browser and Firebase + Cloud Run.",
    BODY))

story.append(Paragraph("3.1  The dashboard", H2))
story.append(Paragraph(
    "The dashboard pages live under <font face='Courier'>app/</font>. "
    "They are largely server-rendered for the initial load, with one "
    "client component that subscribes to the Firestore <font "
    "face='Courier'>tax_checker_runs</font> collection via "
    "<font face='Courier'>onSnapshot</font> so progress updates appear "
    "in real time without polling. There is no authentication — a "
    "deliberate decision recorded in CLAUDE.md §12 — so anyone with the "
    "URL can use the tool. This trade was accepted because the tool is "
    "internal and the URL is private; raising the trade if it ever "
    "becomes a public tool is the right move.",
    BODY))

story.append(Paragraph("3.2  The API routes", H2))
story.append(Paragraph(
    "There are five route handlers, all under <font face='Courier'>"
    "app/api/runs/</font>. Every one uses the Firebase Admin SDK "
    "(server-side, bypassing security rules) — never the client SDK.",
    BODY))

api_table = [
    ["Method", "Route", "What it does"],
    ["GET", "/api/runs", "List the 100 newest runs, newest first."],
    ["POST", "/api/runs",
     "Accept multipart upload. Validate (.xlsx, ≤ 4 MB). "
     "Save to Cloud Storage. Create the run doc with status 'queued'. "
     "Trigger one Cloud Run job execution."],
    ["GET", "/api/runs/[id]", "Fetch a single run with its child rows."],
    ["POST", "/api/runs/[id]/cancel",
     "Flip cancel_requested = true. If the run is still queued, "
     "finalize immediately to 'canceled' — there is no worker holding "
     "it. If running, the worker's cancel watcher (see §7) will see "
     "the flag within ~5 s and abort in-flight Skyvern tasks."],
    ["GET", "/api/runs/[id]/download",
     "Generate a v4 signed URL on the output_path blob, valid for 1 hr, "
     "return it as JSON."],
    ["POST", "/api/runs/[id]/retry",
     "Reset every scrape_state doc in {failed, in_progress, pending} "
     "(plus 'done + UNREACHABLE') to 'pending', flip the run back to "
     "'queued', clear errors, fire a new Cloud Run execution."],
]
apt = Table(api_table, colWidths=[0.7 * inch, 1.7 * inch, 4.3 * inch])
apt.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("FONT", (0, 1), (1, -1), "Courier", 9),
    ("FONT", (2, 1), (2, -1), "Helvetica", 9.5),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 5),
    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
]))
story.append(apt)

story.append(Paragraph("3.3  How the upload triggers the worker", H2))
story.append(Paragraph(
    "This is the single most important integration point in the whole "
    "system, so it deserves a close look. The POST handler at <font "
    "face='Courier'>app/api/runs/route.ts</font> calls "
    "<font face='Courier'>triggerWorker()</font> (in "
    "<font face='Courier'>lib/cloud-run.ts</font>), which authenticates "
    "as the service account and hits Google's Cloud Run REST API:",
    BODY))

story.append(code_block(
    """const auth = new GoogleAuth({
  credentials,                       // the Firebase service account
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const client = await auth.getClient();
const url =
  `https://run.googleapis.com/v2/projects/${project}` +
  `/locations/${region}/jobs/${job}:run`;
await client.request({ url, method: "POST", data: {} });""",
    caption="lib/cloud-run.ts — triggerWorker() (abridged)",
))
story.append(Paragraph(
    "Note that the POST body is empty. The worker isn't told which run "
    "to process. Instead, when it wakes up, it queries Firestore for "
    "the oldest queued run and claims it transactionally. This design "
    "has two benefits: it lets us trigger the job with a basic <font "
    "face='Courier'>roles/run.invoker</font> permission (no override-"
    "passing required), and it lets the worker drain a backlog if "
    "several runs queue up before it starts — see §5.",
    BODY))

story.append(PageBreak())

# ========================== §4 FIREBASE ==========================
story.append(Paragraph("4.  The Firebase data model", H1))
story.append(Paragraph(
    "Firestore is a NoSQL document store, not a relational database. "
    "There are no migrations, no joins, no schemas enforced at the "
    "database level — shape is enforced in code and in security rules. "
    "Pontus's tooling standard puts every tool's data under one "
    "top-level collection prefix; the tax checker uses three such "
    "prefixes.",
    BODY))

story.append(Paragraph("4.1  The collections", H2))
coll_table = [
    ["Collection", "Document shape"],
    ["tax_checker_runs/{runId}",
     "One per upload. Holds status, file name, paths in Cloud "
     "Storage, totals counters (paid/unpaid/delinquent/etc.), "
     "the cancel_requested flag, sheets metadata, and the summary."],
    ["tax_checker_runs/{runId}/rows/{rowKey}",
     "One per property row. rowKey is zero-padded (s00_r0003) so "
     "Firestore's documentId() sort order matches sheet/row order. "
     "Holds the input data, the resulting accounts, status, "
     "evidence trail, Skyvern run IDs, and the values to write back."],
    ["tax_checker_runs/{runId}/events/{auto}",
     "Append-only log. Level/message/optional row_key/timestamp. "
     "Logging failures must never break a run."],
    ["tax_checker_playbooks/{vendorKey}",
     "Vendor playbook library. Seeded with code-versioned entries on "
     "every run; new ones get added at runtime (§4.7 in CLAUDE.md)."],
    ["tax_checker_scrape_state/{job__run__row}",
     "Per-row resume state. Deterministic ID 'tax_check__<runId>__"
     "<rowKey>' makes the doc upsert-friendly, so a re-run never "
     "duplicates rows."],
]
ct = Table(coll_table, colWidths=[2.4 * inch, 4.3 * inch])
ct.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("FONT", (0, 1), (0, -1), "Courier", 8.5),
    ("FONT", (1, 1), (-1, -1), "Helvetica", 9.5),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.append(ct)

story.append(Paragraph("4.2  The row document shape", H2))
story.append(Paragraph(
    "When intake plans a row, it writes a document like this:",
    BODY))
story.append(code_block(
    """{
  "id":          "s00_r0003",
  "run_id":      "<runId>",
  "sheet_name":  "Florida Prop Tax",
  "row_number":  5,
  "state":       "pending",
  "input": {
    "address": "...", "city": "...", "state": "FL", "zip": "...",
    "county": "Broward", "owner_entity": "PONTUS EHC PALM BEACH LLC",
    "internal_id": "VP4601", "account_raw": "504201020010",
    "accounts": ["504201020010"], "tax_year": "2025",
    "url": "https://broward.county-taxes.net/...",
    "responsible_party": "..."
  },
  "accounts": [], "row_status": null, "status_note": null,
  "confidence": null, "evidence": null, "needs_review_reason": null,
  "skyvern": null, "writes": null,
  "created_at": <ts>, "updated_at": <ts>
}""",
    caption="A row document in tax_checker_runs/{runId}/rows/",
))
story.append(Paragraph(
    "The row goes through three writes during processing: <font "
    "face='Courier'>state: 'pending'</font> at intake, then <font "
    "face='Courier'>'in_progress'</font> when a worker starts on it, "
    "then a final write with the outcome (status, evidence, the "
    "writes block, the Skyvern run IDs and recording URLs).",
    BODY))

story.append(Paragraph("4.3  Security rules", H2))
story.append(Paragraph(
    "Firestore is configured deny-by-default. Three explicit allow "
    "rules grant read access to the dashboard (no auth required) and "
    "block all client writes. The Admin SDK on the server bypasses "
    "rules entirely.",
    BODY))
story.append(code_block(
    """match /tax_checker_runs/{runId} {
  allow read: if true;
  allow write: if false;
  match /rows/{rowId}   { allow read: if true; allow write: if false; }
  match /events/{eventId} { allow read: if true; allow write: if false; }
}
match /tax_checker_playbooks/{vendorId} {
  allow read: if true; allow write: if false;
}
match /tax_checker_scrape_state/{stateId} {
  allow read, write: if false;     // worker-internal
}""",
    caption="firestore.rules — public reads, server-only writes",
))

story.append(Paragraph("4.4  No composite indexes — by design", H2))
story.append(Paragraph(
    "The default Firestore behavior is that any query filtering on one "
    "field and ordering on another needs a manually-defined composite "
    "index. We deliberately avoid this: every Firestore query in the "
    "worker is single-field, and any further filtering happens in "
    "Python. <font face='Courier'>pending_keys()</font> in "
    "<font face='Courier'>store.py</font> is the canonical example — "
    "it queries by run_id, then filters by status in code.",
    BODY))

story.append(PageBreak())

# ========================== §5 CLOUD RUN WORKER ==========================
story.append(Paragraph("5.  The Cloud Run worker — entrypoint & main loop",
                       H1))
story.append(Paragraph(
    "The worker is a Python 3.12 container deployed as a Google Cloud "
    "Run <i>Job</i> (not a Cloud Run Service — a Job runs to "
    "completion, doesn't listen on a port, and is the right model for "
    "batch work). Its entrypoint is <font face='Courier'>worker/main.py"
    "</font>.",
    BODY))

story.append(Paragraph("5.1  Three modes of operation", H2))
story.extend(bullets([
    "<b>Cloud Run trigger (no args)</b> — drain the queue. Loop: "
    "claim the next queued run, process it, repeat until the queue "
    "is empty.",
    "<b><font face='Courier'>--run-id &lt;id&gt;</font></b> — process "
    "exactly that run. Used by manual reprocessing.",
    "<b><font face='Courier'>--local-xlsx file.xlsx [--dry-run]</font>"
    "</b> — no cloud involved at all. Parse the workbook locally, "
    "optionally skip portal calls. This is how the test suite runs.",
]))

story.append(Paragraph("5.2  The drain loop", H2))
story.append(code_block(
    """processed = 0
while True:
    run_id = claim_next_queued(cfg)
    if run_id is None:
        log.info("queue drained — %d run(s) processed", processed)
        return 0
    processed += 1
    _run_once(FirestoreStore(cfg, run_id), cfg, args)""",
    caption="worker/main.py — the argument-free drain loop",
))
story.append(Paragraph(
    "Two safety properties matter here. A run that crashes is marked "
    "<i>failed</i> (not re-queued) so the loop can never spin on a bad "
    "run. And executions are <b>globally serialized</b>: "
    "<font face='Courier'>claim_next_queued</font> first scans for any "
    "run currently in <i>running</i> or <i>writing_back</i> with a "
    "recent timestamp, and exits without claiming if one exists. This "
    "is critical because two simultaneous executions would stack "
    "browser sessions past Skyvern's plan cap.",
    BODY))

story.append(Paragraph("5.3  Claiming a run atomically", H2))
story.append(code_block(
    """snaps = db.collection(RUNS).where("status", "==", "queued").limit(10)
for snap in sorted_snaps:
    transaction = db.transaction()

    @firestore.transactional
    def _claim(tx, ref=snap.reference):
        doc = ref.get(transaction=tx)
        if not doc.exists or doc.get("status") != "queued":
            return False
        tx.update(ref, {
            "status": "running",
            "started_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
        return True

    if _claim(transaction):
        return snap.id""",
    caption="store.py — claim_next_queued (abridged)",
))
story.append(Paragraph(
    "The transactional read-then-update guarantees no two executions "
    "can grab the same run, even in the (currently impossible) world "
    "where executions aren't serialized.",
    BODY))

story.append(PageBreak())

# ========================== §6 THE PYTHON ENGINE ==========================
story.append(Paragraph("6.  The Python engine, module by module", H1))
story.append(Paragraph(
    "The worker is organized as 13 cohesive modules under "
    "<font face='Courier'>worker/pontus_tax/</font>. Each module does "
    "one thing. The orchestrator wires them together. This section "
    "walks each in order of the data flow.",
    BODY))

story.append(Paragraph("6.1  intake.py — workbook → typed rows", H2))
story.append(Paragraph(
    "Workbooks come in arbitrary shapes. Florida has two stacked "
    "header rows (a group row and a field row); California has one. "
    "Column letters mean nothing across files. Intake therefore "
    "matches headers by <b>meaning</b>, using a synonym table:",
    BODY))
story.append(code_block(
    """SYNONYMS: list[tuple[str, list[str], bool]] = [
    ("internal_id",    ["pid"], True),
    ("account_number", ["account number", "account #", "account",
                        "acct", "parcel id", "parcel", "apn", "pin",
                        "folio", "schedule", "tax id"], False),
    ("address", ["property address", "address", "location", "situs"], False),
    ("county",  ["county", "parish", "borough", "taxing jurisdiction"], False),
    ("owner_entity", ["owner entity", "owner", "entity", "llc"], False),
    ...
    ("_numbered", ["early bird", "#1", "#2", "#3", "#4"], False),
]""",
    caption="intake.py — partial synonyms (3rd field: word-boundary match)",
))
story.append(Paragraph(
    "Some fields can map to several columns (a workbook can have four "
    "installment-amount columns and three monthly status notes). "
    "Ambiguous mappings are recorded and surfaced in the run summary. "
    "Cells that contain a formula are <b>protected</b> — if at least "
    "50% of the non-empty cells in a column are formulas, the whole "
    "column is treated as derived and never written to. This keeps "
    "the totals row's SUM formula intact while not freezing a normal "
    "data column where one stray cell happens to be a formula.",
    BODY))

story.append(Paragraph("6.2  identifiers.py — dirty IDs → ordered candidates",
                       H2))
story.append(Paragraph(
    "Account numbers and parcel IDs arrive ugly. A leading '#', stray "
    "dots, dashes, leading zeros, and — in Florida row 4 of the first "
    "real workbook — three account numbers concatenated with '/' "
    "separators. The identifiers module converts each cell into one or "
    "more AccountCandidates, each carrying an ordered list of variants "
    "to try.",
    BODY))
story.append(code_block(
    """def candidate_variants(raw: str) -> list[str]:
    base    = _strip_token(raw)
    no_dash = base.replace("-", "")
    no_sep  = re.sub(r"[.\\s\\-]", "", base)
    variants = [base, no_dash, no_sep]
    for v in (base, no_sep):
        if v.lstrip("0") and v.lstrip("0") != v:
            variants.append(v.lstrip("0"))
    if "/" in base:
        variants.append(base.split("/", 1)[0])
    return _dedup(variants)""",
    caption="identifiers.py — variant ordering",
))
story.append(Paragraph(
    "The matching function used at verification time also normalizes "
    "the page's parcel string the same way, so '504-2-01-02-0010', "
    "'504201020010', and '5042-01-02-0010' all compare equal.",
    BODY))

story.append(Paragraph("6.3  taxonomy.py — what kind of page is this?", H2))
story.append(Paragraph(
    "A URL is classified into one of seven taxonomy types (A–G in "
    "CLAUDE.md §4) before navigation. Classification is pure URL "
    "inspection — fast, deterministic, no LLM call — and the page may "
    "reclassify itself later via the extraction's <font face='Courier'>"
    "page_outcome</font> field.",
    BODY))
story.extend(bullets([
    "<b>Type A</b> — Direct account page. URL has a deep param "
    "(parcel/account/folio/apn) or a long opaque token in the path "
    "(Grant Street base64 deep links).",
    "<b>Type B</b> — Search form. Bare vendor root with no deep params.",
    "<b>Type C</b> — Multi-step (disclaimer or roll-type selector "
    "before search).",
    "<b>Type D</b> — Year-pinned. URL has <font face='Courier'>y=2025"
    "</font> or <font face='Courier'>taxyear=...</font>.",
    "<b>Type E</b> — Blocked (login wall / CAPTCHA / paywall) — "
    "detected on arrival from the page outcome, not the URL.",
    "<b>Type F</b> — PDF-only. The portal exposes the bill only as a "
    "downloadable file; the worker drops to a PDF download + parse path.",
    "<b>Type G</b> — Split assessor/collector. Assessor data on "
    "Beacon, payment data on the county tax office site.",
]))

story.append(Paragraph("6.4  playbooks.py — vendor-specific hints", H2))
story.append(Paragraph(
    "There are at most a few dozen portal vendors in the country. The "
    "playbook library is a Firestore-backed catalog of what we know "
    "about each one — URL patterns to recognize it, footer signatures "
    "(\"Powered by Grant Street Group\"), the default taxonomy, and "
    "prose hints that get spliced into the Skyvern prompt at run time. "
    "Seven seeds ship with the code:",
    BODY))
story.append(code_block(
    """grant_street            (county-taxes.net, BillExpress)
publicaccessnow         (PublicAccessNow)
ptaxweb_pacific_blue    (ptaxweb / Pacific Blue Software)
aumentum                (Aumentum Technologies)
tyler_technologies      (Tyler iTax / Eagle / EnerGov)
beacon_schneider        (Beacon / Schneider Geospatial)
devnet                  (DEVNET wEdge)
govtechtaxpro           (GovTech taxpro)""",
    caption="playbooks.py — SEED_PLAYBOOKS",
))
story.append(Paragraph(
    "When the worker meets an unrecognized vendor, it solves the page "
    "generically, calls <font face='Courier'>draft_playbook()</font> "
    "to construct a new entry, and writes it to the "
    "<font face='Courier'>tax_checker_playbooks</font> collection via "
    "<font face='Courier'>upsert_playbook()</font>. The library grows.",
    BODY))

story.append(Paragraph("6.5  prompts.py — what we say to Skyvern", H2))
story.append(Paragraph(
    "The prompt sent to Skyvern is built fresh per attempt by composing "
    "named blocks: a target description, hard rules, speed rules, the "
    "navigation path for the taxonomy type, optional vendor hints, and "
    "an optional multi-account note. The objective is deliberately "
    "narrow — <b>find one number</b>, the total amount still owed right "
    "now. This is the 'fast mode' decision documented in CLAUDE.md "
    "§12: receipts, payment history, per-year tables are explicitly "
    "out of scope.",
    BODY))
story.append(code_block(
    """OBJECTIVE
Read this county property-tax portal and find ONE number for the
target property: the TOTAL amount of property tax still owed right
now ($0.00 if everything is paid).

TARGET PROPERTY
  Address          : 1450 Industrial Pkwy, San Diego, CA 92126
  County           : San Diego, CA
  Owner entity     : PONTUS PROPERTIES IV LLC (county records may
                     mangle the spelling, or still show the
                     previous owner)
  This attempt uses: account_number = "504201020010"
  Same id, other formats: "5042-01-02-0010", "5042-1-2-10"

NAVIGATION — search portal
1. Search by the account_number: type "504201020010" into the
   matching box (account/parcel boxes beat address boxes; strip
   any '#'). Submit and wait for results.
2. If a results list appears, open the row matching the target
   (account exact, else street address, else owner). Several
   plausible rows and none clearly right -> ambiguous_multiple_matches.
3. Read the total amount due from the property's page.

BE FAST
- You need ONE number: the total still owed right now (all years
  combined, penalties included).
- Do NOT open payment history, receipts, per-year bill details,
  or any collapsed sections.

HARD RULES - never break these
- READ-ONLY. Never click 'Pay', 'Pay Now', 'Add to Cart',
  'Check Out', 'Enroll'. Never enter card/bank info. Never log
  in. Plain 'I agree' disclaimer pages are fine to accept.
- VERIFY before reading: the opened record must match the target
  (owner contains entity or 'PONTUS', or address/parcel matches).
- Do NOT guess. No figure found -> amount_due_now = null with the
  right page_outcome.""",
    caption="A reconstructed example of the prompt sent to Skyvern",
))

story.append(Paragraph("6.6  extraction_schema.py — the answer's shape", H2))
story.append(Paragraph(
    "Skyvern requires a JSON schema for its extracted output. The model "
    "is forced to produce output that validates against it — which is a "
    "much stronger guarantee than parsing free text. Our schema has "
    "seven fields:",
    BODY))
story.append(code_block(
    """{
  "page_outcome": "account_found" | "landed_on_search" |
                  "ambiguous_multiple_matches" | "no_matching_property" |
                  "login_required" | "blocked" | "pdf_only" | "error",
  "amount_due_now":           number | string | null,
  "includes_delinquency":     boolean | null,
  "owner_on_page":            string | null,
  "situs_address_on_page":    string | null,
  "parcel_or_account_on_page": string | null,
  "final_url":                string | null
}""",
    caption="extraction_schema.py — the fast-mode shape",
))
story.append(Paragraph(
    "The <font face='Courier'>page_outcome</font> enum is the worker's "
    "ground truth for what just happened. If Skyvern landed on a search "
    "page (a stale deep link), the worker knows to fall back. If the "
    "page required login or a CAPTCHA, the row becomes NEEDS_REVIEW. "
    "If <font face='Courier'>page_outcome</font> is "
    "<font face='Courier'>account_found</font>, the verification step "
    "runs.",
    BODY))

story.append(PageBreak())

# ========================== §7 SKYVERN ==========================
story.append(Paragraph("7.  Skyvern in depth", H1))
story.append(Paragraph(
    "Skyvern is a managed AI browser-automation product. We send it "
    "a URL, an English prompt, and a JSON extraction schema; it spins "
    "up a real browser, navigates with a vision-based model, and "
    "returns structured output. This section explains how it works "
    "and how we drive it.",
    BODY))

story.append(Paragraph("7.1  Why vision-based AI, not selector scraping", H2))
story.append(Paragraph(
    "Traditional scrapers (Playwright + BeautifulSoup) need CSS "
    "selectors or XPath. Five portals = five scripts; fifty portals = "
    "a maintenance nightmare. A label change on a county website "
    "breaks a selector. Skyvern works the way a person would: it "
    "screenshots the page, asks a vision model what to click, and "
    "clicks it. The same code that handles Grant Street handles "
    "Aumentum handles a portal nobody at Pontus has ever seen.",
    BODY))

story.append(Paragraph("7.2  Browser sessions per portal domain", H2))
story.append(Paragraph(
    "The worker reuses one Skyvern browser session per portal domain. "
    "All Broward rows share one Chrome instance, so the disclaimer "
    "page is accepted once and the search box is loaded once. The "
    "<font face='Courier'>SkyvernRunner</font> class manages this:",
    BODY))
story.append(code_block(
    """async def session_for(self, domain: str) -> str | None:
    if domain in self._sessions:
        return self._sessions[domain] or None
    client = self._sdk()
    for backoff in (None, 2, 5, 10):
        try:
            session = await client.create_browser_session(
                proxy_location=self.cfg.proxy_location
            )
            self._sessions[domain] = session.browser_session_id
            return session.browser_session_id
        except ApiError as exc:
            if exc.status_code is None or exc.status_code < 500:
                break        # not transient, give up
            if backoff: await asyncio.sleep(backoff)
    self._sessions[domain] = ""    # degrade to per-task ephemeral
    return None""",
    caption="skyvern_runner.py — session creation with 5xx backoff",
))
story.append(Paragraph(
    "Two important behaviors are encoded here: a transient 5xx (the "
    "session-creation endpoint occasionally returns 504 while "
    "Skyvern's pool warms up) is retried with backoff, and a final "
    "failure degrades to per-task ephemeral browsers rather than "
    "killing the run. Cleanup happens in two places: <font "
    "face='Courier'>close_all()</font> in the orchestrator's finally "
    "block at the clean end of a run, and <font face='Courier'>"
    "reap_orphaned_sessions()</font> at the start of every run as a "
    "backstop for hard crashes.",
    BODY))

story.append(sidebar(
    "Why reaping matters",
    [Paragraph(
        "Skyvern plans cap concurrent browser sessions. If the Cloud Run "
        "container is SIGKILL'd (OOM, the 6-hour timeout, or "
        "<font face='Courier'>gcloud run jobs executions cancel</font>), "
        "the <font face='Courier'>finally</font> block never runs and the "
        "sessions hang around on Skyvern's side until they time out. "
        "Because we serialize executions, anything still open at the "
        "start of a fresh run is necessarily orphaned and safe to close. "
        "The reaper calls <font face='Courier'>get_browser_sessions()"
        "</font> and shuts every one down before opening any new ones. "
        "Without this, three crashed runs in a row would put the org "
        "over the cap and the fourth run's rows would all come back "
        "UNREACHABLE.", SIDE)]
))

story.append(Paragraph("7.3  Polite per-domain queuing", H2))
story.append(Paragraph(
    "Rows on the same domain run strictly sequentially via per-domain "
    "asyncio locks, with a randomized delay between requests:",
    BODY))
story.append(code_block(
    """async def _polite_wait(self, domain: str) -> None:
    last = self._last_call.get(domain)
    if last is not None:
        delay = self.cfg.polite_delay * (0.75 + random.random() * 0.5)
        wait = last + delay - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
    self._last_call[domain] = time.monotonic()""",
    caption="skyvern_runner.py — randomized polite delay",
))
story.append(Paragraph(
    "Concurrency across <i>different</i> portals is bounded by "
    "<font face='Courier'>MAX_CONCURRENCY</font> (10 in production), "
    "but in practice the effective ceiling is the Skyvern plan's "
    "concurrent-session cap — around 2 on the current plan in our "
    "observations.",
    BODY))

story.append(Paragraph("7.4  The Skyvern call itself", H2))
story.append(code_block(
    """run = await client.run_task(
    url=url,
    prompt=prompt,
    data_extraction_schema=schema,
    engine=self.cfg.skyvern_engine,
    max_steps=self.cfg.max_steps,
    proxy_location=self.cfg.proxy_location,
    browser_session_id=session_id,   # if available
    wait_for_completion=True,
    timeout=self.cfg.attempt_timeout,
    title=title[:120],
)""",
    caption="skyvern_runner.py — run_attempt()",
))
story.append(Paragraph(
    "<font face='Courier'>wait_for_completion=True</font> means the SDK "
    "blocks the coroutine until Skyvern reports terminal status. The "
    "result object carries <font face='Courier'>status</font>, "
    "<font face='Courier'>output</font> (the validated schema), the "
    "Skyvern <font face='Courier'>run_id</font>, a "
    "<font face='Courier'>recording_url</font> (a video of the actual "
    "browser session that we save in the row doc for audit), an "
    "<font face='Courier'>app_url</font> (a deep link into Skyvern's "
    "dashboard), and any <font face='Courier'>downloaded_files</font> "
    "(used by the Type F PDF path).",
    BODY))

story.append(Paragraph("7.5  Cancel that actually cancels", H2))
story.append(Paragraph(
    "The naive way to cancel a run is to check the cancel flag at "
    "row boundaries — but with 8-minute Skyvern attempts, that means "
    "the user waits up to 8 minutes after pressing the button. We do "
    "better: a separate <font face='Courier'>watch_cancel()</font> "
    "coroutine polls the run's cancel flag every 5 seconds while rows "
    "run, and on cancel it calls <font face='Courier'>work.cancel()"
    "</font> on the in-flight asyncio gather. That raises "
    "<font face='Courier'>CancelledError</font> inside whichever rows "
    "are currently awaiting a Skyvern response, aborting them within "
    "seconds. The aborted rows are left in_progress; after work "
    "drains, <font face='Courier'>reset_in_progress()</font> flips "
    "them back to pending so they read NOT CHECKED and are retryable.",
    BODY))

story.append(PageBreak())

# ========================== §8 QUEUE & LIFECYCLE ==========================
story.append(Paragraph("8.  The queue & lifecycle in detail", H1))
story.append(Paragraph(
    "A run moves through a small state machine. The states are stored "
    "on the run document's <font face='Courier'>status</font> field. "
    "Transitions happen in three places: the API routes (queued, "
    "canceled, queued-again-on-retry), the worker's claim function "
    "(queued → running), and the worker's lifecycle (running → "
    "writing_back → done / done_with_errors / canceled / failed).",
    BODY))

story.append(Paragraph("8.1  States", H2))
state_table = [
    ["State", "Set by", "Meaning"],
    ["queued", "POST /api/runs, retry handler",
     "Uploaded and waiting for a worker. Cancel can finalize "
     "directly to 'canceled' since no worker is attached."],
    ["running", "Worker (claim_run / claim_next_queued)",
     "Worker is actively processing rows. Cancel triggers the "
     "watch_cancel coroutine."],
    ["writing_back", "Worker (orchestrator)",
     "All rows processed. Worker is opening the original xlsx and "
     "writing answers. Cancel is moot at this point."],
    ["done", "Worker finish()",
     "Clean finish. Output file is in Cloud Storage."],
    ["done_with_errors", "Worker finish()",
     "Some rows ended NEEDS_REVIEW or UNREACHABLE. Output file is "
     "still produced; failed rows get a NEEDS_REVIEW note in place."],
    ["canceled", "Cancel API + worker finish()",
     "Cancel flag was honored. Some rows may have been completed; "
     "those are written back. Unprocessed rows are marked NOT CHECKED."],
    ["failed", "fail_run()",
     "Hard failure (workbook unreadable, no processable sheets, "
     "exception escaped the worker's outer try)."],
]
st = Table(state_table, colWidths=[1.4 * inch, 1.7 * inch, 3.6 * inch])
st.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("FONT", (0, 1), (0, -1), "Courier", 9),
    ("FONT", (1, 1), (1, -1), "Helvetica", 9),
    ("FONT", (2, 1), (2, -1), "Helvetica", 9.5),
    ("TEXTCOLOR", (0, 1), (0, -1), ACCENT),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
]))
story.append(st)

story.append(Paragraph("8.2  Per-row resume state", H2))
story.append(Paragraph(
    "Resume is tracked at the row level in "
    "<font face='Courier'>tax_checker_scrape_state</font>. Each row "
    "has a doc with a deterministic ID, "
    "<font face='Courier'>tax_check__&lt;runId&gt;__&lt;rowKey&gt;"
    "</font>, holding one of four statuses: <i>pending</i>, "
    "<i>in_progress</i>, <i>done</i>, <i>failed</i>. The worker's "
    "<font face='Courier'>pending_keys()</font> query returns the "
    "set of rows still to do — by default pending+in_progress, plus "
    "failed when <font face='Courier'>--resume</font> is set.",
    BODY))

story.append(Paragraph("8.3  Retry semantics", H2))
story.append(Paragraph(
    "The retry endpoint distinguishes <b>technical failures</b> from "
    "<b>business outcomes</b>. A NEEDS_REVIEW row is a deliberate "
    "answer (we read the page and couldn't verify) and is not retried "
    "automatically — re-running it would just produce the same "
    "answer. An UNREACHABLE row, an in_progress row stuck from a "
    "cancel, a pending row that never ran, or a failed row are all "
    "reset to pending and re-processed:",
    BODY))
story.append(code_block(
    """const stuck      = s === "failed" || s === "in_progress" || s === "pending";
const unreachable = s === "done" && rowStatus === "UNREACHABLE";
if (stuck || unreachable) {
  batch.update(doc.ref, { status: "pending", error: null, ... });
  batch.update(runRef.collection("rows").doc(rowKey),
               { state: "pending", ... });
}""",
    caption="app/api/runs/[id]/retry/route.ts — what counts as retryable",
))

story.append(Paragraph("8.4  Counters & money handling", H2))
story.append(Paragraph(
    "The run doc carries a <font face='Courier'>totals</font> map "
    "with counts per status and a sum of amounts owed. Updates happen "
    "with Firestore <font face='Courier'>Increment</font> operators "
    "so concurrent row writes don't race. Critically, a row that's "
    "<i>re-processed</i> (after a retry) first reverses its previous "
    "tally before applying the new one — <font face='Courier'>"
    "_run_tally_updates()</font> reads the previous row state and "
    "subtracts its old contribution from the appropriate counter and "
    "the money total before adding the new one. This guarantees the "
    "money total never double-counts.",
    BODY))

story.append(PageBreak())

# ========================== §9 SAFETY/VALIDATION ==========================
story.append(Paragraph("9.  Safety, validation, and confidence", H1))
story.append(Paragraph(
    "Every cell that ends up in the output workbook went through three "
    "gates: the prompt's hard rules (which constrain what Skyvern can "
    "do on the portal), the verification step (which decides whether "
    "the page we read corresponds to the right property), and the "
    "validation step (which decides whether the answer is good enough "
    "to write).",
    BODY))

story.append(Paragraph("9.1  Hard rules in the prompt", H2))
story.append(Paragraph(
    "The prompt's HARD RULES section is the front-line guard. Skyvern "
    "is explicitly forbidden from clicking 'Pay Now', 'Add to Cart', "
    "'Check Out', or 'Enroll'; from entering card or bank information; "
    "from creating accounts or logging in; and from falsely affirming "
    "eligibility gates. Plain 'I agree' disclaimers for read-only "
    "browsing are permitted. This means even an unreliable agent run "
    "stays inside read-only territory.",
    BODY))

story.append(Paragraph("9.2  The verification ladder (verify.py)", H2))
story.append(Paragraph(
    "Before any answer is recorded, the page must be verified to "
    "match the property we asked about. The ladder is:",
    BODY))
story.extend(bullets([
    "<b>Address normalization.</b> 'Street/St', 'Highway/Hwy', "
    "'Boulevard/Blvd', directionals — all folded. Same street number "
    "is required; the street-line text is compared with "
    "<font face='Courier'>difflib.SequenceMatcher</font> at ≥ 0.75 "
    "similarity.",
    "<b>Owner matching.</b> Tokens like 'LLC', 'Inc', 'Corp', 'the' "
    "are dropped. The remaining tokens of the row's owner must appear "
    "in the page's owner string for at least half the tokens — but "
    "any page owner containing 'PONTUS' is an automatic accept.",
    "<b>Parcel matching.</b> The page's shown parcel is normalized to "
    "alphanumeric uppercase with leading zeros stripped, then "
    "compared to each candidate variant.",
    "<b>The verdict matrix.</b> The combination of (parcel match, "
    "address match, owner match) maps to a MatchVerdict with a "
    "confidence hint of HIGH, MEDIUM, or LOW.",
    "<b>Seller exception.</b> Recently acquired properties may still "
    "show the seller. If parcel + address both match but owner does "
    "not, the row proceeds with confidence MEDIUM and the owner "
    "mismatch is recorded in the evidence trail.",
    "<b>Optional Claude adjudication.</b> When deterministic checks "
    "are inconclusive <i>and</i> an Anthropic API key is configured, "
    "the worker calls Claude with the row and the extraction and "
    "forces a tool call to <font face='Courier'>report_match_verdict"
    "</font>. The model returns a boolean + confidence + reasoning, "
    "which the worker accepts only when confidence is ≥ 0.7.",
]))

story.append(Paragraph("9.3  Validation (validate.py)", H2))
story.append(Paragraph(
    "Validation maps a verified extraction onto an "
    "<font face='Courier'>AccountRecord</font>:",
    BODY))
story.append(code_block(
    """due = parse_money(extraction.get("amount_due_now"))
if due is None:
    rec.status = NEEDS_REVIEW
    rec.confidence = LOW
elif due <= 0.005:
    rec.status = PAID
    rec.amount_due = 0.0
    rec.confidence = verdict.confidence_hint
else:
    rec.amount_due = round(due, 2)
    rec.status = (DELINQUENT if extraction.get("includes_delinquency")
                  else UNPAID)
    rec.confidence = verdict.confidence_hint""",
    caption="validate.py — build_account_record (core branches)",
))
story.append(Paragraph(
    "The amount-due cell only gets written when confidence is not LOW "
    "and the status is in {UNPAID, PARTIAL, DELINQUENT}. PAID rows "
    "leave the amount column alone (it's already $0). NEEDS_REVIEW "
    "and UNREACHABLE rows write nothing into data columns — they "
    "leave a status-column note only.",
    BODY))

story.append(Paragraph("9.4  Write-back (writeback.py)", H2))
story.append(Paragraph(
    "The write-back module uses openpyxl to open the original "
    "workbook in place, preserving every formula, merged header, "
    "hyperlink, width, and font. The key safeguard is "
    "<font face='Courier'>_safe_write()</font>, which gates every "
    "data-cell write:",
    BODY))
story.append(code_block(
    """def _safe_write(ws, row, col, value, number_format=None) -> bool:
    cell = ws.cell(row=row, column=col)
    if _is_formula(cell):
        return False                       # never touch a formula
    if value is None or (isinstance(value, str) and not value.strip()):
        return False                       # no silent erasure
    if not _cell_empty(cell):
        return _values_equalish(cell.value, value)  # already correct?
    cell.value = value
    if number_format:
        cell.number_format = number_format
    return True""",
    caption="writeback.py — the gate on every cell write",
))
story.append(Paragraph(
    "The three properties this guarantees: formulas are never "
    "overwritten, a scraped blank or null never erases a real value "
    "that was already in the cell, and an existing different value is "
    "left alone — any correction goes into the new status column "
    "instead, with a note like 'sheet said 11/13/2026; portal "
    "receipt shows 11/13/2025'.",
    BODY))

story.append(PageBreak())

# ========================== §10 FAILURE MODES ==========================
story.append(Paragraph("10.  Failure modes & how each is handled", H1))
story.append(Paragraph(
    "Production reality is messier than the happy path. Here is how "
    "each failure class is contained.",
    BODY))

failures = [
    ("Skyvern 5xx on session creation",
     "Three-step exponential backoff (2s, 5s, 10s). After all "
     "retries, the session degrades to per-task ephemeral browsers — "
     "less polite to the portal but the run continues."),
    ("Portal returns garbage / Skyvern can't find the answer",
     "The extraction's <font face='Courier'>page_outcome</font> is "
     "one of <font face='Courier'>landed_on_search</font>, "
     "<font face='Courier'>ambiguous_multiple_matches</font>, "
     "<font face='Courier'>no_matching_property</font>, "
     "<font face='Courier'>login_required</font>, or "
     "<font face='Courier'>blocked</font>. The row becomes "
     "NEEDS_REVIEW with the reason recorded; the workbook is still "
     "produced."),
    ("Wrong property opened (deep link landed on a different parcel)",
     "Verify.py's match assessment returns matched=False. The row "
     "becomes NEEDS_REVIEW with basis 'wrong record: neither owner "
     "nor address matches'. Nothing is extracted."),
    ("One row throws an unhandled exception",
     "Caught by the orchestrator's outer per-row try/except. The row "
     "is marked UNREACHABLE with the exception message in the "
     "evidence; the run continues."),
    ("Worker container SIGKILL'd mid-run (OOM / 6-hour timeout)",
     "Rows in progress are left at <font face='Courier'>in_progress"
     "</font> in their scrape_state. The run doc is stuck at "
     "<i>running</i> (no finalization happened). The next worker "
     "execution sees no fresh activity within 30 minutes and is free "
     "to claim it. Retry handler resets the orphan rows. Reaper "
     "closes the orphaned browser sessions."),
    ("Cloud Run job execution fails to start",
     "The POST /api/runs handler catches the failure and writes "
     "<font face='Courier'>trigger_error</font> to the run doc. The "
     "run stays queued; the user can manually run the worker or "
     "click Retry."),
    ("PDF-only portal",
     "The orchestrator drops to the Type F path: "
     "<font face='Courier'>download_files()</font> on Skyvern, fetch "
     "the resulting PDF, parse with pdfplumber. Scanned/image PDFs "
     "that can't be parsed yield NEEDS_REVIEW with the PDF URL saved "
     "as evidence."),
    ("Workbook with no URL column at all",
     "Discovery: a web search for "
     "'&lt;county&gt; county &lt;state&gt; tax collector property "
     "tax search' surfaces an official portal, which gets recorded "
     "in <font face='Courier'>discovered_url</font> on the row so the "
     "spreadsheet can be updated for next time."),
    ("User cancels during a long row",
     "Cancel watcher sees the flag within 5 s, calls "
     "<font face='Courier'>work.cancel()</font>. In-flight Skyvern "
     "tasks abort. Aborted rows reset to pending. The output workbook "
     "is still produced with completed rows filled and the rest "
     "marked NOT CHECKED."),
]
fail_rows = [["Failure", "Containment"]]
for f, c in failures:
    fail_rows.append([Paragraph(f, BODY_LEFT), Paragraph(c, BODY_LEFT)])
ft = Table(fail_rows, colWidths=[2.4 * inch, 4.3 * inch])
ft.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.append(ft)

story.append(PageBreak())

# ========================== §11 COST ==========================
story.append(Paragraph("11.  Cost model & operational ceilings", H1))
story.append(Paragraph(
    "The system is composed entirely of pay-as-you-go services. "
    "Below is the practical cost shape for a typical run, plus the "
    "ceilings we have observed.",
    BODY))

story.append(Paragraph("11.1  Per-property economics", H2))
story.append(Paragraph(
    "Skyvern bills per <i>step</i>, where a step is roughly one "
    "LLM-driven action on the browser (read the page, decide what to "
    "do, click). A typical property lookup in fast mode runs 3–6 "
    "steps. Skyvern's published per-step price varies by plan; in our "
    "cloud account, the practical cost is in the rough range of $0.30 "
    "to $0.60 per property. A 100-property portfolio refresh "
    "therefore costs $30–$60 in variable Skyvern fees.",
    BODY))

story.append(Paragraph("11.2  Fixed infrastructure", H2))
cost_table = [
    ["Provider", "Service", "What we pay"],
    ["Vercel", "Hosting + serverless functions",
     "Hobby tier free for early use. Pro at $20/mo covers our scale."],
    ["Firebase", "Firestore + Cloud Storage",
     "Blaze pay-as-you-go. Firestore writes ≈ $0.18 per 100k; reads "
     "≈ $0.06 per 100k. Practical cost: pennies/month at our volume."],
    ["Google Cloud Run", "Worker job",
     "Charged for vCPU-seconds and memory-seconds while the job runs. "
     "A 30-min run on 2 vCPU / 2 GB costs cents."],
    ["Skyvern", "Browser AI",
     "Per-step variable; the dominant variable cost."],
    ["Anthropic Claude (optional)", "Tie-break adjudication",
     "Only invoked when fuzzy verification is inconclusive. Pennies "
     "per call."],
]
cost_t = Table(cost_table, colWidths=[1.4 * inch, 1.7 * inch,
                                       3.6 * inch])
cost_t.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("FONT", (0, 1), (0, -1), "Helvetica-Bold", 9.5),
    ("FONT", (1, 1), (-1, -1), "Helvetica", 9.5),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
]))
story.append(cost_t)

story.append(Paragraph("11.3  Operational ceilings", H2))
story.extend(bullets([
    "<b>Skyvern concurrent sessions.</b> The observed effective "
    "ceiling on the current plan is around 2 concurrent sessions; "
    "MAX_CONCURRENCY past that yields 503/403 on surplus sessions, "
    "surfaced as UNREACHABLE rows. Raising this is a plan upgrade, "
    "not a code change.",
    "<b>Vercel function bodies.</b> Capped at ~4.5 MB. We enforce "
    "≤ 4 MB on uploads explicitly. Real-world Pontus trackers are "
    "well under 1 MB.",
    "<b>Cloud Run job timeout.</b> Set to 6 hours. A real run takes "
    "minutes; the timeout is just a backstop against a wedged worker.",
    "<b>Firestore quotas.</b> Free-tier limits are 50k reads / 20k "
    "writes per day per project. We're nowhere near.",
]))

story.append(PageBreak())

# ========================== §12 APPENDIX ==========================
story.append(Paragraph("12.  Appendix", H1))

story.append(Paragraph("12.1  Deployment commands", H2))
story.append(code_block(
    """# Frontend (Vercel)
npx vercel deploy --prod        # from repo root, .vercel/ is linked

# Worker (Cloud Run Job)
gcloud run jobs deploy tax-checker-worker \\
  --source worker \\
  --region us-west1 \\
  --max-retries 0

# Firestore rules
node scripts/deploy-rules.js     # uses Rules API (Admin SDK works)""",
    caption="Common deploy paths",
))

story.append(Paragraph("12.2  Environment variables", H2))
env_table = [
    ["Variable", "Used by", "Purpose"],
    ["NEXT_PUBLIC_FIREBASE_*", "Frontend",
     "Firebase web config — safe to expose"],
    ["FIREBASE_SERVICE_ACCOUNT_KEY", "API routes, Vercel",
     "Service-account JSON one-liner for Admin SDK"],
    ["FIREBASE_SERVICE_ACCOUNT_KEY_FILE", "Worker (local)",
     "Path to serviceAccount.json on disk"],
    ["CLOUD_RUN_JOB", "API",
     "Job name to trigger (tax-checker-worker)"],
    ["CLOUD_RUN_REGION", "API", "us-west1"],
    ["SKYVERN_API_KEY", "Worker", "Skyvern cloud API token"],
    ["STORAGE_BUCKET", "Worker",
     "pontustax.firebasestorage.app"],
    ["MAX_CONCURRENCY", "Worker",
     "Concurrent portal domains (10; effective ~2 on current plan)"],
    ["ANTHROPIC_API_KEY", "Worker (optional)",
     "Enables Claude tie-break adjudication"],
]
ev = Table(env_table, colWidths=[2.4 * inch, 1.3 * inch, 3.0 * inch])
ev.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("FONT", (0, 1), (0, -1), "Courier", 8.5),
    ("FONT", (1, 1), (1, -1), "Helvetica", 9),
    ("FONT", (2, 1), (2, -1), "Helvetica", 9),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
]))
story.append(ev)

story.append(Paragraph("12.3  File map", H2))
fmap = [
    ("app/", "Next.js App Router — pages and route groups"),
    ("app/api/runs/route.ts", "GET (list) + POST (upload, queue, trigger)"),
    ("app/api/runs/[id]/route.ts", "Single-run detail"),
    ("app/api/runs/[id]/cancel/route.ts", "Set cancel_requested"),
    ("app/api/runs/[id]/download/route.ts", "v4 signed URL"),
    ("app/api/runs/[id]/retry/route.ts", "Re-queue stuck/failed rows"),
    ("lib/firebase.ts", "Client SDK (browser-safe)"),
    ("lib/firebase-admin.ts", "Admin SDK (server only)"),
    ("lib/cloud-run.ts", "triggerWorker() — POST run.googleapis.com"),
    ("worker/main.py", "Entrypoint; drain loop or single-run modes"),
    ("worker/pontus_tax/intake.py", "Header + column detection"),
    ("worker/pontus_tax/identifiers.py", "Dirty IDs → candidates"),
    ("worker/pontus_tax/taxonomy.py", "URL → portal shape"),
    ("worker/pontus_tax/playbooks.py",
     "Vendor library (seeds + runtime adds)"),
    ("worker/pontus_tax/prompts.py", "Skyvern prompt builder"),
    ("worker/pontus_tax/extraction_schema.py", "JSON schema we extract"),
    ("worker/pontus_tax/skyvern_runner.py", "Skyvern SDK client + sessions"),
    ("worker/pontus_tax/verify.py", "Owner/address/parcel matching"),
    ("worker/pontus_tax/validate.py", "Verified extraction → record"),
    ("worker/pontus_tax/writeback.py", "openpyxl write-back"),
    ("worker/pontus_tax/store.py", "Firestore + LocalStore"),
    ("worker/pontus_tax/orchestrator.py", "execute_run + RowProcessor"),
    ("worker/pontus_tax/discovery.py", "No-URL discovery search"),
    ("worker/pontus_tax/pdf_bill.py", "Type F PDF download + parse"),
    ("worker/pontus_tax/canonical.py", "RowOutcome, AccountRecord"),
    ("firestore.rules", "Deny-by-default + public reads on runs"),
    ("worker/tests/", "36 tests on synthetic FL fixture + dry pipeline"),
]
fmap_rows = [["File", "What it does"]]
for f, d in fmap:
    fmap_rows.append([
        Paragraph(f"<font face='Courier'>{f}</font>",
                  ParagraphStyle("FF", parent=BODY,
                                 fontName="Courier", fontSize=8.5,
                                 leading=12)),
        Paragraph(d, ParagraphStyle("FD", parent=BODY, fontSize=9,
                                     leading=12)),
    ])
fmt = Table(fmap_rows, colWidths=[2.8 * inch, 3.9 * inch])
fmt.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
    ("BACKGROUND", (0, 0), (-1, 0), LINE_SOFT),
    ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
    ("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE),
    ("LINEBELOW", (0, 1), (-1, -1), 0.2, LINE),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 5),
    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ("TOPPADDING", (0, 0), (-1, -1), 4),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
]))
story.append(fmt)

story.append(Spacer(1, 0.25 * inch))
story.append(Paragraph(
    "<i>End of report.</i>",
    ParagraphStyle("End", parent=BODY, fontSize=10,
                   textColor=MUTED, alignment=TA_LEFT)
))

# ----------------------------------------------------------------------
# Build the doc
# ----------------------------------------------------------------------

doc = BaseDocTemplate(
    OUT,
    pagesize=LETTER,
    leftMargin=MARGIN, rightMargin=MARGIN,
    topMargin=0.85 * inch, bottomMargin=0.85 * inch,
    title="Pontus Property Tax Checker — Technical Report",
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

# Cover template for the cover, Body template for everything after.
from reportlab.platypus import NextPageTemplate
story.insert(0, NextPageTemplate("Cover"))
for i, item in enumerate(story):
    if isinstance(item, PageBreak):
        story.insert(i, NextPageTemplate("Body"))
        break

doc.build(story)
print(f"Wrote {OUT}")
