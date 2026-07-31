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
  'marker-colors',
  'marker-types',
  'media-ready',
  'media-col-ready',
  // `media-col-ready` lists only what is *loaded*. Enumerating the slots a
  // device actually has is what lets an empty roll show as an empty roll
  // instead of vanishing from the dashboard.
  'media-source-supported',
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

export function getJobsQuery(whichJobs: 'not-completed' | 'completed' = 'not-completed'): string {
  return `{
  OPERATION Get-Jobs
  GROUP operation-attributes-tag
  ATTR charset attributes-charset utf-8
  ATTR language attributes-natural-language en
  ATTR uri printer-uri $uri
  ATTR keyword which-jobs ${whichJobs}
  ATTR keyword requested-attributes ${JOB_ATTRIBUTES.join(',')}
}
`;
}
