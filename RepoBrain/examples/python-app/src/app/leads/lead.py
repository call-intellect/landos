"""Pydantic-style schemas for the leads package."""
from typing import Optional

from pydantic import BaseModel, Field


class LeadInput(BaseModel):
    """Incoming payload describing a sales lead."""

    name: str = Field(..., min_length=1)
    email: str
    phone: Optional[str] = None
    source: str = "website"
    message: Optional[str] = None


class Lead(BaseModel):
    """Persisted lead entity with its CRM reference."""

    id: int
    name: str
    email: str
    phone: Optional[str] = None
    source: str
    remote_id: Optional[str] = None
