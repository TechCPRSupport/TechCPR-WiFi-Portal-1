const fs = require("fs");
const path = require("path");

const logDirectory =
  process.env.LOG_DIRECTORY ||
  path.join(__dirname, "logs");

function ensureDirectory() {
  fs.mkdirSync(logDirectory, { recursive: true });
}

function filePathFor(date = new Date()) {
  return path.join(
    logDirectory,
    `techcpr-${date.toISOString().slice(0, 10)}.log`
  );
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== "object") return {};

  const clean = { ...meta };

  for (const key of Object.keys(clean)) {
    if (/password|secret|token|authorization/i.test(key)) {
      clean[key] = "[REDACTED]";
    }

    if (clean[key] instanceof Error) {
      clean[key] = {
        name: clean[key].name,
        message: clean[key].message,
        stack: clean[key].stack
      };
    }
  }

  return clean;
}

function write(level, message, meta = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message: String(message),
    ...normalizeMeta(meta)
  };

  const line = JSON.stringify(record);

  try {
    ensureDirectory();
    fs.appendFileSync(filePathFor(), `${line}\n`, "utf8");
  } catch (error) {
    console.error("Unable to write TechCPR log file:", error.message);
  }

  const consoleMethod =
    level === "error" ? console.error :
    level === "warn" ? console.warn :
    console.log;

  consoleMethod(
    `[${record.timestamp}] [${level.toUpperCase()}] ${record.message}`,
    Object.keys(meta || {}).length ? normalizeMeta(meta) : ""
  );
}

function requestMiddleware(req, res, next) {
  const started = process.hrtime.bigint();

  res.on("finish", () => {
    const elapsedMs =
      Number(process.hrtime.bigint() - started) / 1_000_000;

    write("info", "HTTP request", {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Number(elapsedMs.toFixed(1)),
      ip: req.ip
    });
  });

  next();
}

module.exports = {
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta),
  requestMiddleware,
  logDirectory
};
