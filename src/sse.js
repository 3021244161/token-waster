/** Drop slow readers instead of accumulating unbounded telemetry buffers. */
export function writeSse(response, payload) {
  try {
    if (response.write(payload)) return true;
  } catch {
    // A disconnected reader must not interrupt the run or other subscribers.
  }
  response.destroy();
  return false;
}
