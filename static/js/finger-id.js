/*
 * Finger ID implementation from HAN48 / MR4:
 * https://github.com/han48/mr4-lc.finger-id
 * Licensed under the MIT License; see the upstream repository's LICENSE.
 * Modified here to use canvas.toDataURL() directly as the fingerprint ID.
 */

function canvas_fingerprinting() {
    // Create hidden canvas
    var canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 30;
    canvas.style.display = "none";
    document.body.appendChild(canvas);

    // Get canvas content 2d
    var ctx = canvas.getContext("2d");
    if (!ctx) {
        document.dispatchEvent(new CustomEvent("finger-id-error"));
        document.body.removeChild(canvas);
        throw new Error("Canvas fingerprinting is unavailable.");
    }

    // Drawing text
    var txt = "BrowserLeaks,com <canvas> 1.0";
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#f60";

    // Draw rectange
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069";

    // Draw rectange
    ctx.fillRect(2, 15, 100, 10);
    ctx.fillStyle = "#b00";

    // Draw text
    ctx.fillText(txt, 2, 15);

    // Get canvas data
    let fingerprint;
    try {
        fingerprint = canvas.toDataURL();
    } catch (error) {
        document.dispatchEvent(new CustomEvent("finger-id-error"));
        document.body.removeChild(canvas);
        throw error;
    }

    // Remove canvas
    document.body.removeChild(canvas);

    const input_id = '__finger-id'
    let input = document.getElementById(input_id)
    if (undefined === input || null === input) {
        input = document.createElement('input')
        input.type = 'hidden'
        input.id = input_id
        input.name = input_id
        input.value = fingerprint
        document.body.appendChild(input);
    } else {
        input.value = fingerprint
    }

    if (undefined !== window.axios && null !== window.axios) {
        window.axios.defaults.headers.common[input_id] = fingerprint;
    }
    document.dispatchEvent(new CustomEvent("finger-id-ready", { detail: fingerprint }));
}

document.addEventListener("DOMContentLoaded", canvas_fingerprinting);
