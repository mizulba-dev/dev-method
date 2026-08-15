import { redact, redactDeep } from './secrets.mjs';

export function createLogger({ write, json = false } = {}) {
  const sink = write ?? ((text) => process.stdout.write(`${text}\n`));
  return {
    json,
    line(text) {
      sink(redact(String(text)));
    },
    record(value) {
      sink(redact(JSON.stringify(redactDeep(value))));
    },
  };
}

export function createMemoryLogger({ json = false } = {}) {
  const lines = [];
  const logger = createLogger({ write: (text) => lines.push(text), json });
  logger.lines = lines;
  logger.text = () => lines.join('\n');
  return logger;
}
