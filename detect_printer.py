import math
from pathlib import Path

from serial.tools import list_ports


PRINTER_BLUETOOTH_ADDRESS = "86677A009D38"
BAUDRATE = 9600


def ask_measurement(prompt: str, *, allow_zero: bool = False) -> float:
    while True:
        raw_value = input(prompt).strip()
        try:
            value = float(raw_value)
        except ValueError:
            print("Enter a numeric value in millimeters.")
            continue

        if not math.isfinite(value) or value < 0 or (value == 0 and not allow_zero):
            qualifier = "zero or greater" if allow_zero else "greater than zero"
            print(f"Enter a finite value {qualifier}.")
            continue
        return value


def main() -> None:
    target = PRINTER_BLUETOOTH_ADDRESS.replace(":", "").upper()
    matches = [
        port.device
        for port in list_ports.comports()
        if target in port.hwid.replace(":", "").upper()
    ]

    if not matches:
        raise RuntimeError(
            "PT-260 was not found. Turn on the printer and pair it with Windows."
        )
    if len(matches) > 1:
        raise RuntimeError(f"Multiple ports matched the PT-260: {matches}")

    print("Enter the measurements of the label roll in millimeters.")
    label_width = ask_measurement("Label width (mm): ")
    label_height = ask_measurement("Label height (mm): ")
    label_gap = ask_measurement("Gap between labels (mm, 0 for continuous media): ", allow_zero=True)

    env_path = Path(__file__).with_name("printer.env")
    env_path.write_text(
        "\n".join(
            (
                f"PRINTER_PORT={matches[0]}",
                f"PRINTER_BAUDRATE={BAUDRATE}",
                f"PRINTER_BLUETOOTH_ADDRESS={PRINTER_BLUETOOTH_ADDRESS}",
                f"LABEL_WIDTH_MM={label_width:g}",
                f"LABEL_HEIGHT_MM={label_height:g}",
                f"LABEL_GAP_MM={label_gap:g}",
                "",
            )
        ),
        encoding="utf-8",
    )
    print(f"PT-260 detected at {matches[0]}.")
    print(f"Configuration saved to {env_path}.")


if __name__ == "__main__":
    main()
