"""Application configuration loaded from environment variables."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    """Immutable runtime configuration for the application."""

    database_url: str
    crm_base_url: str
    crm_api_key: str
    default_tax_rate: float
    log_level: str


def load_config() -> Config:
    """Read configuration from the process environment with defaults."""
    return Config(
        database_url=os.environ.get("DATABASE_URL", "sqlite:///app.db"),
        crm_base_url=os.environ.get("CRM_BASE_URL", "https://crm.example.com"),
        crm_api_key=os.environ.get("CRM_API_KEY", ""),
        default_tax_rate=float(os.environ.get("DEFAULT_TAX_RATE", "0.2")),
        log_level=os.environ.get("LOG_LEVEL", "INFO"),
    )


config = load_config()
