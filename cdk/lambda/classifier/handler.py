import json
import logging
import os

import anthropic
import boto3
import voyageai

from pipeline import Pipeline
from gnomepy.registry import RegistryClient

logger = logging.getLogger(__name__)


def _fetch_api_key(key_id: str) -> str:
    client = boto3.client("apigateway")
    response = client.get_api_key(apiKey=key_id, includeValue=True)
    return response["value"]


def _fetch_secret(secret_name: str) -> str:
    client = boto3.client("secretsmanager")
    response = client.get_secret_value(SecretId=secret_name)
    return response["SecretString"]


def handler(event, context):
    logging.basicConfig(level=logging.INFO)

    anthropic_api_key = _fetch_secret(os.environ["ANTHROPIC_API_KEY_SECRET"])
    voyage_api_key = _fetch_secret(os.environ["VOYAGE_API_KEY_SECRET"])

    registry = RegistryClient()
    anthropic_client = anthropic.Anthropic(api_key=anthropic_api_key)
    voyage_client = voyageai.Client(api_key=voyage_api_key)

    pipeline = Pipeline(registry=registry, anthropic_client=anthropic_client, voyage_client=voyage_client)
    summary = pipeline.run()

    logger.info("Pipeline complete: %s", summary)
    return {
        "statusCode": 200,
        "body": json.dumps(summary),
    }
