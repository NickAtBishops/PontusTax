"""FastAPI surface for the Cloud Run write-back worker.

Two endpoints:
  GET  /health     - readiness probe
  POST /writeback  - multipart upload of the xlsx + write parameters,
                     returns the modified xlsx as octet-stream.

The worker is stateless and language-agnostic: all knowledge of tenants,
quarters, and tracker layout lives on the caller (the Next.js route).
Adding a new tenant or quarter does NOT require redeploying this worker.
"""

from __future__ import annotations

import hmac
import json
import os
from typing import Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

from excel_writer import WriteRequest, WritebackRefusedError, write_quarterly_values

app = FastAPI(title="Tenant Tracker Writeback Worker")

# Shared bearer token. When set, every /writeback request must include
# Authorization: Bearer <secret>. When empty (typical for local dev),
# the worker is open. Vercel sets this in production via Cloud Run env
# vars; mismatched secrets get a 401.
_SHARED_SECRET = os.environ.get("WORKER_SHARED_SECRET", "")


def _require_auth(authorization: Optional[str]) -> None:
    if not _SHARED_SECRET:
        return
    expected = f"Bearer {_SHARED_SECRET}"
    # hmac.compare_digest avoids timing-attack signal on the secret.
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/writeback")
async def writeback(
    xlsx_file: UploadFile = File(..., description="The original xlsx tracker"),
    sheet_name: str = Form(...),
    row: int = Form(...),
    expected_tenant_substring: str = Form(...),
    sales_col: int = Form(...),
    ebitda_col: int = Form(...),
    sales_value: float = Form(...),
    ebitda_value: float = Form(...),
    sales_header_expected: str = Form(...),
    ebitda_header_expected: str = Form(...),
    # FastAPI converts empty form fields to "" rather than None; an
    # empty string here means "no alternate header allowed".
    ebitda_header_alternate: str = Form(""),
    header_row: int = Form(3),
    authorization: Optional[str] = Header(default=None),
) -> Response:
    _require_auth(authorization)

    xlsx_bytes = await xlsx_file.read()
    if not xlsx_bytes:
        raise HTTPException(status_code=400, detail="xlsx_file is empty")

    alt: Optional[str] = ebitda_header_alternate if ebitda_header_alternate else None

    req = WriteRequest(
        xlsx_bytes=xlsx_bytes,
        sheet_name=sheet_name,
        row=row,
        expected_tenant_substring=expected_tenant_substring,
        sales_col=sales_col,
        ebitda_col=ebitda_col,
        sales_value=sales_value,
        ebitda_value=ebitda_value,
        sales_header_expected=sales_header_expected,
        ebitda_header_expected=ebitda_header_expected,
        ebitda_header_alternate=alt,
        header_row=header_row,
    )

    try:
        result = write_quarterly_values(req)
    except WritebackRefusedError as e:
        # 422 because the cell preconditions weren't met. The caller
        # surfaces this message to the analyst.
        return JSONResponse(
            status_code=422,
            content={"error": str(e)},
        )
    except Exception as e:  # pragma: no cover - defensive
        return JSONResponse(
            status_code=500,
            content={"error": f"unexpected error: {type(e).__name__}: {e}"},
        )

    headers = {}
    # Surface soft warnings via a header. Keeps the body as raw xlsx
    # bytes so the Next.js route can stream them straight to the
    # browser without re-encoding.
    if result.warnings:
        headers["X-Worker-Warnings"] = json.dumps(result.warnings)

    return Response(
        content=result.xlsx_bytes,
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers=headers,
    )
