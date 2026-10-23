Local image models

The ONNX files are excluded from Git because of their size. From the repository
root, download them with:

    python download_models.py

Existing non-empty files are kept. Use `python download_models.py --force` to
download them again. The script uses only the Python standard library.

SAM
- Model: Xenova/slimsam-77-uniform
- Revision: 5850ab45f587c112167512ffef949107115e26a0
- License: Apache-2.0
- Source: https://huggingface.co/Xenova/slimsam-77-uniform

Background removal
- Model: briaai/RMBG-1.4
- Revision: 2ceba5a5efaec153162aedea169f76caf9b46cf8
- License: BRIA RMBG-1.4 license
- License details and terms: https://huggingface.co/briaai/RMBG-1.4
- Source: https://huggingface.co/briaai/RMBG-1.4

RMBG-1.4 is provided for non-commercial use under its default license. Obtain
the appropriate BRIA license before using or distributing it commercially.
