const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.ANTHROPIC_API_KEY",
      "req.body.TAVILY_API_KEY"
    ],
    remove: true
  }
});

module.exports = { logger };

