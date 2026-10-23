import { AutoProcessor, RawImage, SamModel, Tensor, env } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.14.0";

const MODEL_ID = "Xenova/slimsam-77-uniform";
env.allowLocalModels = false;
env.remoteHost = new URL("/static/models/", self.location.origin).href;
env.remotePathTemplate = "{model}/";
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/";
env.backends.onnx.wasm.numThreads = 1;

let model;
let processor;
let imageInputs;
let imageEmbeddings;

async function initialize(useWebGPU) {
  if (model && processor) return;
  processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const modelOptions = {
    quantized: true,
    progress_callback: ({ progress }) => {
      self.postMessage({ type: "progress", progress });
    },
  };
  try {
    model = await SamModel.from_pretrained(MODEL_ID, {
      ...modelOptions,
      ...(useWebGPU ? { device: "webgpu" } : {}),
    });
  } catch (error) {
    if (!useWebGPU) throw error;
    self.postMessage({ type: "progress", progress: null });
    model = await SamModel.from_pretrained(MODEL_ID, modelOptions);
  }
  self.postMessage({ type: "ready" });
}

self.addEventListener("message", async ({ data }) => {
  try {
    if (data.type === "init") {
      await initialize(data.useWebGPU);
      return;
    }
    if (data.type === "load-image" && model && processor) {
      const rawImage = await RawImage.read(data.image);
      imageInputs = await processor(rawImage);
      imageEmbeddings = await model.get_image_embeddings({
        pixel_values: imageInputs.pixel_values,
      });
      self.postMessage({ type: "image-ready" });
      return;
    }
    if (data.type !== "segment" || !imageEmbeddings) return;

    const reshapedSize = imageInputs.reshaped_input_sizes[0];
    const coordinates = data.points.map(({ x, y }) => [
      x * reshapedSize[1],
      y * reshapedSize[0],
    ]);
    const inputPoints = new Tensor("float32", coordinates.flat(), [1, 1, coordinates.length, 2]);
    const inputLabels = new Tensor(
      "int64",
      data.points.map(({ label }) => BigInt(label)),
      [1, 1, data.points.length],
    );
    const outputs = await model({
      ...imageEmbeddings,
      input_points: inputPoints,
      input_labels: inputLabels,
    });
    const masks = await processor.post_process_masks(
      outputs.pred_masks,
      imageInputs.original_sizes,
      imageInputs.reshaped_input_sizes,
    );
    const scores = Array.from(outputs.iou_scores.data);
    const bestIndex = scores.indexOf(Math.max(...scores));
    const mask = masks[0][0][bestIndex];
    const binaryMask = new Uint8Array(mask.data.length);
    for (let index = 0; index < mask.data.length; index += 1) {
      binaryMask[index] = mask.data[index] ? 255 : 0;
    }
    self.postMessage({
      type: "mask",
      id: data.id,
      width: mask.dims[1],
      height: mask.dims[0],
      mask: binaryMask,
    }, [binaryMask.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
