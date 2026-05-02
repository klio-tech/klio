"""Hourly notarization cron entrypoint.

Run via:
  python scripts/notarize_hourly.py

Schedule on Railway / systemd:
  0 * * * *   python /app/scripts/notarize_hourly.py

Environment:
  KLIO_DATABASE_URL          required
  KLIO_NOTARIZE_BACKEND      'stub' to force offline mode (default: auto-detect)
  KLIO_OTS_CALENDAR_URL      defaults to alice.btc.calendar.opentimestamps.org
"""
from __future__ import annotations

import asyncio
import os
import sys

from sqlalchemy.ext.asyncio import async_sessionmaker

from klio_engine.audit.notarize import run_notarization
from klio_engine.db import build_engine


async def _main() -> int:
    url = os.getenv("KLIO_DATABASE_URL")
    if not url:
        print("KLIO_DATABASE_URL required", file=sys.stderr)
        return 2

    engine = build_engine(url)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            record = await run_notarization(session)
            print(
                f"notarized: backend={record.backend} "
                f"root={record.root_hash[:16]}... "
                f"audit_log_count={record.audit_log_count} "
                f"ots_bytes={'present' if record.ots_attestation else 'none'}"
            )
        return 0
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
