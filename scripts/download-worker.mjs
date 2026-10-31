import { parentPort } from 'node:worker_threads';
import { getBars } from './provider.mjs';

parentPort.on('message', async ({ id, task }) => {
  try {
    const bars = await getBars(task);
    parentPort.postMessage({ id, bars });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code, availability: error.availability } });
  }
});
