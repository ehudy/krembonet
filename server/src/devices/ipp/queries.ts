/**
 * Builders for ipptool `.test` request files.
 *
 * `$uri` is substituted by ipptool with the URI given on the command line, so
 * these templates stay device-agnostic and match the checked-in fixtures under
 * `test/fixtures/` exactly.
 */

/** Attributes we need for supplies, media, and device state. */
export const PRINTER_ATTRIBUTES = [
  'printer-make-and-model',
  'printer-state',
  'printer-state-reasons',
  'marker-names',
  'marker-levels',
  // `marker-levels` is only a percentage when the matching high level is 100.
  // RFC 8011 permits any scale, so reading levels without this is guesswork.
  'marker-high-levels',
  // The "warn me at this level" boundary. For a waste receptacle it is the one
  // signal that says which way the number runs — see `readReceptacleFullness`.
  'marker-low-levels',
  'marker-colors',
  'marker-types',
  'media-ready',
  'media-col-ready',
  // `media-col-ready` lists only what is *loaded*. Enumerating the slots a
  // device actually has is what lets an empty roll show as an empty roll
  // instead of vanishing from the dashboard.
  'media-source-supported',
] as const;

/**
 * The engine-state attributes on their own.
 *
 * A queue refresh needs to know whether the print engine is still running, but
 * not what the ink levels are. Asking for the full printer attribute set every
 * minute to learn one enum is a lot of response for a plotter to marshal, and
 * `printer-state` cannot ride along in a Get-Jobs response.
 */
export const PRINTER_STATE_ATTRIBUTES = [
  'printer-state',
  'printer-state-reasons',
] as const;

export const JOB_ATTRIBUTES = [
  'job-id',
  'job-name',
  'job-originating-user-name',
  'job-state',
  'job-state-reasons',
  'job-impressions',
  'time-at-creation',
] as const;

export function getPrinterAttributesQuery(): string {
  return `{
  OPERATION Get-Printer-Attributes
  GROUP operation-attributes-tag
  ATTR charset attributes-charset utf-8
  ATTR language attributes-natural-language en
  ATTR uri printer-uri $uri
  ATTR keyword requested-attributes ${PRINTER_ATTRIBUTES.join(',')}
}
`;
}

export function getPrinterStateQuery(): string {
  return `{
  OPERATION Get-Printer-Attributes
  GROUP operation-attributes-tag
  ATTR charset attributes-charset utf-8
  ATTR language attributes-natural-language en
  ATTR uri printer-uri $uri
  ATTR keyword requested-attributes ${PRINTER_STATE_ATTRIBUTES.join(',')}
}
`;
}

/**
 * `limit` is RFC 8011's cap on how many jobs come back. It matters only for
 * `which-jobs completed`, where a busy device would otherwise return its entire
 * history. Omitted by default so the active-queue request stays byte-identical
 * to `test/fixtures/get-jobs.test`, which is replayed by hand to recapture the
 * fixtures.
 */
export function getJobsQuery(
  whichJobs: 'not-completed' | 'completed' = 'not-completed',
  limit?: number,
): string {
  return `{
  OPERATION Get-Jobs
  GROUP operation-attributes-tag
  ATTR charset attributes-charset utf-8
  ATTR language attributes-natural-language en
  ATTR uri printer-uri $uri
  ATTR keyword which-jobs ${whichJobs}
${limit === undefined ? '' : `  ATTR integer limit ${limit}\n`}  ATTR keyword requested-attributes ${JOB_ATTRIBUTES.join(',')}
}
`;
}
