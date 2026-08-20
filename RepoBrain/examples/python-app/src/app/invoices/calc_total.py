"""Invoice total computation."""
from decimal import Decimal
from typing import Optional

from app.invoices.calc_tax import calc_tax


def calc_total(net_amount: Decimal, rate: Optional[float] = None) -> Decimal:
    """Return the gross total for ``net_amount`` including tax.

    Delegates the tax portion to :func:`calc_tax` and adds it to the net.
    """
    net = Decimal(net_amount)
    tax = calc_tax(net, rate)
    return net + tax
