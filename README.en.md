# Label Studio

[English](README.en.md) · [Tiếng Việt](README.md) · [日本語](README.ja.md)

A label design and printing application for the PT-260 thermal label printer.
The project includes a locally hosted web interface and a command-line tool for
printing text or images.

## Features

- Design labels from built-in templates or start with a blank label.
- Add text and images, create QR codes, edit images, remove backgrounds, and
  select image regions.
- Preview and export PNG/PDF, save designs, and print directly to the PT-260.
- Use dynamic data to preview and print batches of labels.
- Interface available in Vietnamese, English, and Japanese.
- Save personal templates in a local SQLite database.

## Requirements

- Windows and Python 3.10 or later.
- The PT-260 printer paired with the computer over Bluetooth (for printing).
- Internet access to download ONNX models the first time and load JavaScript
  libraries from the CDN.

## Test device

The project was tested with a PT-260 thermal label printer. The compact black
printer has a front display and control buttons and uses rolls of thermal label
paper. It connects to the computer over Bluetooth. Configure the label size and
gap to match the roll being used.

![PT-260 thermal label printer and label roll used for testing](static/images/device.png)

## Installation

In PowerShell, from the project directory, create a virtual environment and
install the Python dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install Pillow pyserial qrcode
```

If PowerShell does not allow virtual environment activation, invoke
`.\.venv\Scripts\python.exe` directly instead of `python`.

## Configure the printer

Pair the PT-260 with Windows, then run:

```powershell
python detect_printer.py
```

Enter the label dimensions and the gap between labels in millimeters. The script
detects the printer port and writes the settings to `printer.env`. Git ignores
this file because its values are specific to each machine.

## Start the design interface

```powershell
python label_maker.py
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765) in a browser. Stop the
server with `Ctrl+C`.

The server listens on all network interfaces (`0.0.0.0`). Run it only on a
trusted network and do not expose this port to the Internet.

### Download ONNX models

Large ONNX files are not stored in Git. Download them before using the image
region selection and background removal features:

```powershell
python download_models.py
```

The script saves the models under `static/models/`, skips existing files, and
replaces a destination only after a successful download. Use
`python download_models.py --force` to download them again. Model revisions are
pinned; sources and license details are documented in
[static/models/README.txt](static/models/README.txt).

## Print from the command line

After configuring the printer, print text:

```powershell
python print_label.py --text "Product name - 25.00"
```

Print an image:

```powershell
python print_label.py --image ".\static\images\sample.png"
```

For grayscale photographs, dithering can be enabled:

```powershell
python print_label.py --image ".\static\images\sample.png" --dither
```

Run `python print_label.py` without arguments to enter a print job interactively.

## Data and licenses

- Label designs are stored locally in `label-studio.sqlite3`. Personal
  templates are associated with a browser fingerprint; it is not a secure
  account.
- `printer.env`, the SQLite database, and `*.onnx` files are excluded from Git.
- RMBG-1.4 is provided under default terms that restrict commercial use. Review
  the license in [static/models/README.txt](static/models/README.txt) and obtain
  an appropriate license from BRIA before commercial use or distribution.
- OpenMoji sticker attribution and license information are provided in
  [static/stickers/ATTRIBUTION.txt](static/stickers/ATTRIBUTION.txt) and
  `static/stickers/OPENMOJI-LICENSE.txt`.

## Project structure

```text
label_maker.py       Local web interface and API server
print_label.py       TSPL generation and command-line label printing
detect_printer.py    Printer detection and printer.env setup
download_models.py   Downloads ONNX models to static/models/
static/              Interface, label templates, stickers, and model configs
```
