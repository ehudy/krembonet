import { useTranslation, type Translate } from '../i18n/i18n.js';
import type { DeviceState, Job, JobState } from '../types.js';

/**
 * Colour per job state. The label lives in the dictionary under the same key,
 * so a new state needs one entry here and one per locale rather than a label
 * that silently stays English.
 */
const STATE_COLORS: Record<JobState, string> = {
  pending: '#f39c12',
  'pending-held': '#e67e22',
  processing: '#27ae60',
  'processing-stopped': '#c0392b',
  canceled: '#7f8c8d',
  aborted: '#e74c3c',
  completed: '#2980b9',
  unknown: '#94a3b8',
};

/**
 * An empty queue means different things depending on printer state — claiming
 * "the device is idle" while the badge reads "Printing" is a contradiction the
 * viewer has to resolve themselves.
 */
function emptyMessage(deviceState: DeviceState, t: Translate): string {
  switch (deviceState) {
    case 'processing':
      return t('queue.emptyProcessing');
    case 'stopped':
      return t('queue.emptyStopped');
    case 'idle':
      return t('queue.emptyIdle');
    default:
      return t('queue.empty');
  }
}

export function JobTable({
  jobs,
  deviceState,
}: {
  jobs: Job[];
  deviceState: DeviceState;
}) {
  const { t } = useTranslation();

  if (jobs.length === 0) {
    return <div className="empty-queue">{emptyMessage(deviceState, t)}</div>;
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">{t('queue.job')}</th>
            <th scope="col">{t('queue.document')}</th>
            <th scope="col">{t('queue.submittedBy')}</th>
            <th scope="col">{t('queue.status')}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            return (
              <tr key={job.jobId}>
                <td className="job-id">#{job.jobId}</td>
                <td className="job-name">{job.name}</td>
                <td>{job.user}</td>
                <td>
                  <span
                    className="status-pill"
                    style={{ backgroundColor: STATE_COLORS[job.state] }}
                  >
                    {t(`queue.states.${job.state}`)}
                  </span>
                  {job.stateReasons !== null && (
                    <span className="state-reason">{job.stateReasons}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
