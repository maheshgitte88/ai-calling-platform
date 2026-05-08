"""MongoDB accessor.

The client is created lazily on first call to :func:`get_db` so importing this
module has no network side effects (helps tests and tools like
``download-files``).
"""

from __future__ import annotations

from functools import lru_cache

from pymongo import MongoClient
from pymongo.database import Database

from .config import settings


@lru_cache(maxsize=1)
def get_client() -> MongoClient:
    return MongoClient(settings.mongodb_uri)


@lru_cache(maxsize=1)
def get_db() -> Database:
    return get_client()[settings.mongodb_database]


__all__ = ["get_client", "get_db"]
