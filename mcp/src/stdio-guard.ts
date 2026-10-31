/**
 * In a stdio MCP server, stdout carries JSON-RPC only. Some dependencies
 * (transformers.js, onnxruntime) may log with console.log/info/debug; send
 * all of that to stderr so it can never corrupt the protocol stream.
 * Imported first by index.ts.
 */
const toStderr = (...args: unknown[]): void => {
  console.error(...args);
};
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

export {};
