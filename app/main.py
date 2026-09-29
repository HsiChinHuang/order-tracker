import logging
import os
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import (
    BatchLogRecordProcessor,
    ConsoleLogRecordExporter,
)
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    ConsoleMetricExporter,
    PeriodicExportingMetricReader,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
from pydantic import BaseModel, Field

DB_PATH = Path(os.getenv("ORDER_DB_PATH", "data/orders.db"))
STATUSES = {"received", "preparing", "shipped", "delivered"}

# --- OpenTelemetry setup ---
OTLP_ENDPOINT = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
ENVIRONMENT = os.getenv("OTEL_ENVIRONMENT", "development")
DEPLOYED_VERSION = os.getenv("DEPLOYED_VERSION", "local")
# The SDK default is 60s, which makes every demo of this stack wait a minute for
# a counter to move and makes rate() look empty. 10s keeps the loop responsive.
EXPORT_INTERVAL_MS = int(os.getenv("OTEL_METRIC_EXPORT_INTERVAL", "10000"))

resource = Resource.create(
    {
        "service.name": "order-tracker",
        "service.version": DEPLOYED_VERSION,
        "deployment.environment.name": ENVIRONMENT,
    }
)

# Each signal goes to the Collector when an endpoint is configured and to the
# console otherwise, so `docker compose logs app` still works standalone.
trace_provider = TracerProvider(resource=resource)
trace_provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter() if OTLP_ENDPOINT else ConsoleSpanExporter()
    )
)
trace.set_tracer_provider(trace_provider)

# A metric reader needs a *metric* exporter. Handing it a span exporter is a
# real crash, not a cosmetic typo: the reader reads _preferred_temporality off
# whatever it is given, so collection dies with an AttributeError.
metric_reader = PeriodicExportingMetricReader(
    OTLPMetricExporter() if OTLP_ENDPOINT else ConsoleMetricExporter(),
    export_interval_millis=EXPORT_INTERVAL_MS,
)
metrics.set_meter_provider(
    MeterProvider(resource=resource, metric_readers=[metric_reader])
)

logger_provider = LoggerProvider(resource=resource)
logger_provider.add_log_record_processor(
    BatchLogRecordProcessor(
        OTLPLogExporter() if OTLP_ENDPOINT else ConsoleLogRecordExporter()
    )
)
set_logger_provider(logger_provider)

# Attach trace correlation ids to every log line so Loki can jump to Tempo.
LoggingInstrumentor().instrument()

logger = logging.getLogger("order-tracker")
logging.getLogger().addHandler(
    LoggingHandler(logger_provider=logger_provider, level=logging.INFO)
)

tracer = trace.get_tracer("order-tracker")
meter = metrics.get_meter("order-tracker")
request_counter = meter.create_counter(
    "http.requests",
    unit="1",
    description="HTTP requests by method, templatized route and status code",
)


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def init_db():
    with connect() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                customer TEXT NOT NULL,
                item TEXT NOT NULL,
                priority TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            )"""
        )
        if db.execute("SELECT COUNT(*) FROM orders").fetchone()[0] == 0:
            now = datetime.now(timezone.utc)
            previous_month_end = now.replace(day=1) - timedelta(days=1)
            for order in (
                ("standard-1001", "Avery", "Notebook", "standard", "received", now),
                (
                    "express-1002",
                    "Sam",
                    "Headphones",
                    "express",
                    "preparing",
                    previous_month_end,
                ),
                ("standard-1003", "Riley", "Water bottle", "standard", "shipped", now),
            ):
                db.execute(
                    "INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)",
                    (*order[:5], order[5].isoformat()),
                )


def as_dict(row):
    return dict(row) if row else None


def order_detail(row):
    order = as_dict(row)
    if order["priority"] == "express":
        placed_at = datetime.fromisoformat(order["created_at"])
        # Add the interval, never the day-of-month: an order placed on the 31st
        # would ask replace() for day 33 and raise ValueError.
        estimated_at = placed_at + timedelta(days=2)
        order["estimated_delivery"] = estimated_at.date().isoformat()
    return order


class NewOrder(BaseModel):
    customer: str = Field(min_length=1, max_length=80)
    item: str = Field(min_length=1, max_length=120)
    priority: str = "standard"


class StatusUpdate(BaseModel):
    status: str


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    logger.info("order-tracker started", extra={"environment": ENVIRONMENT})
    yield


app = FastAPI(title="Order Tracker", lifespan=lifespan)


class RequestMetricsMiddleware:
    """Pure ASGI middleware recording one metric, log and span per request.

    Deliberately ASGI rather than BaseHTTPMiddleware: on an unhandled exception
    BaseHTTPMiddleware never returns a response object to the caller, so a
    dispatch() that reads `response.status_code` after `await call_next()`
    records nothing for the 500s. Those are exactly the events the alert rule
    exists to catch, so the metric would go quiet precisely when it mattered.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        status_holder = {"status": 500}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:  # Starlette re-raises after sending 500
            status_holder["status"] = 500
            logger.exception(
                "unhandled error while serving request",
                extra={"http.route": scope.get("path", "")},
            )
            raise
        finally:
            # FastAPI puts the matched route on the scope while routing, so the
            # templatized path is only readable after the call returns. Using the
            # literal URL here would give every order id its own label.
            route = scope.get("route")
            route_path = getattr(route, "path", None) or scope.get("path", "unknown")
            status = status_holder["status"]
            request_counter.add(
                1,
                {
                    "http.request.method": scope.get("method", "UNKNOWN"),
                    "http.route": route_path,
                    "http.response.status_code": status,
                },
            )
            level = (
                logging.ERROR
                if status >= 500
                else logging.WARNING
                if status >= 400
                else logging.INFO
            )
            logger.log(
                level,
                "request completed",
                extra={
                    "http.route": route_path,
                    "http.response.status_code": status,
                },
            )


app.add_middleware(RequestMetricsMiddleware)
FastAPIInstrumentor.instrument_app(app)


@app.get("/")
def index():
    return FileResponse(Path(__file__).parent.parent / "static" / "index.html")


@app.get("/healthz")
def health():
    with connect() as db:
        db.execute("SELECT 1")
    return {"status": "ok"}


@app.get("/api/orders")
def list_orders():
    with connect() as db:
        rows = db.execute("SELECT * FROM orders ORDER BY created_at DESC").fetchall()
    return [as_dict(row) for row in rows]


@app.get("/api/orders/{order_id}")
def get_order(order_id: str):
    with connect() as db:
        row = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Order not found")
    return order_detail(row)


@app.post("/api/orders", status_code=201)
def create_order(order: NewOrder):
    if order.priority not in {"standard", "express"}:
        raise HTTPException(422, "Priority must be standard or express")
    order_id = str(uuid4())
    with connect() as db:
        db.execute(
            "INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)",
            (
                order_id,
                order.customer,
                order.item,
                order.priority,
                "received",
                datetime.now(timezone.utc).isoformat(),
            ),
        )
    return get_order(order_id)


@app.patch("/api/orders/{order_id}")
def update_status(order_id: str, update: StatusUpdate):
    if update.status not in STATUSES:
        raise HTTPException(422, "Invalid status")
    with connect() as db:
        cursor = db.execute(
            "UPDATE orders SET status = ? WHERE id = ?",
            (update.status, order_id),
        )
    if cursor.rowcount == 0:
        raise HTTPException(404, "Order not found")
    return get_order(order_id)
