"""Tests for the lead creation workflow."""
from app.leads.create_lead import create_lead
from app.leads.lead import LeadInput


def test_create_lead_forwards_to_crm():
    lead = create_lead(
        LeadInput(name="Acme Corp", email="sales@acme.com", phone="+12025550143")
    )
    assert lead.id > 0
    assert lead.remote_id is not None
    assert lead.email == "sales@acme.com"


def test_create_lead_defaults_source():
    lead = create_lead(LeadInput(name="Globex", email="hi@globex.com"))
    assert lead.source == "website"
