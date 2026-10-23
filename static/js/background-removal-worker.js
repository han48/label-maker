import { AutoModel, AutoProcessor, RawImage, env } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.14.0";

const MODEL_ID = "briaai/RMBG-1.4";
env.allowLocalModels = false;
env.remoteHost = new URL("/static/models/", self.location.origin).href;
env.remotePathTemplate = "{model}/";
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/";
env.backends.onnx.wasm.numThreads = 1;

let model;
let processor;

async function initialize(useWebGPU, requestId) {
  const modelOptions = {
    config: { model_type: "custom" },
    quantized: false,
    progress_callback: ({ progress }) => self.postMessage({ type: "progress", id: requestId, progress }),
  };
  if (!model) {
    try {
      model = await AutoModel.from_pretrained(MODEL_ID, {
        ...modelOptions,
        ...(useWebGPU ? { device: "webgpu" } : {}),
      });
    } catch (error) {
      if (!useWebGPU) throw error;
      self.postMessage({ type: "progress", id: requestId, progress: null });
      model = await AutoModel.from_pretrained(MODEL_ID, modelOptions);
    }
  }
  if (!processor) {
    processor = await AutoProcessor.from_pretrained(MODEL_ID, {
      config: {
        do_normalize: true,
        do_pad: false,
        do_rescale: true,
        do_resize: true,
        image_mean: [0.5, 0.5, 0.5],
        feature_extractor_type: "ImageFeatureExtractor",
        image_std: [1, 1, 1],
        resample: 2,
        rescale_factor: 0.00392156862745098,
        size: { width: 1024, height: 1024 },
      },
    });
  }
}

self.addEventListener("message", async ({ data }) => {
  if (data.type !== "remove-background") return;
  try {
    if (!model || !processor) await initialize(data.useWebGPU, data.id);
    const image = await RawImage.read(data.image);
    const { pixel_values: pixelValues } = await processor(image);
    const { output } = await model({ input: pixelValues });
    const mask = await RawImage.fromTensor(output[0].mul(255).to("uint8"))
      .resize(image.width, image.height);
    const maskData = new Uint8Array(mask.data);
    self.postMessage({
      type: "mask",
      id: data.id,
      width: mask.width,
      height: mask.height,
      mask: maskData,
    }, [maskData.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
