const streamsById = new Map(); // id -> Set(res)

function initSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("\n");
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function subscribe(id, res) {
  initSse(res);
  if (!streamsById.has(id)) streamsById.set(id, new Set());
  streamsById.get(id).add(res);

  res.on("close", () => {
    const set = streamsById.get(id);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) streamsById.delete(id);
  });
}

function publish(id, event, data) {
  const set = streamsById.get(id);
  if (!set) return;
  for (const res of set) {
    try {
      sendEvent(res, event, data);
    } catch {
      // ignore
    }
  }
}

function closeAll(id) {
  const set = streamsById.get(id);
  if (!set) return;
  for (const res of set) {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
  streamsById.delete(id);
}

module.exports = { subscribe, publish, closeAll };

