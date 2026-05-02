"""Engine -> Redis publisher for entry events.

Frame format matches the design's WebSocket frame contract so klio-realtime
(or, in v0, the daemon's direct Redis subscriber) can fan them out unchanged.
"""
import json
import uuid
from typing import Any

import redis.asyncio as redis_asyncio

from klio_engine.config import Settings


class RedisPublisher:
    def __init__(self, *, client: redis_asyncio.Redis | None = None, url: str | None = None) -> None:
        if client is not None:
            self._client = client
            self._owned = False
        else:
            url = url or Settings().redis_url
            self._client = redis_asyncio.Redis.from_url(url, decode_responses=False)
            self._owned = True

    async def close(self) -> None:
        if self._owned:
            await self._client.aclose()

    async def publish_entry_created(
        self,
        *,
        space_id: uuid.UUID,
        entry: dict[str, Any],
        frame_id: str | None = None,
    ) -> None:
        frame_id = frame_id or str(uuid.uuid4())
        frame = {
            "type": "entry.created",
            "space_id": str(space_id),
            "frame_id": frame_id,
            "entry": entry,
        }
        await self._client.publish(f"space:{space_id}", json.dumps(frame))

    async def publish_entry_superseded(
        self,
        *,
        space_id: uuid.UUID,
        entry_id: uuid.UUID,
        superseded_by: uuid.UUID,
    ) -> None:
        frame = {
            "type": "entry.superseded",
            "space_id": str(space_id),
            "frame_id": str(uuid.uuid4()),
            "entry_id": str(entry_id),
            "superseded_by": str(superseded_by),
        }
        await self._client.publish(f"space:{space_id}", json.dumps(frame))

    async def publish_permission_changed(
        self,
        *,
        space_id: uuid.UUID,
        agent_id: uuid.UUID,
        scope: str,
    ) -> None:
        frame = {
            "type": "permission.changed",
            "space_id": str(space_id),
            "frame_id": str(uuid.uuid4()),
            "permission": {"agent_id": str(agent_id), "scope": scope},
        }
        await self._client.publish(f"space:{space_id}", json.dumps(frame))
