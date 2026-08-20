"""Tests for invoice total and tax computation."""
from decimal import Decimal

from app.invoices.calc_tax import calc_tax
from app.invoices.calc_total import calc_total


def test_calc_tax_uses_explicit_rate():
    assert calc_tax(Decimal("100"), 0.2) == Decimal("20.00")


def test_calc_total_adds_tax_to_net():
    total = calc_total(Decimal("100"), 0.2)
    assert total == Decimal("120.00")


def test_calc_total_defaults_rate():
    total = calc_total(Decimal("200"))
    assert total > Decimal("200")
