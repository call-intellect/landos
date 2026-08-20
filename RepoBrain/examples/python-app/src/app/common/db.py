"""A tiny in-memory database layer used for the example app."""
from typing import Dict, Generic, List, TypeVar

from app.common.logger import get_logger

logger = get_logger(__name__)

T = TypeVar("T")


class Repository(Generic[T]):
    """A minimal repository that stores rows in memory."""

    def __init__(self, table: str) -> None:
        self.table = table
        self._rows: Dict[int, T] = {}
        self._sequence = 0

    def insert(self, entity: T) -> int:
        """Store an entity and return its generated identifier."""
        self._sequence += 1
        self._rows[self._sequence] = entity
        logger.info("Inserted row %s into %s", self._sequence, self.table)
        return self._sequence

    def get(self, row_id: int) -> T:
        """Return a previously stored entity by its identifier."""
        return self._rows[row_id]

    def list_all(self) -> List[T]:
        """Return all stored entities."""
        return list(self._rows.values())


users_repository: Repository = Repository("users")
invoices_repository: Repository = Repository("invoices")
leads_repository: Repository = Repository("leads")
