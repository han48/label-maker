import argparse
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MODEL_FILES = (
    (
        "Xenova/slimsam-77-uniform",
        "5850ab45f587c112167512ffef949107115e26a0",
        "onnx/vision_encoder_quantized.onnx",
    ),
    (
        "Xenova/slimsam-77-uniform",
        "5850ab45f587c112167512ffef949107115e26a0",
        "onnx/prompt_encoder_mask_decoder_quantized.onnx",
    ),
    (
        "briaai/RMBG-1.4",
        "2ceba5a5efaec153162aedea169f76caf9b46cf8",
        "onnx/model.onnx",
    ),
)
CHUNK_SIZE = 1024 * 1024
REPORT_INTERVAL = 16 * CHUNK_SIZE


def format_size(size):
    size = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}"
        size /= 1024


def download_file(model_id, revision, filename, force=False):
    target = ROOT / "static" / "models" / model_id / filename
    if target.is_file() and target.stat().st_size > 0 and not force:
        print(f"Already present: {target.relative_to(ROOT)}")
        return

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary_file = target.with_name(target.name + ".part")
    url = f"https://huggingface.co/{model_id}/resolve/{revision}/{filename}?download=true"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "label-printer-model-downloader/1.0"},
    )
    print(f"Downloading {model_id}/{filename}")

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content_length = response.headers.get("Content-Length")
            total_size = int(content_length) if content_length and content_length.isdigit() else None
            downloaded = 0
            next_report = REPORT_INTERVAL

            with temporary_file.open("wb") as output:
                while chunk := response.read(CHUNK_SIZE):
                    output.write(chunk)
                    downloaded += len(chunk)
                    if downloaded >= next_report:
                        total = f" / {format_size(total_size)}" if total_size else ""
                        print(f"  {format_size(downloaded)}{total}")
                        next_report = downloaded + REPORT_INTERVAL

        if total_size is not None and downloaded != total_size:
            raise OSError(
                f"Incomplete download for {filename}: "
                f"received {format_size(downloaded)} of {format_size(total_size)}"
            )
        if downloaded == 0:
            raise OSError(f"Download returned an empty file: {url}")
        os.replace(temporary_file, target)
        print(f"Saved {target.relative_to(ROOT)} ({format_size(downloaded)})")
    finally:
        if temporary_file.exists():
            temporary_file.unlink()


def main():
    parser = argparse.ArgumentParser(
        description="Download the ONNX models required by the label printer."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="download files again even if they already exist",
    )
    args = parser.parse_args()

    try:
        for model_id, revision, filename in MODEL_FILES:
            download_file(model_id, revision, filename, force=args.force)
    except (OSError, urllib.error.URLError) as error:
        print(f"Model download failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
