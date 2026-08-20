"""Application factory that assembles the Flask app."""
from flask import Flask

from app.api import api
from app.common.config import config
from app.common.logger import get_logger

logger = get_logger(__name__)


def create_app() -> Flask:
    """Create and configure the Flask application instance."""
    flask_app = Flask(__name__)
    flask_app.config["DATABASE_URL"] = config.database_url
    flask_app.register_blueprint(api)
    logger.info("Application initialized with database %s", config.database_url)
    return flask_app


app = create_app()
