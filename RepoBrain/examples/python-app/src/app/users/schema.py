"""Pydantic-style schemas for the users package."""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class UserInput(BaseModel):
    """Incoming payload used to create a new user."""

    full_name: str = Field(..., min_length=1, max_length=200)
    email: str
    phone: str
    company: Optional[str] = None


class User(BaseModel):
    """Persisted user entity."""

    id: int
    full_name: str
    email: str
    phone: str
    company: Optional[str] = None
    created_at: datetime
