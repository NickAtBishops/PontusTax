# python:3.12-slim — NOT Microsoft's playwright/python image. That
# image bundles its own Python version pinned to whatever Ubuntu base
# Microsoft ships for a given Playwright release, and as of the
# v1.61.0-jammy tag that Python version is newer than every published
# `skyvern` release supports (every skyvern release on PyPI requires
# Python <3.14; `pip install` against that image's Python failed with
# "No matching distribution found for skyvern>=1.0" — confirmed against
# a real Cloud Build run on 2026-06-30, not a guess). Coupling the
# browser binary's vendor image to our own dependency's Python ceiling
# is exactly the kind of two-things-must-match fragility that bit us
# here. Pinning the playwright/python tag's version doesn't fix that —
# it's the IMAGE's Python version that's wrong, not the playwright
# package version.
#
# Instead: stay on the plain Python base every other part of this
# worker already uses, and install Chromium EXPLICITLY via
# `playwright install --with-deps`. This guarantees the browser
# revision always matches whatever `playwright` version requirements.txt
# resolves to (pip installs them together, in the same RUN step,
# instead of betting a separately-versioned vendor image already has
# the right one baked in).
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --with-deps also installs the Linux system libraries Chromium needs
# (libnss3, libatk, fonts, etc.) that python:3.12-slim doesn't ship by
# default — this replaces what the vendor image used to provide for us.
RUN playwright install --with-deps chromium

COPY . .

# Cloud Run JOB: each execution receives RUN_ID as an env override.
CMD ["python", "main.py"]
