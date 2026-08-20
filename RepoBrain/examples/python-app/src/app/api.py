"""HTTP API routes wiring requests to the service layer."""
from decimal import Decimal

from flask import Blueprint, jsonify, request

from app.common.logger import get_logger
from app.invoices.invoice import LineItem, build_invoice
from app.leads.create_lead import create_lead
from app.leads.lead import LeadInput
from app.users.schema import UserInput
from app.users.service import create_user

logger = get_logger(__name__)

api = Blueprint("api", __name__)


@api.post("/users")
def post_user():
    """Create a user from the JSON request body."""
    payload = request.get_json(force=True)
    data = UserInput(**payload)
    user = create_user(data)
    return jsonify(user.model_dump(mode="json")), 201


@api.post("/invoices")
def post_invoice():
    """Build an invoice from the JSON request body."""
    payload = request.get_json(force=True)
    items = [
        LineItem(
            description=row["description"],
            quantity=int(row["quantity"]),
            unit_price=Decimal(str(row["unit_price"])),
        )
        for row in payload.get("items", [])
    ]
    invoice = build_invoice(payload["customer"], items, payload.get("rate"))
    return jsonify({"id": invoice.id, "total": str(invoice.total)}), 201


@api.post("/leads")
def post_lead():
    """Create a lead from the JSON request body and forward it to the CRM."""
    payload = request.get_json(force=True)
    data = LeadInput(**payload)
    lead = create_lead(data)
    return jsonify(lead.model_dump(mode="json")), 201
