/**
 * Queries a live printer through the real IPP stack and prints the normalized
 * result. Use this when the dashboard and the device disagree — it exercises
 * exactly the code path the poller uses, unlike a raw `ipptool` run.
 *
 *   npm run probe --workspace=@krembonet/server
 *   npm run probe --workspace=@krembonet/server -- ipp://printer.example:631/ipp/print
 */
import { config } from '../src/config.js';
import { ipptool, IppError } from '../src/devices/ipp/ipptool.js';
import { normalizeJobs, normalizePrinterAttributes } from '../src/devices/ipp/normalize.js';
import { getJobsQuery, getPrinterAttributesQuery } from '../src/devices/ipp/queries.js';

const uri = process.argv[2] ?? config.plotter?.ippUri;

if (uri === undefined) {
  console.error(
    'No device configured. Pass a URI explicitly:\n' +
      '  npm run probe --workspace=@krembonet/server -- ipp://printer.example:631/ipp/print',
  );
  process.exit(1);
}

try {
  const started = Date.now();

  const [printerResponse, jobsResponse] = await Promise.all([
    ipptool({ uri, query: getPrinterAttributesQuery(), timeoutMs: config.ipptoolTimeoutMs }),
    ipptool({ uri, query: getJobsQuery('not-completed'), timeoutMs: config.ipptoolTimeoutMs }),
  ]);

  const snapshot = {
    ...normalizePrinterAttributes(printerResponse.attributes),
    jobs: normalizeJobs(jobsResponse.attributes),
  };

  console.log(`${uri} — ${Date.now() - started}ms\n`);
  console.log(JSON.stringify(snapshot, null, 2));
} catch (error) {
  if (error instanceof IppError) {
    console.error(`[${error.code}] ${error.message}`);
    process.exit(1);
  }
  throw error;
}
