import assert from "node:assert/strict";
import { describe, test } from "node:test";
import EventEmitter from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  bidiRoundTrip,
  buildHeaders,
  drainReadable,
  normaliseUrl,
  readAll,
} from "../lib/helpers.js";

const SUPPRESSED_WARNING_PATTERNS = [
  /Non serverCertificateHashes certificate verification is an experimental feature/i,
  /datagrams\.writable is deprecated/i,
];

const isSuppressedWarningMessage = (message) =>
  SUPPRESSED_WARNING_PATTERNS.some((pattern) => pattern.test(message));

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const message = typeof warning === "string"
    ? warning
    : (warning?.message ?? "");
  if (isSuppressedWarningMessage(message)) {
    return;
  }
  return originalEmitWarning(warning, ...args);
};

const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args) => {
  const message = args.map((arg) => String(arg)).join(" ");
  if (isSuppressedWarningMessage(message)) {
    return;
  }
  originalConsoleWarn(...args);
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ECHO_URL = process.env.ECHO_URL || "https://wt-ord.akaleapi.net:6161/echo";
const WTCAT_BIN = resolve(__dirname, "../bin/wtcat.js");
const CONNECT_TIMEOUT = 10_000;
const ROUND_TRIP_TIMEOUT = 10_000;

function timeout(ms, label = "timeout") {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms),
  );
}

function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeout(ms, label)]);
}

async function closeQuietly(transport, reason = "done") {
  try {
    await Promise.resolve(transport.close({ closeCode: 0, reason }));
  } catch (err) {
    if (process.env.WTCAT_TEST_DEBUG) {
      console.error("close failed:", err);
    }
  }
}

function makeReader(chunks) {
  let i = 0;
  return {
    async read() {
      if (i < chunks.length) return { value: chunks[i++], done: false };
      return { value: undefined, done: true };
    },
  };
}

function makeReadable(chunks) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i < chunks.length) {
            return { value: Buffer.from(chunks[i++]), done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

export function makeFakeStreamPair(echoOnClose = false) {
  const readQueue = [];
  let readDone = false;
  let readWaiting = null;

  function pushToReadable(buf) {
    if (readWaiting) {
      const r = readWaiting;
      readWaiting = null;
      r({ value: buf, done: false });
    } else {
      readQueue.push(buf);
    }
  }

  function signalReadableDone() {
    readDone = true;
    if (readWaiting) {
      const r = readWaiting;
      readWaiting = null;
      r({ value: undefined, done: true });
    }
  }

  const writtenChunks = [];

  const readable = {
    getReader() {
      return {
        read() {
          return new Promise((resolve) => {
            if (readQueue.length) {
              return resolve({ value: readQueue.shift(), done: false });
            }
            if (readDone) return resolve({ value: undefined, done: true });
            readWaiting = resolve;
          });
        },
      };
    },
  };

  const writable = {
    getWriter() {
      return {
        async write(bytes) {
          writtenChunks.push(Buffer.from(bytes));
        },
        async close() {
          if (echoOnClose) {
            for (const chunk of writtenChunks) pushToReadable(chunk);
          }
          signalReadableDone();
        },
      };
    },
  };

  const clientStream = { readable, writable };
  return {
    clientStream,
    serverWrite: (d) => pushToReadable(Buffer.from(d)),
    serverEnd: () => signalReadableDone(),
  };
}

function makeFakeTransport({
  connectShouldFail = false,
  connectError = new Error("ECONNREFUSED"),
} = {}) {
  const readyPromise = connectShouldFail ? Promise.reject(connectError) : Promise.resolve();
  let closedResolve, closedReject;
  const closedPromise = new Promise((res, rej) => {
    closedResolve = res;
    closedReject = rej;
  });

  const dgChunks = [];
  let dgWaiting = null;
  const dgWritten = [];
  const createdBidi = [];

  const transport = {
    ready: readyPromise,
    closed: closedPromise,
    datagrams: {
      readable: {
        getReader() {
          return {
            read() {
              return new Promise((resolve) => {
                if (dgChunks.length) {
                  return resolve({ value: dgChunks.shift(), done: false });
                }
                dgWaiting = resolve;
              });
            },
          };
        },
      },
      writable: {
        getWriter() {
          return {
            write: async (b) => {
              dgWritten.push(Buffer.from(b));
            },
          };
        },
      },
    },
    incomingBidirectionalStreams: {
      getReader() {
        return { read: () => new Promise(() => {}) };
      },
    },
    incomingUnidirectionalStreams: {
      getReader() {
        return { read: () => new Promise(() => {}) };
      },
    },
    async createBidirectionalStream() {
      const pair = makeFakeStreamPair(true);
      createdBidi.push(pair);
      return pair.clientStream;
    },
    async close({ closeCode = 0, reason = "" } = {}) {
      closedResolve({ closeCode, reason });
    },
    _simulateServerClose(code = 0, reason = "") {
      closedResolve({ closeCode: code, reason });
    },
    _simulateServerError(err) {
      closedReject(err);
    },
    _pushDatagram(bytes) {
      const buf = Buffer.from(bytes);
      if (dgWaiting) {
        const r = dgWaiting;
        dgWaiting = null;
        r({ value: buf, done: false });
      } else dgChunks.push(buf);
    },
    _dgWritten: dgWritten,
    _createdBidi: createdBidi,
  };
  return transport;
}

async function getLib() {
  const lib = await import("@fails-components/webtransport");
  await lib.quicheLoaded;
  return lib;
}

async function liveEcho(message, opts = {}) {
  const { WebTransport } = await getLib();
  const transport = new WebTransport(ECHO_URL, opts);
  await withTimeout(transport.ready, CONNECT_TIMEOUT, "connect");

  const result = await withTimeout(
    bidiRoundTrip(transport, message),
    ROUND_TRIP_TIMEOUT,
    "echo round-trip",
  );
  await closeQuietly(transport, "done");
  return result.toString("utf8");
}

async function liveDatagramEcho(message) {
  const { WebTransport } = await getLib();
  const transport = new WebTransport(ECHO_URL);
  await withTimeout(transport.ready, CONNECT_TIMEOUT, "connect");

  const reader = transport.datagrams.readable.getReader();
  const writer = transport.datagrams.writable.getWriter();
  const readPromise = reader.read();
  await writer.write(Buffer.from(message, "utf8"));
  const { value } = await withTimeout(readPromise, ROUND_TRIP_TIMEOUT, "dgram echo");

  await closeQuietly(transport, "done");
  return Buffer.from(value).toString("utf8");
}

function spawnWtcat(args, inputLines = [], { killAfter = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [WTCAT_BIN, ...args], {
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "",
      stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    let delay = 500;
    for (const line of inputLines) {
      setTimeout(() => {
        if (!proc.killed) proc.stdin.write(line + "\n");
      }, delay);
      delay += 300;
    }
    setTimeout(() => {
      if (!proc.killed) proc.stdin.end();
    }, delay + 500);

    const killer = setTimeout(() => proc.kill("SIGTERM"), killAfter);
    proc.on("close", (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, code });
    });
    proc.on("error", reject);
  });
}

describe("Unit: URL normalisation", () => {
  test("leaves https:// unchanged", () => {
    assert.equal(normaliseUrl("https://example.com/wt"), "https://example.com/wt");
  });
  test("leaves http:// unchanged", () => {
    assert.equal(normaliseUrl("http://example.com/wt"), "http://example.com/wt");
  });
  test("prepends https:// to bare host", () => {
    assert.equal(normaliseUrl("example.com/wt"), "https://example.com/wt");
  });
  test("prepends https:// to host:port", () => {
    assert.equal(normaliseUrl("localhost:4433"), "https://localhost:4433");
  });
  test("handles echo server URL without scheme", () => {
    assert.equal(
      normaliseUrl("wt-ord.akaleapi.net:6161/echo"),
      "https://wt-ord.akaleapi.net:6161/echo",
    );
  });
  test("preserves query string", () => {
    assert.equal(normaliseUrl("example.com/wt?token=abc"), "https://example.com/wt?token=abc");
  });
  test("does not double-prefix", () => {
    assert.equal(normaliseUrl("https://already.com"), "https://already.com");
  });
});

describe("Unit: buildHeaders", () => {
  test("returns {} for no inputs", () => {
    assert.deepEqual(buildHeaders(), {});
  });
  test("parses a single header", () => {
    assert.equal(buildHeaders(["X-Foo:bar"])["X-Foo"], "bar");
  });
  test("trims whitespace", () => {
    assert.equal(buildHeaders(["  X-Foo :  bar  "])["X-Foo"], "bar");
  });
  test("parses multiple headers", () => {
    assert.deepEqual(buildHeaders(["A:1", "B:2", "C:3"]), {
      A: "1",
      B: "2",
      C: "3",
    });
  });
  test("handles colon in value", () => {
    assert.equal(buildHeaders(["Auth:Bearer tok:en"])["Auth"], "Bearer tok:en");
  });
  test("adds Basic auth", () => {
    const h = buildHeaders([], "alice:s3cret");
    assert.equal(h["Authorization"], "Basic " + Buffer.from("alice:s3cret").toString("base64"));
  });
  test("auth coexists with other headers", () => {
    const h = buildHeaders(["X-Custom:yes"], "alice:pass");
    assert.equal(h["X-Custom"], "yes");
    assert.ok(h["Authorization"].startsWith("Basic "));
  });
  test("later duplicate overrides earlier", () => {
    assert.equal(buildHeaders(["X-D:first", "X-D:second"])["X-D"], "second");
  });
  test("empty value preserved", () => {
    assert.equal(buildHeaders(["X-Empty:"])["X-Empty"], "");
  });
});

describe("Unit: readAll", () => {
  test("concatenates chunks", async () => {
    assert.equal(
      (await readAll(makeReader([Buffer.from("hello "), Buffer.from("world")]))).toString(),
      "hello world",
    );
  });
  test("returns empty Buffer for done reader", async () => {
    assert.equal(
      (
        await readAll({
          async read() {
            return { value: undefined, done: true };
          },
        })
      ).length,
      0,
    );
  });
  test("handles single chunk", async () => {
    assert.equal((await readAll(makeReader([Buffer.from("ping")]))).toString(), "ping");
  });
  test("propagates errors", async () => {
    await assert.rejects(
      readAll({
        async read() {
          throw new Error("stream reset");
        },
      }),
      /stream reset/,
    );
  });
  test("assembles 1 MB from 1 KB chunks", async () => {
    const chunk = Buffer.alloc(1024, 0x41);
    let i = 0;
    assert.equal(
      (
        await readAll({
          async read() {
            if (i++ < 1024) return { value: chunk, done: false };
            return { value: undefined, done: true };
          },
        })
      ).length,
      1024 * 1024,
    );
  });
});

describe("Unit: drainReadable", () => {
  test("emits message for each chunk", async () => {
    const em = new EventEmitter();
    const got = [];
    em.on("message", (d) => got.push(d.toString()));
    await drainReadable(makeReadable(["foo", "bar", "baz"]), em);
    assert.deepEqual(got, ["foo", "bar", "baz"]);
  });
  test("emits nothing for empty stream", async () => {
    const em = new EventEmitter();
    let n = 0;
    em.on("message", () => n++);
    await drainReadable(makeReadable([]), em);
    assert.equal(n, 0);
  });
  test("emits stream-error on throw", async () => {
    const bad = {
      getReader() {
        return {
          async read() {
            throw new Error("quic reset");
          },
        };
      },
    };
    const em = new EventEmitter();
    let err = null;
    em.on("stream-error", (e) => {
      err = e;
    });
    await drainReadable(bad, em);
    assert.ok(err instanceof Error);
    assert.match(err.message, /quic reset/);
  });
  test("wraps Uint8Array into Buffer", async () => {
    const raw = new Uint8Array([104, 101, 108, 108, 111]);
    let done = false;
    const readable = {
      getReader() {
        return {
          async read() {
            if (!done) {
              done = true;
              return { value: raw, done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
    const em = new EventEmitter();
    const got = [];
    em.on("message", (d) => got.push(d));
    await drainReadable(readable, em);
    assert.ok(Buffer.isBuffer(got[0]));
    assert.equal(got[0].toString(), "hello");
  });
  test("skips null/undefined values", async () => {
    let i = 0;
    const vals = [null, Buffer.from("ok"), undefined];
    const readable = {
      getReader() {
        return {
          async read() {
            if (i < vals.length) return { value: vals[i++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
    const em = new EventEmitter();
    const got = [];
    em.on("message", (d) => got.push(d.toString()));
    await drainReadable(readable, em);
    assert.deepEqual(got, ["ok"]);
  });
  test("handles 10 000 chunks without stack overflow", async () => {
    let i = 0;
    const readable = {
      getReader() {
        return {
          async read() {
            if (i++ < 10_000) return { value: Buffer.from("x"), done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
    const em = new EventEmitter();
    let n = 0;
    em.on("message", () => n++);
    await drainReadable(readable, em);
    assert.equal(n, 10_000);
  });
});

describe("Unit: bidiRoundTrip (half-close echo pattern)", () => {
  test("write → close → reads echo back from fake transport", async () => {
    const t = makeFakeTransport();
    const result = await bidiRoundTrip(t, "hello");
    assert.equal(result.toString(), "hello");
  });

  test("echoes empty string", async () => {
    const t = makeFakeTransport();
    const result = await bidiRoundTrip(t, "");
    assert.equal(result.toString(), "");
  });

  test("echoes multi-chunk message", async () => {
    const t = makeFakeTransport();
    const msg = "x".repeat(1024);
    const result = await bidiRoundTrip(t, msg);
    assert.equal(result.toString(), msg);
  });

  test("sequential round-trips on same transport each get their own stream", async () => {
    const t = makeFakeTransport();
    const r1 = await bidiRoundTrip(t, "first");
    const r2 = await bidiRoundTrip(t, "second");
    assert.equal(r1.toString(), "first");
    assert.equal(r2.toString(), "second");
    assert.equal(t._createdBidi.length, 2);
  });
  test("makeFakeStreamPair echoOnClose=true echoes written data", async () => {
    const { clientStream } = makeFakeStreamPair(true);
    const writer = clientStream.writable.getWriter();
    const reader = clientStream.readable.getReader();
    await writer.write(Buffer.from("direct"));
    await writer.close();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    assert.equal(Buffer.concat(chunks).toString(), "direct");
  });

  test("makeFakeStreamPair echoOnClose=false does not echo", async () => {
    const { clientStream } = makeFakeStreamPair(false);
    const writer = clientStream.writable.getWriter();
    const reader = clientStream.readable.getReader();
    await writer.write(Buffer.from("silent"));
    await writer.close();
    const { done } = await reader.read();
    assert.ok(done, "readable should be done with no data");
  });

  test("makeFakeStreamPair serverWrite delivers data to reader", async () => {
    const { clientStream, serverWrite, serverEnd } = makeFakeStreamPair(false);
    const reader = clientStream.readable.getReader();
    serverWrite("pushed");
    serverEnd();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    assert.equal(Buffer.concat(chunks).toString(), "pushed");
  });
});

describe("Unit: fake transport", () => {
  test("ready resolves", async () => {
    await assert.doesNotReject(makeFakeTransport().ready);
  });
  test("ready rejects on failure", async () => {
    await assert.rejects(makeFakeTransport({ connectShouldFail: true }).ready, /ECONNREFUSED/);
  });
  test("createBidirectionalStream returns readable+writable", async () => {
    const s = await makeFakeTransport().createBidirectionalStream();
    assert.ok(s.readable && s.writable);
  });
  test("datagram writes recorded", async () => {
    const t = makeFakeTransport();
    await t.datagrams.writable.getWriter().write(Buffer.from("test"));
    assert.equal(t._dgWritten[0].toString(), "test");
  });
  test("close() resolves closed", async () => {
    const t = makeFakeTransport();
    setTimeout(() => t.close({ closeCode: 42, reason: "bye" }), 30);
    assert.equal((await withTimeout(t.closed, 1000, "closed")).closeCode, 42);
  });
  test("_simulateServerClose resolves closed", async () => {
    const t = makeFakeTransport();
    setTimeout(() => t._simulateServerClose(1001, "shutdown"), 30);
    assert.equal((await withTimeout(t.closed, 1000, "closed")).closeCode, 1001);
  });
  test("_simulateServerError rejects closed", async () => {
    const t = makeFakeTransport();
    setTimeout(() => t._simulateServerError(new Error("network loss")), 30);
    await assert.rejects(withTimeout(t.closed, 1000, "closed"), /network loss/);
  });
  test("_pushDatagram is readable", async () => {
    const t = makeFakeTransport();
    const reader = t.datagrams.readable.getReader();
    setTimeout(() => t._pushDatagram("hello"), 30);
    const { value } = await withTimeout(reader.read(), 1000, "dgram");
    assert.equal(Buffer.from(value).toString(), "hello");
  });
});

describe("Unit: performance", () => {
  test("buildHeaders handles 1 000 entries", () => {
    const list = Array.from({ length: 1000 }, (_, i) => `X-H-${i}:v${i}`);
    const h = buildHeaders(list);
    assert.equal(Object.keys(h).length, 1000);
    assert.equal(h["X-H-500"], "v500");
  });
  test("bidiRoundTrip handles 64 KB payload via fake transport", async () => {
    const t = makeFakeTransport();
    const msg = "y".repeat(64 * 1024);
    const result = await bidiRoundTrip(t, msg);
    assert.equal(result.toString(), msg);
  });
});

describe("Integration: bidi stream", () => {
  test("connects to echo endpoint", async () => {
    const { WebTransport } = await getLib();
    const t = new WebTransport(ECHO_URL);
    await withTimeout(t.ready, CONNECT_TIMEOUT, "connect");
    await closeQuietly(t, "ok");
  });

  test("echoes ASCII string", async () => {
    assert.equal(await liveEcho("hello world"), "hello world");
  });

  test("echoes Unicode / emoji", async () => {
    const msg = "こんにちは 🌏 WebTransport!";
    assert.equal(await liveEcho(msg), msg);
  });

  test("echoes 1 KB payload", async () => {
    const msg = "x".repeat(1024);
    assert.equal(await liveEcho(msg), msg);
  });

  test("echoes 64 KB payload", async () => {
    const msg = "y".repeat(64 * 1024);
    assert.equal(await liveEcho(msg), msg);
  });

  test("multiple sequential round-trips on same connection", async () => {
    const { WebTransport } = await getLib();
    const t = new WebTransport(ECHO_URL);
    await withTimeout(t.ready, CONNECT_TIMEOUT, "connect");

    for (const msg of ["first", "second", "third"]) {
      const result = await withTimeout(bidiRoundTrip(t, msg), ROUND_TRIP_TIMEOUT, `echo:${msg}`);
      assert.equal(result.toString(), msg);
    }
    await closeQuietly(t, "done");
  });

  test("round-trip latency under 5 s", async () => {
    const start = Date.now();
    await liveEcho("latency check");
    assert.ok(Date.now() - start < 5000, `latency ${Date.now() - start}ms`);
  });
});

describe("Integration: datagrams", () => {
  test("echoes a datagram", async () => {
    assert.equal(await liveDatagramEcho("dgram hello"), "dgram hello");
  });

  test("echoes multiple datagrams in sequence", async () => {
    const { WebTransport } = await getLib();
    const t = new WebTransport(ECHO_URL);
    await withTimeout(t.ready, CONNECT_TIMEOUT, "connect");

    const reader = t.datagrams.readable.getReader();
    const writer = t.datagrams.writable.getWriter();

    for (const m of ["alpha", "beta", "gamma"]) {
      const readPromise = reader.read();
      await writer.write(Buffer.from(m, "utf8"));
      const { value } = await withTimeout(readPromise, ROUND_TRIP_TIMEOUT, `dg:${m}`);
      assert.equal(Buffer.from(value).toString(), m);
    }
    await closeQuietly(t, "done");
  });

  test("near-MTU datagram (~1100 bytes)", async () => {
    const msg = "D".repeat(1100);
    assert.equal(await liveDatagramEcho(msg), msg);
  });
});

describe("Integration: connection errors", () => {
  test("rejects on unreachable host", async () => {
    const { WebTransport } = await getLib();
    const t = new WebTransport("https://localhost:19999/no-server");
    t.closed.catch(() => {});
    await assert.rejects(withTimeout(t.ready, 5000, "connect"), (e) => e instanceof Error);
  });
});

describe("CLI: --help / --version", () => {
  test("--help exits 0 and mentions positional <url>", async () => {
    const { stdout, stderr, code } = await spawnWtcat(["--help"], [], {
      killAfter: 5000,
    });
    assert.ok((stdout + stderr).includes("<url>"));
    assert.equal(code, 0);
  });
  test("--version prints semver", async () => {
    const { stdout, stderr, code } = await spawnWtcat(["--version"], [], {
      killAfter: 5000,
    });
    assert.match((stdout + stderr).trim(), /\d+\.\d+\.\d+/);
    assert.equal(code, 0);
  });
});

describe("CLI: argument validation", () => {
  test("requires url argument", async () => {
    const { code, stderr } = await spawnWtcat([], [], { killAfter: 5000 });
    assert.notEqual(code, 0);
    assert.match(stderr, /url|Usage:/i);
  });

  test("rejects invalid --stream-type", async () => {
    const { code, stderr } = await spawnWtcat(["example.com", "--stream-type", "invalid"], [], {
      killAfter: 5000,
    });
    assert.equal(code, 2);
    assert.match(stderr, /stream-type/i);
  });

  test("rejects malformed --header", async () => {
    const { code, stderr } = await spawnWtcat(["example.com", "-H", "BadHeader"], [], {
      killAfter: 5000,
    });
    assert.equal(code, 2);
    assert.match(stderr, /header/i);
  });

  test("rejects malformed --auth", async () => {
    const { code, stderr } = await spawnWtcat(["example.com", "--auth", "missing-colon"], [], {
      killAfter: 5000,
    });
    assert.equal(code, 2);
    assert.match(stderr, /auth/i);
  });

  test("rejects conflicting --ca and --insecure", async () => {
    const { code, stderr } = await spawnWtcat(
      ["example.com", "--ca", "does-not-exist.pem", "--insecure"],
      [],
      { killAfter: 5000 },
    );
    assert.equal(code, 2);
    assert.match(stderr, /mutually exclusive/i);
  });

  test("rejects invalid --connect-timeout", async () => {
    const { code, stderr } = await spawnWtcat(["example.com", "--connect-timeout", "0"], [], {
      killAfter: 5000,
    });
    assert.equal(code, 2);
    assert.match(stderr, /connect-timeout/i);
  });
});

describe("CLI: --execute against live echo", () => {
  test("single -x message echoed on stdout", async () => {
    const msg = "cli-execute-test";
    const { stdout } = await spawnWtcat([ECHO_URL, "-x", msg, "--wait", "3"], [], {
      killAfter: 20_000,
    });
    assert.ok(stdout.includes(msg), `expected "${msg}" in stdout:\n${stdout}`);
  });

  test("multiple -x messages appear in order", async () => {
    const { stdout } = await spawnWtcat(
      [ECHO_URL, "-x", "first", "-x", "second", "-x", "third", "--wait", "3"],
      [],
      { killAfter: 25_000 },
    );
    const fi = stdout.indexOf("first"),
      si = stdout.indexOf("second"),
      ti = stdout.indexOf("third");
    assert.ok(fi !== -1 && si !== -1 && ti !== -1, `all three present:\n${stdout}`);
    assert.ok(fi < si && si < ti, "in order");
  });
  test("-w -1 keeps process alive until killed", async () => {
    const proc = spawn(process.execPath, [WTCAT_BIN, ECHO_URL, "-x", "hold", "-w", "-1"], {
      env: { ...process.env, NO_COLOR: "1" },
    });
    await new Promise((resolve, reject) => {
      let output = "";
      const watchdog = setTimeout(() => reject(new Error("timed out waiting for echo")), 15_000);
      proc.stdout.on("data", (d) => {
        output += d.toString();
        if (output.includes("hold")) {
          clearTimeout(watchdog);
          resolve();
        }
      });
      proc.stderr.on("data", (d) => {
        output += d.toString();
        if (output.includes("hold")) {
          clearTimeout(watchdog);
          resolve();
        }
      });
    });

    assert.equal(proc.exitCode, null, "process should still be running after echo");
    proc.kill("SIGTERM");
    await new Promise((r) => proc.once("close", r));
  });
});

describe("CLI: --datagram against live echo", () => {
  test("datagram echoed on stdout", async () => {
    const msg = "cli-dgram-test";
    const { stdout } = await spawnWtcat([ECHO_URL, "--datagram", "-x", msg, "--wait", "3"], [], {
      killAfter: 20_000,
    });
    assert.ok(stdout.includes(msg), `expected "${msg}" in stdout:\n${stdout}`);
  });
});
describe("CLI: --stream-type send", () => {
  test("exits cleanly without crashing", async () => {
    const { code, stderr } = await spawnWtcat(
      [ECHO_URL, "--stream-type", "send", "-x", "send-only-test", "--wait", "2"],
      [],
      { killAfter: 15_000 },
    );
    assert.ok(
      code === 0,
      `expected exit code 0 (not timeout/signal), got ${code}\nstderr: ${stderr}`,
    );
  });
});

describe("CLI: error conditions", () => {
  test("exits non-zero for unreachable server", async () => {
    const { code } = await spawnWtcat(["https://localhost:19999/no-server"], [], {
      killAfter: 12_000,
    });
    assert.notEqual(code, 0);
  });
  test("prints error to stderr for bad connection", async () => {
    const { stderr } = await spawnWtcat(["https://localhost:19999/no-server"], [], {
      killAfter: 12_000,
    });
    assert.ok(
      stderr.toLowerCase().includes("error") || stderr.includes("Failed"),
      `expected error in stderr:\n${stderr}`,
    );
  });
});

describe("CLI: header passthrough", () => {
  test("custom header does not break connection", async () => {
    const msg = "header-smoke";
    const { stdout } = await spawnWtcat(
      [ECHO_URL, "-H", "X-Wtcat-Test:1", "-x", msg, "--wait", "3"],
      [],
      { killAfter: 20_000 },
    );
    assert.ok(stdout.includes(msg), `expected echo in stdout:\n${stdout}`);
  });
});
