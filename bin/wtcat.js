#!/usr/bin/env node

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import EventEmitter from "node:events";
import fs from "node:fs";
import readline from "node:readline";
import tty from "node:tty";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

import { quicheLoaded, WebTransport } from "@fails-components/webtransport";
import { program } from "commander";
import {
  bidiRoundTrip,
  buildHeaders,
  drainReadable,
  normaliseUrl,
  sendOnlyTrip,
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

class Console extends EventEmitter {
  constructor() {
    super();
    this.stdin = process.stdin;
    this.stdout = process.stdout;
    this.stderr = process.stderr;
    this.readlineInterface = readline.createInterface(this.stdin, this.stdout);
    this.readlineInterface
      .on("line", (data) => this.emit("line", data))
      .on("close", () => this.emit("close"));
    this._resetInput = () => this.clear();
  }

  static get Colors() {
    return {
      Red: "\u001b[31m",
      Green: "\u001b[32m",
      Yellow: "\u001b[33m",
      Blue: "\u001b[34m",
      Magenta: "\u001b[35m",
      Cyan: "\u001b[36m",
      Default: "\u001b[39m",
    };
  }

  static get Types() {
    return { Incoming: "< ", Control: "", Error: "error: " };
  }

  prompt() {
    this.readlineInterface.prompt(true);
  }

  print(type, msg, color) {
    if (tty.isatty(1)) {
      this.clear();
      let prefix = type;
      let colorCode = color;
      let reset = Console.Colors.Default;

      if (programOptions.execute.length) {
        colorCode = "";
        prefix = "";
        reset = "";
      } else if (!programOptions.color) {
        colorCode = "";
        reset = "";
      }

      this.stdout.write(colorCode + prefix + msg + reset + "\n");
      this.prompt();
    } else if (type === Console.Types.Incoming) {
      this.stdout.write(msg + "\n");
    } else if (type === Console.Types.Error) {
      this.stderr.write(type + msg + "\n");
    }
  }

  clear() {
    if (tty.isatty(1)) this.stdout.write("\r\u001b[2K\u001b[3D");
  }

  pause() {
    this.stdin.on("keypress", this._resetInput);
  }
  resume() {
    this.stdin.removeListener("keypress", this._resetInput);
  }
}

function collect(val, memo) {
  memo.push(val);
  return memo;
}

const EXIT_OK = 0;
const EXIT_CONNECT_ERROR = 1;
const EXIT_USAGE_ERROR = 2;

const EXPECTED_CLOSE_CODES = new Set([
  "ERR_QUIC_SESSION_CLOSED",
  "ERR_QUIC_STREAM_RESET",
  "ERR_QUIC_CONNECTION_CLOSED",
]);

async function closeQuietly(transport, reason) {
  try {
    await Promise.resolve(transport.close({ closeCode: 0, reason }));
  } catch (err) {
    if (process.env.WTCAT_DEBUG) {
      process.stderr.write(`close failed: ${err}\n`);
    }
  }
}

function failUsage(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(EXIT_USAGE_ERROR);
}

function parsePositiveSeconds(value, optionName) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    failUsage(
      `${optionName} must be a positive integer (seconds), got "${value}"`,
    );
  }
  return n;
}

function parseWaitSeconds(value) {
  if (value == null) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || (n < 0 && n !== -1)) {
    failUsage(
      `--wait must be -1 or a non-negative integer (seconds), got "${value}"`,
    );
  }
  return n;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}
function validateOptions(options) {
  if (!["bidi", "send"].includes(options.streamType)) {
    failUsage(
      `--stream-type must be "bidi" or "send", got "${options.streamType}"`,
    );
  }

  for (const header of options.header) {
    const i = header.indexOf(":");
    if (i <= 0) {
      failUsage(`invalid --header value "${header}": expected "name:value"`);
    }
  }

  if (options.auth) {
    const i = options.auth.indexOf(":");
    if (i <= 0) {
      failUsage(
        '--auth must be in format "username:password" with a non-empty username',
      );
    }
  }

  if (options.ca && options.insecure) {
    failUsage("--ca and --insecure are mutually exclusive");
  }
}

function createTransportOptions(options, wtConsole) {
  const transportOpts = {};

  if (options.ca) {
    if (!fs.existsSync(options.ca)) {
      failUsage(`CA file not found: ${options.ca}`);
    }
    const pem = fs.readFileSync(options.ca);
    const b64 = pem
      .toString()
      .replaceAll(/-----[A-Z ]+-----/g, "")
      .replaceAll(/\s+/g, "");
    const der = Buffer.from(b64, "base64");
    const hash = createHash("sha256").update(der).digest();
    transportOpts.serverCertificateHashes = [{
      algorithm: "sha-256",
      value: hash,
    }];
  }

  if (options.insecure) {
    wtConsole.print(
      Console.Types.Control,
      "WARNING: Certificate verification disabled.",
      Console.Colors.Yellow,
    );
    transportOpts.rejectUnauthorized = false;
  } else if (options.strictTls && !options.ca) {
    failUsage("--strict-tls requires --ca (or use --insecure explicitly)");
  } else if (!options.ca) {
    wtConsole.print(
      Console.Types.Control,
      "TLS note: no --ca pin configured; using platform trust store.",
      Console.Colors.Yellow,
    );
  }

  const headers = buildHeaders(options.header, options.auth);
  if (Object.keys(headers).length) transportOpts.headers = headers;
  return transportOpts;
}


function startIncomingStreamDrainer(getReader, label, msgEmitter, wtConsole) {
  (async () => {
    try {
      const reader = getReader();
      while (true) {
        const { value: stream, done } = await reader.read();
        if (done) break;
        if (stream) drainReadable(stream.readable ?? stream, msgEmitter);
      }
    } catch (err) {
      if (EXPECTED_CLOSE_CODES.has(err?.code)) return;
      wtConsole.print(
        Console.Types.Error,
        `Incoming ${label} stream error: ${err.message}`,
        Console.Colors.Yellow,
      );
    }
  })();
}

function buildSendFunction(transport, options, msgEmitter, wtConsole) {
  if (options.datagram) {
    const dgReader = transport.datagrams.readable.getReader();
    (async () => {
      try {
        while (true) {
          const { value, done } = await dgReader.read();
          if (done) break;
          if (value) {
            if (options.showDatagrams) {
              wtConsole.print(
                Console.Types.Control,
                `Received datagram (${value.byteLength} bytes)`,
                Console.Colors.Magenta,
              );
            }
            msgEmitter.emit("message", Buffer.from(value));
          }
        }
      } catch (err) {
        if (EXPECTED_CLOSE_CODES.has(err?.code)) return;
        wtConsole.print(
          Console.Types.Error,
          err.message,
          Console.Colors.Yellow,
        );
      }
    })();

    const dgWriter = transport.datagrams.writable.getWriter();
    return async (msg) => dgWriter.write(Buffer.from(msg, "utf8"));
  }

  if (options.streamType === "send") {
    return (msg) => sendOnlyTrip(transport, msg);
  }

  return async (msg) => {
    const response = await bidiRoundTrip(transport, msg);
    if (response.length > 0) {
      msgEmitter.emit("message", response);
    }
  };
}


program
  .version(version)
  .usage("[options] <url>")
  .description("WebTransport Cat — like wscat but for WebTransport.")
  .argument("<url>", "WebTransport server URL")
  .option("--no-color", "run without color")
  .option(
    "--stream-type <type>",
    'stream type: "bidi" (default) or "send"',
    "bidi",
  )
  .option(
    "--datagram",
    "use datagrams instead of streams (unreliable, unordered)",
  )
  .option("--ca <ca>", "path to CA certificate file (PEM)")
  .option("--connect-timeout <seconds>", "connection timeout in seconds", "15")
  .option(
    "--strict-tls",
    "require pinned certificate hash via --ca unless --insecure is set",
  )
  .option("--insecure", "do not verify the server TLS certificate (insecure)")
  .option("--auth <username:password>", "add HTTP Basic Authorization header")
  .option(
    "-H, --header <header:value>",
    "set an HTTP header (repeatable)",
    collect,
    [],
  )
  .option(
    "-x, --execute <command>",
    "send message after connecting, then exit (repeatable)",
    collect,
    [],
  )
  .option(
    "-w, --wait <seconds>",
    "seconds to wait after --execute before closing (-1 to hold open)",
  )
  .option(
    "-P, --show-datagrams",
    "print notice for each incoming datagram (with --datagram)",
  )
  .parse(process.argv);

const programOptions = program.opts();
const [targetUrl] = program.args;

if (!targetUrl) program.help();

validateOptions(programOptions);

const connectTimeoutMs =
  parsePositiveSeconds(programOptions.connectTimeout, "--connect-timeout") *
  1000;


const executeWaitSeconds = parseWaitSeconds(programOptions.wait ?? null);

let connectUrl;


let shuttingDown = false;

async function shutdown(transport, wtConsole, signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = EXIT_OK;
  wtConsole.print(
    Console.Types.Control,
    `Shutting down on ${signal}...`,
    Console.Colors.Yellow,
  );
  await closeQuietly(transport, `signal:${signal}`);
  process.exit(EXIT_OK);
}

function registerSignalHandlers(transport, wtConsole) {
  const handler = (signal) => {
    shutdown(transport, wtConsole, signal).catch((err) => {
      if (process.env.WTCAT_DEBUG) {
        process.stderr.write(`shutdown error: ${err}\n`);
      }
      process.exit(EXIT_CONNECT_ERROR);
    });
  };
  process.once("SIGINT", () => handler("SIGINT"));
  process.once("SIGTERM", () => handler("SIGTERM"));
}


async function run() {
  try {
    connectUrl = normaliseUrl(targetUrl);
  } catch (err) {
    failUsage(`Invalid URL "${targetUrl}": ${err.message}`);
  }

  await quicheLoaded;

  const wtConsole = new Console();
  const transportOpts = createTransportOptions(programOptions, wtConsole);

  wtConsole.print(
    Console.Types.Control,
    `Connecting to ${connectUrl} …`,
    Console.Colors.Cyan,
  );

  let transport;
  try {
    transport = new WebTransport(connectUrl, transportOpts);
    await withTimeout(transport.ready, connectTimeoutMs, "connect");
  } catch (err) {
    wtConsole.print(
      Console.Types.Error,
      `Failed to connect: ${err.message}`,
      Console.Colors.Red,
    );
    process.exit(EXIT_CONNECT_ERROR);
  }

  wtConsole.print(
    Console.Types.Control,
    "Connected (press CTRL+C to quit)",
    Console.Colors.Green,
  );


  registerSignalHandlers(transport, wtConsole);

  const msgEmitter = new EventEmitter();
  msgEmitter.on("message", (data) => {
    wtConsole.print(
      Console.Types.Incoming,
      data.toString("utf8"),
      Console.Colors.Blue,
    );
  });
  msgEmitter.on("stream-error", (err) => {
    wtConsole.print(
      Console.Types.Error,
      `Stream error: ${err.message}`,
      Console.Colors.Yellow,
    );
  });

  startIncomingStreamDrainer(
    () => transport.incomingBidirectionalStreams.getReader(),
    "bidi",
    msgEmitter,
    wtConsole,
  );
  startIncomingStreamDrainer(
    () => transport.incomingUnidirectionalStreams.getReader(),
    "uni",
    msgEmitter,
    wtConsole,
  );

  const sendFn = buildSendFunction(
    transport,
    programOptions,
    msgEmitter,
    wtConsole,
  );

  // FIX #6: report per-command errors in --execute mode and continue.
  if (programOptions.execute.length) {
    for (const cmd of programOptions.execute) {
      try {
        await sendFn(cmd);
      } catch (err) {
        wtConsole.print(
          Console.Types.Error,
          `Send failed for command "${cmd}": ${err.message}`,
          Console.Colors.Yellow,
        );
      }
    }

    if (executeWaitSeconds === -1) return;

    const delay = executeWaitSeconds === null
      ? 2000
      : executeWaitSeconds * 1000;
    setTimeout(async () => {
      await closeQuietly(transport, "done");
      process.exit(EXIT_OK);
    }, delay);
    return;
  }

  wtConsole.resume();
  wtConsole.prompt();

  wtConsole.on("line", async (data) => {
    try {
      await sendFn(data);
    } catch (err) {
      wtConsole.print(
        Console.Types.Error,
        `Send failed: ${err.message}`,
        Console.Colors.Yellow,
      );
    }
    wtConsole.prompt();
  });

  wtConsole.on("close", async () => {
    await closeQuietly(transport, "user closed");
    process.exit(EXIT_OK);
  });

  transport.closed
    .then(({ closeCode, reason } = {}) => {
      wtConsole.print(
        Console.Types.Control,
        `Disconnected (code: ${closeCode ?? 0}, reason: "${reason ?? ""}")`,
        Console.Colors.Green,
      );
      wtConsole.clear();
      process.exit(EXIT_OK);
    })
    .catch((err) => {
      if (EXPECTED_CLOSE_CODES.has(err?.code)) {
        process.exit(EXIT_OK);
        return;
      }
      wtConsole.print(
        Console.Types.Error,
        err.message,
        Console.Colors.Yellow,
      );
      process.exit(EXIT_CONNECT_ERROR);
    });
}

try {
  await run();
} catch (err) {
  process.stderr.write(`Fatal: ${err}\n`);
  if (process.env.WTCAT_DEBUG && err?.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(EXIT_CONNECT_ERROR);
}
