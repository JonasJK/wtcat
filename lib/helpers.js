export function normaliseUrl(url) {
  return /^[a-z][a-z0-9.+-]*:\/\//i.test(url) ? url : `https://${url}`;
}

export function buildHeaders(headerList = [], auth = null) {
  const headers = {};
  for (const h of headerList) {
    const i = h.indexOf(":");
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  if (auth) headers.Authorization = "Basic " + Buffer.from(auth).toString("base64");
  return headers;
}

export async function drainReadable(readable, emitter) {
  try {
    const reader = readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) emitter.emit("message", Buffer.from(value));
    }
  } catch (err) {
    emitter.emit("stream-error", err);
  }
}

export async function readAll(reader) {
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function bidiRoundTrip(transport, message) {
  const stream = await transport.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  await writer.write(Buffer.from(message, "utf8"));
  await writer.close();
  return readAll(stream.readable.getReader());
}

export async function sendOnlyTrip(transport, message) {
  const stream = await transport.createUnidirectionalStream();
  const writer = stream.getWriter();
  await writer.write(Buffer.from(message, "utf8"));
  await writer.close();
}
