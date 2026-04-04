const DEFAULT_MIN_WIDTH = 640;
const DEFAULT_MIN_HEIGHT = 480;
const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 960;

export function computeCanvasRenderSize(
  containerWidth,
  containerHeight,
  devicePixelRatio = 1,
  {
    minWidth = DEFAULT_MIN_WIDTH,
    minHeight = DEFAULT_MIN_HEIGHT,
    maxWidth = DEFAULT_MAX_WIDTH,
    maxHeight = DEFAULT_MAX_HEIGHT,
  } = {},
) {
  const safeWidth = Number.isFinite(containerWidth) ? Math.max(1, containerWidth) : minWidth;
  const safeHeight = Number.isFinite(containerHeight) ? Math.max(1, containerHeight) : minHeight;
  const pixelRatio = Number.isFinite(devicePixelRatio) ? Math.max(1, devicePixelRatio) : 1;

  let width = Math.round(safeWidth * pixelRatio);
  let height = Math.round(safeHeight * pixelRatio);

  const downscale = Math.min(maxWidth / width, maxHeight / height, 1);
  width = Math.max(1, Math.round(width * downscale));
  height = Math.max(1, Math.round(height * downscale));

  if (width < minWidth && height < minHeight) {
    return {
      width: minWidth,
      height: minHeight,
    };
  }

  return {
    width,
    height,
  };
}

export function syncCanvasToContainer(canvas, container, options = {}) {
  if (!canvas || !container) {
    return false;
  }

  const rect = container.getBoundingClientRect();
  const size = computeCanvasRenderSize(
    rect.width,
    rect.height,
    window.devicePixelRatio ?? 1,
    options,
  );

  if (canvas.width === size.width && canvas.height === size.height) {
    return false;
  }

  canvas.width = size.width;
  canvas.height = size.height;
  return true;
}
