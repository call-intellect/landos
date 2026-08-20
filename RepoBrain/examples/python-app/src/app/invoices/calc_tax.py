"""Tax computation for invoice amounts."""
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from app.common.config import config


def calc_tax(amount: Decimal, rate: Optional[float] = None) -> Decimal:
    """Return the tax charged on ``amount`` for the given ``rate``.

    When no rate is supplied the configured default rate is used. The
    result is rounded to two decimal places.
    """
    effective_rate = Decimal(str(config.default_tax_rate if rate is None else rate))
    tax = Decimal(amount) * effective_rate
    return tax.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
