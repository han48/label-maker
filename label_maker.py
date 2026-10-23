"""Run the local label editor at http://127.0.0.1:8765/."""

import base64
import json
import math
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Generator
from urllib.parse import urlparse

import qrcode
import serial
from PIL import Image

from print_label import make_tspl_image


ROOT = Path(__file__).resolve().parent
TEMPLATE_DIR = ROOT / "static" / "labels" / "templates"
STICKER_DIR = ROOT / "static" / "stickers"
MODEL_DIR = ROOT / "static" / "models"
DATABASE_PATH = ROOT / "label-studio.sqlite3"
ENV_PATH = ROOT / "printer.env"
HOST = "0.0.0.0"
PORT = 8765
DOTS_PER_MM = 8
MAX_REQUEST_BYTES = 12_000_000
MAX_TEMPLATE_BYTES = 2_000_000
MAX_TEMPLATE_ELEMENTS = 200
MAX_TEMPLATE_NAME_LENGTH = 80
USER_ID_PATTERN = re.compile(r"data:image/png;base64,[A-Za-z0-9+/]+={0,2}")
PRINTER_SERIAL_LOCK = threading.Lock()
STATIC_FILES = {
    "/": ("static/index.html", "text/html; charset=utf-8"),
    "/static/index.html": ("static/index.html", "text/html; charset=utf-8"),
    "/static/css/app.css": ("static/css/app.css", "text/css; charset=utf-8"),
    "/static/css/fontawesome.css": (
        "static/css/fontawesome.css",
        "text/css; charset=utf-8",
    ),
    "/static/js/i18n.js": ("static/js/i18n.js", "text/javascript; charset=utf-8"),
    "/static/js/editor.js": ("static/js/editor.js", "text/javascript; charset=utf-8"),
    "/static/js/image-edit-worker.js": (
        "static/js/image-edit-worker.js",
        "text/javascript; charset=utf-8",
    ),
    "/static/js/background-removal-worker.js": (
        "static/js/background-removal-worker.js",
        "text/javascript; charset=utf-8",
    ),
    "/static/js/finger-id.js": (
        "static/js/finger-id.js",
        "text/javascript; charset=utf-8",
    ),
    "/static/fonts/fa-solid-900.woff2": (
        "static/fonts/fa-solid-900.woff2",
        "font/woff2",
    ),
    "/static/images/coffee-bag.svg": (
        "static/images/coffee-bag.svg",
        "image/svg+xml; charset=utf-8",
    ),
    "/static/images/cocoa-bag.svg": (
        "static/images/cocoa-bag.svg",
        "image/svg+xml; charset=utf-8",
    ),
}


@contextmanager
def database_connection() -> Generator[sqlite3.Connection, None, None]:
    connection = sqlite3.connect(DATABASE_PATH, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS user_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                design_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (user_id, name)
            )
            """
        )
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def validate_user_id(value: object) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 64_000
        or USER_ID_PATTERN.fullmatch(value) is None
    ):
        raise ValueError("A valid fingerprint user ID is required.")
    encoded = value.partition(",")[2]
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise ValueError("A valid fingerprint user ID is required.") from error
    if len(encoded) % 4 or not decoded.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("A valid fingerprint user ID is required.")
    return value


def is_finite_number(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def validate_template_design(value: object) -> str:
    if not isinstance(value, dict):
        raise ValueError("Template design must be a JSON object.")
    width = value.get("widthMm")
    height = value.get("heightMm")
    if (
        not is_finite_number(width)
        or not 0 < width <= 300
        or not is_finite_number(height)
        or not 0 < height <= 300
    ):
        raise ValueError("Template dimensions must be between 0 and 300 mm.")
    elements = value.get("elements")
    if not isinstance(elements, list) or len(elements) > MAX_TEMPLATE_ELEMENTS:
        raise ValueError(
            f"Template must contain no more than {MAX_TEMPLATE_ELEMENTS} elements."
        )
    if any(
        not isinstance(element, dict)
        or not isinstance(element.get("id"), str)
        or not isinstance(element.get("type"), str)
        for element in elements
    ):
        raise ValueError("Template elements must have string IDs and types.")
    safe_margin = value.get("safeMarginMm", 2)
    if (
        not is_finite_number(safe_margin)
        or safe_margin < 0
        or safe_margin * 2 >= min(width, height)
    ):
        raise ValueError("Template safe margin is invalid.")
    dynamic_csv = value.get("dynamicCsv", "")
    if not isinstance(dynamic_csv, str):
        raise ValueError("Template dynamicCsv must be text.")
    try:
        design_json = json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError("Template design contains unsupported values.") from error
    if len(design_json.encode("utf-8")) > MAX_TEMPLATE_BYTES:
        raise ValueError("Template design is too large.")
    return design_json


def load_printer_config() -> dict[str, str]:
    if not ENV_PATH.is_file():
        raise FileNotFoundError(
            "printer.env was not found. Run detect_printer.py first."
        )
    config: dict[str, str] = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            config[key.strip()] = value.strip()
    required = (
        "PRINTER_PORT",
        "PRINTER_BAUDRATE",
        "LABEL_WIDTH_MM",
        "LABEL_HEIGHT_MM",
        "LABEL_GAP_MM",
    )
    missing = [key for key in required if not config.get(key)]
    if missing:
        raise ValueError(f"Missing printer.env settings: {', '.join(missing)}")
    return config


class LabelMakerHandler(BaseHTTPRequestHandler):
    server_version = "LabelMaker/1.0"

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")

    def send_json(self, status: int, data: dict[str, object]) -> None:
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self) -> dict[str, object]:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            raise ValueError("Request body is empty or too large.")
        body = json.loads(self.rfile.read(content_length))
        if not isinstance(body, dict):
            raise ValueError("Expected a JSON object.")
        return body

    def do_GET(self) -> None:
        request = urlparse(self.path)
        path = request.path
        if path == "/api/printer-status":
            try:
                config = load_printer_config()
            except (OSError, ValueError):
                self.send_json(200, {"state": "unconfigured"})
                return
            status_script = (
                "import serial, sys\n"
                "with serial.Serial(sys.argv[1], baudrate=int(sys.argv[2]), "
                "timeout=0.75, write_timeout=0.75) as printer:\n"
                " connected = None\n"
                " try:\n"
                "  connected = printer.cd or printer.dsr\n"
                " except (OSError, serial.SerialException):\n"
                "  pass\n"
                " printer.reset_input_buffer()\n"
                " printer.write(b'~!T')\n"
                " printer.flush()\n"
                " print(f'{int(connected) if connected is not None else -1}:'"
                " f'{printer.read(1).hex()}')\n"
            )
            try:
                with PRINTER_SERIAL_LOCK:
                    result = subprocess.run(
                        [
                            sys.executable,
                            "-c",
                            status_script,
                            config["PRINTER_PORT"],
                            config["PRINTER_BAUDRATE"],
                        ],
                        capture_output=True,
                        check=False,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                        text=True,
                        timeout=2.5,
                    )
            except subprocess.TimeoutExpired:
                self.send_json(200, {"state": "offline"})
                return
            except OSError:
                self.send_json(200, {"state": "unknown"})
                return
            if result.returncode != 0:
                self.send_json(200, {"state": "offline"})
                return
            try:
                connected_text, status_hex = result.stdout.strip().split(":", 1)
                connected = int(connected_text)
                status = bytes.fromhex(status_hex)
            except (ValueError, TypeError):
                self.send_json(200, {"state": "unknown"})
                return
            if status:
                self.send_json(
                    200,
                    {
                        "state": "ready" if status[0] == 0 else "not-ready",
                        "statusCode": status[0],
                    },
                )
            elif connected == 1:
                self.send_json(200, {"state": "connected"})
            elif connected == 0:
                self.send_json(200, {"state": "offline"})
            else:
                self.send_json(200, {"state": "unknown"})
            return

        if path == "/api/config":
            try:
                config = load_printer_config()
                self.send_json(
                    200,
                    {
                        "port": config["PRINTER_PORT"],
                        "baudrate": int(config["PRINTER_BAUDRATE"]),
                        "widthMm": float(config["LABEL_WIDTH_MM"]),
                        "heightMm": float(config["LABEL_HEIGHT_MM"]),
                        "gapMm": float(config["LABEL_GAP_MM"]),
                    },
                )
            except (OSError, ValueError) as error:
                self.send_json(500, {"error": str(error)})
            return

        if path == "/api/user-templates":
            try:
                user_id = validate_user_id(self.headers.get("X-Finger-ID"))
                with database_connection() as connection:
                    rows = connection.execute(
                        """
                        SELECT id, name, created_at
                        FROM user_templates
                        WHERE user_id = ?
                        ORDER BY created_at DESC, id DESC
                        """,
                        (user_id,),
                    ).fetchall()
                self.send_json(
                    200,
                    {
                        "templates": [
                            {
                                "id": row["id"],
                                "name": row["name"],
                                "createdAt": row["created_at"],
                            }
                            for row in rows
                        ]
                    },
                )
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            except sqlite3.Error:
                self.log_error("User template database read failed.")
                self.send_json(500, {"error": "Could not read saved templates."})
            return

        user_template_prefix = "/api/user-templates/"
        if path.startswith(user_template_prefix):
            try:
                user_id = validate_user_id(self.headers.get("X-Finger-ID"))
                template_id = self.parse_template_id(
                    path.removeprefix(user_template_prefix)
                )
                with database_connection() as connection:
                    row = connection.execute(
                        """
                        SELECT id, name, design_json, created_at
                        FROM user_templates
                        WHERE id = ? AND user_id = ?
                        """,
                        (template_id, user_id),
                    ).fetchone()
                if row is None:
                    self.send_json(404, {"error": "Saved template not found."})
                else:
                    self.send_json(
                        200,
                        {
                            "id": row["id"],
                            "name": row["name"],
                            "createdAt": row["created_at"],
                            "design": json.loads(row["design_json"]),
                        },
                    )
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            except sqlite3.Error:
                self.log_error("User template database read failed.")
                self.send_json(500, {"error": "Could not read the saved template."})
            return

        static_file = STATIC_FILES.get(path)
        if static_file is None:
            model_prefix = "/static/models/"
            if path.startswith(model_prefix):
                model_path = (MODEL_DIR / path.removeprefix(model_prefix)).resolve()
                if (
                    model_path.is_relative_to(MODEL_DIR.resolve())
                    and model_path.is_file()
                ):
                    content_type = (
                        "application/json; charset=utf-8"
                        if model_path.suffix.lower() == ".json"
                        else "application/octet-stream"
                    )
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(model_path.stat().st_size))
                    self.send_header("Cache-Control", "public, max-age=31536000, immutable")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.end_headers()
                    with model_path.open("rb") as model_file:
                        while chunk := model_file.read(1024 * 1024):
                            self.wfile.write(chunk)
                    return
            sticker_prefix = "/static/stickers/"
            if path.startswith(sticker_prefix):
                sticker_name = path.removeprefix(sticker_prefix)
                sticker_file = (STICKER_DIR / sticker_name).resolve()
                if (
                    sticker_name
                    and Path(sticker_name).name == sticker_name
                    and sticker_file.parent == STICKER_DIR.resolve()
                    and sticker_file.is_file()
                ):
                    content_type = (
                        "image/svg+xml; charset=utf-8"
                        if sticker_file.suffix.lower() == ".svg"
                        else "text/plain; charset=utf-8"
                    )
                    content = sticker_file.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(content)))
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.end_headers()
                    self.wfile.write(content)
                    return
            template_prefix = "/static/labels/templates/"
            if path.startswith(template_prefix):
                template_name = path.removeprefix(template_prefix)
                template_file = (TEMPLATE_DIR / template_name).resolve()
                if (
                    template_name
                    and Path(template_name).name == template_name
                    and template_file.parent == TEMPLATE_DIR.resolve()
                    and template_file.is_file()
                ):
                    content = template_file.read_bytes()
                    self.send_response(200)
                    self.send_header(
                        "Content-Type", "application/json; charset=utf-8"
                    )
                    self.send_header("Content-Length", str(len(content)))
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.end_headers()
                    self.wfile.write(content)
                    return
            self.send_error(404)
            return
        filename, content_type = static_file
        content = (ROOT / filename).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            body = self.read_json()
            if path == "/api/qr":
                value = body.get("value")
                if not isinstance(value, str) or not value or len(value) > 2048:
                    raise ValueError("QR content must be between 1 and 2048 characters.")
                qr = qrcode.QRCode(
                    error_correction=qrcode.constants.ERROR_CORRECT_M,
                    box_size=6,
                    border=4,
                )
                qr.add_data(value)
                qr.make(fit=True)
                image = qr.make_image(fill_color="black", back_color="white")
                from io import BytesIO

                buffer = BytesIO()
                image.save(buffer, format="PNG")
                encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
                self.send_json(200, {"dataUrl": f"data:image/png;base64,{encoded}"})
                return

            if path == "/api/print":
                self.print_label(body)
                return

            if path == "/api/user-templates":
                self.save_user_template(body)
                return

            self.send_error(404)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "A template with this name already exists."})
        except sqlite3.Error:
            self.log_error("User template database write failed.")
            self.send_json(500, {"error": "Could not save the template."})
        except (OSError, serial.SerialException) as error:
            self.send_json(502, {"error": f"Printer error: {error}"})

    def do_DELETE(self) -> None:
        request = urlparse(self.path)
        prefix = "/api/user-templates/"
        if not request.path.startswith(prefix):
            self.send_error(404)
            return
        try:
            user_id = validate_user_id(self.headers.get("X-Finger-ID"))
            template_id = self.parse_template_id(request.path.removeprefix(prefix))
            with database_connection() as connection:
                cursor = connection.execute(
                    "DELETE FROM user_templates WHERE id = ? AND user_id = ?",
                    (template_id, user_id),
                )
            if cursor.rowcount == 0:
                self.send_json(404, {"error": "Saved template not found."})
            else:
                self.send_json(200, {"deleted": True})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except sqlite3.Error:
            self.log_error("User template database delete failed.")
            self.send_json(500, {"error": "Could not delete the saved template."})

    def save_user_template(self, body: dict[str, object]) -> None:
        user_id = validate_user_id(self.headers.get("X-Finger-ID"))
        name = body.get("name")
        if not isinstance(name, str):
            raise ValueError("Template name is required.")
        name = name.strip()
        if not name or len(name) > MAX_TEMPLATE_NAME_LENGTH:
            raise ValueError(
                f"Template name must be between 1 and {MAX_TEMPLATE_NAME_LENGTH} characters."
            )
        design_json = validate_template_design(body.get("design"))
        with database_connection() as connection:
            cursor = connection.execute(
                """
                INSERT INTO user_templates (user_id, name, design_json)
                VALUES (?, ?, ?)
                """,
                (user_id, name, design_json),
            )
            template_id = cursor.lastrowid
        self.send_json(201, {"id": template_id, "name": name})

    @staticmethod
    def parse_template_id(value: str) -> int:
        if not value.isdecimal():
            raise ValueError("Invalid saved template ID.")
        return int(value)

    def print_label(self, body: dict[str, object]) -> None:
        config = load_printer_config()
        width_mm = self.positive_number(body.get("widthMm"), "label width")
        height_mm = self.positive_number(body.get("heightMm"), "label height")
        gap_mm = self.positive_number(body.get("gapMm"), "label gap", allow_zero=True)
        image_data = body.get("image")
        if not isinstance(image_data, str) or not image_data.startswith(
            "data:image/png;base64,"
        ):
            raise ValueError("Expected a PNG image for printing.")
        encoded = image_data.partition(",")[2]
        try:
            png = base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise ValueError("The print image is not valid base64.") from error
        max_pixels = math.ceil(width_mm * DOTS_PER_MM) * math.ceil(
            height_mm * DOTS_PER_MM
        )
        if len(png) > MAX_REQUEST_BYTES or max_pixels > 6_000_000:
            raise ValueError("Label dimensions or image are too large.")

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as image_file:
            image_path = Path(image_file.name)
            image_file.write(png)

        try:
            with Image.open(image_path) as image:
                if image.format != "PNG":
                    raise ValueError("The print image could not be decoded as PNG.")
            tspl = make_tspl_image(
                {
                    **config,
                    "LABEL_WIDTH_MM": f"{width_mm:g}",
                    "LABEL_HEIGHT_MM": f"{height_mm:g}",
                    "LABEL_GAP_MM": f"{gap_mm:g}",
                },
                image_path,
            )
        finally:
            image_path.unlink(missing_ok=True)

        baudrate = int(config["PRINTER_BAUDRATE"])
        with PRINTER_SERIAL_LOCK:
            with serial.Serial(
                config["PRINTER_PORT"],
                baudrate=baudrate,
                timeout=2,
                write_timeout=30,
            ) as printer:
                sent = printer.write(tspl)
                printer.flush()
        if sent != len(tspl):
            raise OSError(f"Only sent {sent} of {len(tspl)} bytes to the printer.")
        self.send_json(
            200,
            {
                "message": f"Print data sent to {config['PRINTER_PORT']}.",
                "port": config["PRINTER_PORT"],
                "bytes": sent,
            },
        )

    @staticmethod
    def positive_number(
        value: object, name: str, *, allow_zero: bool = False
    ) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{name.capitalize()} must be a number.")
        result = float(value)
        if not math.isfinite(result) or result < 0 or (result == 0 and not allow_zero):
            qualifier = "zero or greater" if allow_zero else "greater than zero"
            raise ValueError(f"{name.capitalize()} must be {qualifier}.")
        return result


if __name__ == "__main__":
    print(f"Label editor: http://{HOST}:{PORT}/")
    print("Press Ctrl+C to stop the local server.")
    ThreadingHTTPServer((HOST, PORT), LabelMakerHandler).serve_forever()
