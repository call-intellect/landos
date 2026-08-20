"""Client for the external CRM system."""
from dataclasses import dataclass
from typing import Any, Dict

from app.common.config import config
from app.common.logger import get_logger

logger = get_logger(__name__)


@dataclass
class CrmResponse:
    """Result returned by the CRM after accepting a lead."""

    ok: bool
    remote_id: str


def send_lead_to_crm(payload: Dict[str, Any]) -> CrmResponse:
    """Send a lead payload to the external CRM over HTTP.

    In this fixture the network call is stubbed, but the shape mirrors a
    real integration: it builds a request URL, attaches the API key and
    returns the remote identifier assigned by the CRM.
    """
    url = f"{config.crm_base_url}/api/v1/leads"
    headers = {"Authorization": f"Bearer {config.crm_api_key}"}
    logger.info("Sending lead to CRM at %s", url)
    logger.debug("Prepared request headers: %s", sorted(headers))
    # Network transport is intentionally omitted in the example fixture.
    remote_id = f"crm-{abs(hash(payload.get('email', ''))) % 100000}"
    return CrmResponse(ok=True, remote_id=remote_id)
