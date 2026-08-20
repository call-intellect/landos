"""Invoice assembly from line items."""
from dataclasses import dataclass, field
from decimal import Decimal
from typing import List, Optional

from app.common.db import invoices_repository
from app.common.logger import get_logger
from app.invoices.calc_tax import calc_tax
from app.invoices.calc_total import calc_total

logger = get_logger(__name__)


@dataclass
class LineItem:
    """A single billable line on an invoice."""

    description: str
    quantity: int
    unit_price: Decimal


@dataclass
class Invoice:
    """An assembled invoice with computed monetary fields."""

    customer: str
    items: List[LineItem] = field(default_factory=list)
    net: Decimal = Decimal("0")
    tax: Decimal = Decimal("0")
    total: Decimal = Decimal("0")
    id: int = 0


def build_invoice(
    customer: str,
    items: List[LineItem],
    rate: Optional[float] = None,
) -> Invoice:
    """Build an invoice, computing per-item net, tax and grand total."""
    net = Decimal("0")
    for item in items:
        net += Decimal(item.unit_price) * item.quantity
    tax = calc_tax(net, rate)
    total = calc_total(net, rate)
    invoice = Invoice(customer=customer, items=items, net=net, tax=tax, total=total)
    invoice.id = invoices_repository.insert(invoice)
    logger.info("Built invoice %s for %s with total %s", invoice.id, customer, total)
    return invoice
