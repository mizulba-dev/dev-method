import { redact, redactDeep } from './secrets.mjs';

export function createLogger({ write } = {}) {
  const sink = write ?? ((text) => process.stdout.write(`${text}\n`));
  return {
    line(text) {
      sink(redact(String(text)));
    },
    record(value) {
      sink(redact(JSON.stringify(redactDeep(value))));
    },
  };
}

export function createMemoryLogger() {
  const lines = [];
  const logger = createLogger({ write: (text) => lines.push(text) });
  logger.lines = lines;
  logger.text = () => lines.join('\n');
  return logger;
}
