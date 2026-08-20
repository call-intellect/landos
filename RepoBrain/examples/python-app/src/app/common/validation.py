"""Reusable validation helpers shared by the service layer."""
import re

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ValidationError(ValueError):
    """Raised when user supplied data fails validation."""


def require_non_empty(value: str, field: str) -> str:
    """Return the trimmed value or raise if it is empty."""
    if value is None or value.strip() == "":
        raise ValidationError(f"Field '{field}' must not be empty")
    return value.strip()


def validate_email(email: str) -> str:
    """Validate and normalize an email address to lower case."""
    email = require_non_empty(email, "email")
    if not EMAIL_PATTERN.match(email):
        raise ValidationError(f"Invalid email address: {email}")
    return email.lower()
