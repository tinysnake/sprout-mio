// Newline-delimited JSON framing over a TCP socket. One frame per line.
// Unknown or malformed lines are dropped, not interpreted.

export function encodeFrame(frame) {
  return `${JSON.stringify({ v: 1, ...frame })}\n`;
}

export function createFrameReader(onFrame) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim() === '') continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame.v !== 1 || typeof frame.kind !== 'string') continue;
      onFrame(frame);
    }
  };
}
