"""User service: orchestrates validation, normalization and storage."""
from datetime import datetime, timezone

from app.common.db import users_repository
from app.common.logger import get_logger
from app.common.validation import require_non_empty, validate_email
from app.users.phone import normalize_phone
from app.users.schema import User, UserInput

logger = get_logger(__name__)


def create_user(data: UserInput) -> User:
    """Create a user from validated input.

    The phone number is normalized before the record is persisted so that
    every stored user shares a single canonical phone format.
    """
    full_name = require_non_empty(data.full_name, "full_name")
    email = validate_email(data.email)
    phone = normalize_phone(data.phone)

    user = User(
        id=0,
        full_name=full_name,
        email=email,
        phone=phone,
        company=data.company,
        created_at=datetime.now(timezone.utc),
    )
    user_id = users_repository.insert(user)
    user = user.model_copy(update={"id": user_id})
    logger.info("Created user %s with email %s", user_id, email)
    return user
