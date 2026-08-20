"""Lead creation workflow."""
from app.common.db import leads_repository
from app.common.logger import get_logger
from app.common.validation import require_non_empty, validate_email
from app.leads.crm_client import send_lead_to_crm
from app.leads.lead import Lead, LeadInput
from app.users.phone import normalize_phone

logger = get_logger(__name__)


def create_lead(input: LeadInput) -> Lead:
    """Validate a lead, persist it and forward it to the external CRM."""
    name = require_non_empty(input.name, "name")
    email = validate_email(input.email)
    phone = normalize_phone(input.phone) if input.phone else None

    payload = {
        "name": name,
        "email": email,
        "phone": phone,
        "source": input.source,
        "message": input.message,
    }
    response = send_lead_to_crm(payload)

    lead = Lead(
        id=0,
        name=name,
        email=email,
        phone=phone,
        source=input.source,
        remote_id=response.remote_id,
    )
    lead_id = leads_repository.insert(lead)
    lead = lead.model_copy(update={"id": lead_id})
    logger.info("Created lead %s from source %s", lead_id, input.source)
    return lead
