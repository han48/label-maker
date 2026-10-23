import argparse
import sys
import textwrap
from pathlib import Path
from typing import Sequence

import serial
from PIL import Image, ImageOps


ENV_PATH = Path(__file__).with_name("printer.env")
MAX_LINES = 7
LINE_WIDTH = 22
LINE_SPACING_DOTS = 30
START_Y_DOTS = 10
DOTS_PER_MM = 8


def load_config() -> dict[str, str]:
    if not ENV_PATH.is_file():
        raise FileNotFoundError(
            f"{ENV_PATH} was not found. Run detect_printer.py first."
        )

    config: dict[str, str] = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            key, separator, value = line.partition("=")
            if separator:
                config[key.strip()] = value.strip()

    required = ("PRINTER_PORT", "PRINTER_BAUDRATE", "LABEL_WIDTH_MM",
                "LABEL_HEIGHT_MM", "LABEL_GAP_MM")
    missing = [key for key in required if not config.get(key)]
    if missing:
        raise ValueError(f"Missing printer.env settings: {', '.join(missing)}")
    return config


def read_label_text() -> str:
    print("Enter label text; press Enter on a blank line to finish:")
    lines: list[str] = []
    while True:
        line = input()
        if not line:
            break
        lines.append(line)

    content = "\n".join(lines).strip()
    if not content:
        raise ValueError("Label text cannot be empty.")
    return content


def make_tspl(config: dict[str, str], content: str) -> bytes:
    lines: list[str] = []
    for paragraph in content.splitlines():
        lines.extend(textwrap.wrap(paragraph, width=LINE_WIDTH) or [""])
    if len(lines) > MAX_LINES:
        raise ValueError(
            f"Text is too long: this label supports up to {MAX_LINES} lines "
            f"(about {LINE_WIDTH} characters per line)."
        )

    commands = [
        f"SIZE {config['LABEL_WIDTH_MM']} mm,{config['LABEL_HEIGHT_MM']} mm",
        f"GAP {config['LABEL_GAP_MM']} mm,0 mm",
        "CLS",
        "CODEPAGE UTF-8",
    ]
    for index, line in enumerate(lines):
        safe_line = line.replace('"', "'")
        y = START_Y_DOTS + index * LINE_SPACING_DOTS
        commands.append(f'TEXT 10,{y},"3",0,1,1,"{safe_line}"')
    commands.append("PRINT 1,1")
    return ("\r\n".join(commands) + "\r\n").encode("utf-8")


def make_tspl_image(
    config: dict[str, str],
    image_path: Path,
    *,
    dither: bool = False,
) -> bytes:
    label_width = round(float(config["LABEL_WIDTH_MM"]) * DOTS_PER_MM)
    label_height = round(float(config["LABEL_HEIGHT_MM"]) * DOTS_PER_MM)
    bitmap_width = (label_width + 7) // 8 * 8

    with Image.open(image_path) as source:
        rgba = source.convert("RGBA")
        background = Image.new("RGBA", rgba.size, "white")
        background.alpha_composite(rgba)
        grayscale = ImageOps.grayscale(background)
        resized = ImageOps.contain(
            grayscale,
            (label_width, label_height),
            method=Image.Resampling.LANCZOS,
        )
        dithering = Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE
        monochrome = resized.convert("1", dither=dithering)

    canvas = Image.new("1", (bitmap_width, label_height), 1)
    x = (label_width - monochrome.width) // 2
    y = (label_height - monochrome.height) // 2
    canvas.paste(monochrome, (x, y))

    pixels = canvas.load()
    bitmap = bytearray()
    for row in range(label_height):
        for byte_column in range(bitmap_width // 8):
            value = 0
            for bit in range(8):
                if pixels[byte_column * 8 + bit, row] != 0:
                    value |= 1 << (7 - bit)
            bitmap.append(value)

    header = (
        f"SIZE {config['LABEL_WIDTH_MM']} mm,{config['LABEL_HEIGHT_MM']} mm\r\n"
        f"GAP {config['LABEL_GAP_MM']} mm,0 mm\r\n"
        "CLS\r\n"
        f"BITMAP 0,0,{bitmap_width // 8},{label_height},0,"
    ).encode("ascii")
    return header + bytes(bitmap) + b"\r\nPRINT 1,1\r\n"


def read_print_job(config: dict[str, str]) -> bytes:
    print("Choose print type: 1 = text, 2 = image")
    choice = input("> ").strip()

    if choice == "1":
        return make_tspl(config, read_label_text())
    if choice == "2":
        image_path = Path(input("Image file path: ").strip().strip('"')).expanduser()
        if not image_path.is_file():
            raise FileNotFoundError(f"Image file was not found: {image_path}")
        return make_tspl_image(config, image_path)
    raise ValueError("Choose 1 for text or 2 for image.")


def parse_print_job(config: dict[str, str], args: Sequence[str]) -> bytes:
    parser = argparse.ArgumentParser(
        description="Print text or an image on the configured label printer."
    )
    job = parser.add_mutually_exclusive_group(required=True)
    job.add_argument("--text", help="Text to print on the label.")
    job.add_argument(
        "--image",
        type=Path,
        help="Image file to print, fitted and centered on the label.",
    )
    parser.add_argument(
        "--dither",
        action="store_true",
        help="Use dithering for grayscale photos (may reduce QR/barcode clarity).",
    )
    parsed = parser.parse_args(args)

    if parsed.text is not None:
        return make_tspl(config, parsed.text)
    image_path = parsed.image.expanduser()
    if not image_path.is_file():
        raise FileNotFoundError(f"Image file was not found: {image_path}")
    return make_tspl_image(config, image_path, dither=parsed.dither)


def main(argv: Sequence[str] | None = None) -> None:
    """Print a label from CLI text/image input, or prompt when run without arguments.

    Examples:
        python print_label.py --text "Product name and price"
        python print_label.py --image ".\\sample.png"
        python print_label.py --image ".\\photo.jpg" --dither
    """
    config = load_config()
    args = list(argv) if argv is not None else sys.argv[1:]
    data = read_print_job(config) if not args else parse_print_job(config, args)

    port = config["PRINTER_PORT"]
    baudrate = int(config["PRINTER_BAUDRATE"])
    with serial.Serial(port, baudrate=baudrate, timeout=2, write_timeout=3) as printer:
        sent = printer.write(data)
        printer.flush()

    if sent != len(data):
        raise IOError(f"Chỉ gửi được {sent}/{len(data)} byte tới {port}.")
    print(f"Print command sent to PT-260 via {port}.")


if __name__ == "__main__":
    main()
