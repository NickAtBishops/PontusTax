"""Worker configuration — everything tunable comes from the environment."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _service_account_json() -> str | None:
    """Inline JSON env var, or the downloaded .json file via
    FIREBASE_SERVICE_ACCOUNT_KEY_FILE (relative paths resolve against the
    repo root, then the worker dir)."""
    inline = os.environ.get("FIREBASE_SERVICE_ACCOUNT_KEY")
    if inline:
        return inline
    path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_KEY_FILE")
    if not path:
        return None
    path = os.path.expanduser(path)
    worker_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    candidates = [
        path,
        os.path.join(worker_dir, "..", path),
        os.path.join(worker_dir, path),
    ]
    for c in candidates:
        if os.path.isfile(c):
            with open(c, encoding="utf-8") as fh:
                return fh.read()
    return None


@dataclass
class Config:
    # Skyvern
    skyvern_api_key: str = field(
        default_factory=lambda: os.environ.get("SKYVERN_API_KEY", "")
    )
    skyvern_engine: str = field(
        default_factory=lambda: os.environ.get("SKYVERN_ENGINE", "skyvern-2.0")
    )
    # Fast mode: one number per property — fewer steps, shorter timeout.
    max_steps: int = field(default_factory=lambda: _int("SKYVERN_MAX_STEPS", 15))
    proxy_location: str = field(
        default_factory=lambda: os.environ.get("SKYVERN_PROXY_LOCATION", "RESIDENTIAL")
    )
    attempt_timeout: float = field(
        default_factory=lambda: _float("SKYVERN_ATTEMPT_TIMEOUT", 480.0)
    )

    # Anthropic adjudication layer (optional — deterministic checks always run)
    anthropic_api_key: str | None = field(
        default_factory=lambda: os.environ.get("ANTHROPIC_API_KEY") or None
    )
    anthropic_model: str = field(
        default_factory=lambda: os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    )

    # Politeness / concurrency — several rows share a portal; don't hammer.
    polite_delay: float = field(default_factory=lambda: _float("POLITE_DELAY_SECONDS", 8.0))
    max_concurrency: int = field(default_factory=lambda: _int("MAX_CONCURRENCY", 2))
    max_attempts_per_account: int = field(
        default_factory=lambda: _int("MAX_ATTEMPTS_PER_ACCOUNT", 3)
    )

    # Firebase / GCP (unused in --local mode)
    storage_bucket: str = field(
        default_factory=lambda: os.environ.get("STORAGE_BUCKET", "")
    )
    service_account_json: str | None = field(default_factory=_service_account_json)
    project_id: str | None = field(default_factory=lambda: os.environ.get("GCP_PROJECT") or None)

    def resolved_project_id(self) -> str | None:
        if self.project_id:
            return self.project_id
        if self.service_account_json:
            try:
                return json.loads(self.service_account_json).get("project_id")
            except json.JSONDecodeError:
                return None
        return None
