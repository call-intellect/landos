"""Tests for the user creation service."""
import pytest

from app.common.validation import ValidationError
from app.users.phone import normalize_phone
from app.users.schema import UserInput
from app.users.service import create_user


def test_create_user_normalizes_phone():
    data = UserInput(
        full_name="Jane Doe",
        email="Jane@Example.com",
        phone="8 (912) 345-67-89",
    )
    user = create_user(data)
    assert user.phone == "+79123456789"
    assert user.email == "jane@example.com"
    assert user.id > 0


def test_create_user_rejects_empty_name():
    data = UserInput(full_name=" ", email="a@b.com", phone="+79123456789")
    with pytest.raises(ValidationError):
        create_user(data)


def test_normalize_phone_direct():
    assert normalize_phone("+1 202 555 0143") == "+12025550143"
