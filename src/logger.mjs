const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = "info", format = "json", service = "solo-to-china", sink } = {}) {
  const threshold = LEVELS[level] || LEVELS.info;
  const output = sink || ((line, severity) => {
    const method = severity === "error" ? "error" : severity === "warn" ? "warn" : "log";
    console[method](line);
  });

  function write(severity, event, fields = {}) {
    if ((LEVELS[severity] || LEVELS.info) < threshold) return;
    const entry = normalize({ timestamp: new Date().toISOString(), level: severity, service, event, ...fields });
    const line = format === "pretty" ? pretty(entry) : JSON.stringify(entry);
    output(line, severity);
  }

  const logger = {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child(baseFields = {}) {
      return {
        debug: (event, fields = {}) => write("debug", event, { ...baseFields, ...fields }),
        info: (event, fields = {}) => write("info", event, { ...baseFields, ...fields }),
        warn: (event, fields = {}) => write("warn", event, { ...baseFields, ...fields }),
        error: (event, fields = {}) => write("error", event, { ...baseFields, ...fields }),
      };
    },
  };
  return logger;
}

function normalize(value) {
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function pretty(entry) {
  const { timestamp, level, service, event, ...fields } = entry;
  const detail = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  return `${timestamp} ${level.toUpperCase().padEnd(5)} ${service} ${event}${detail}`;
}
