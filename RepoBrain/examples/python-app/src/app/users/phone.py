"""Phone number normalization utilities."""
import re

from app.common.validation import ValidationError

_NON_DIGITS = re.compile(r"[^0-9+]")


def normalize_phone(phone: str) -> str:
    """Normalize a phone number into an E.164-like format.

    Strips spaces, dashes and parentheses, converts a leading local
    prefix into an international one and validates the resulting length.
    """
    if phone is None:
        raise ValidationError("Phone number must not be None")
    cleaned = _NON_DIGITS.sub("", phone)
    if cleaned.startswith("00"):
        cleaned = "+" + cleaned[2:]
    if cleaned.startswith("8") and len(cleaned) == 11:
        cleaned = "+7" + cleaned[1:]
    if not cleaned.startswith("+"):
        cleaned = "+" + cleaned
    digits = cleaned[1:]
    if len(digits) < 10 or len(digits) > 15:
        raise ValidationError(f"Phone number has invalid length: {phone}")
    return cleaned
