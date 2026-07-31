import type { DeviceState, Job, JobState } from '../types.js';

/** Colours follow the prototype's palette so the page stays familiar. */
const STATE_STYLES: Record<JobState, { label: string; color: string }> = {
  pending: { label: 'Pending', color: '#f39c12' },
  'pending-held': { label: 'Held', color: '#e67e22' },
  processing: { label: 'Printing', color: '#27ae60' },
  'processing-stopped': { label: 'Stopped', color: '#c0392b' },
  canceled: { label: 'Canceled', color: '#7f8c8d' },
  aborted: { label: 'Aborted', color: '#e74c3c' },
  completed: { label: 'Completed', color: '#2980b9' },
  unknown: { label: 'Unknown', color: '#94a3b8' },
};

/**
 * An empty queue means different things depending on printer state — claiming
 * "the device is idle" while the badge reads "Printing" is a contradiction the
 * viewer has to resolve themselves.
 */
function emptyMessage(deviceState: DeviceState): string {
  switch (deviceState) {
    case 'processing':
      return 'No jobs in the queue, but the device reports it is printing — it is most likely finishing the last one.';
    case 'stopped':
      return 'No jobs in the queue. The device is stopped and needs attention.';
    case 'idle':
      return 'No active print jobs. The device is idle.';
    default:
      return 'No active print jobs.';
  }
}

export function JobTable({
  jobs,
  deviceState,
}: {
  jobs: Job[];
  deviceState: DeviceState;
}) {
  if (jobs.length === 0) {
    return <div className="empty-queue">{emptyMessage(deviceState)}</div>;
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Job</th>
            <th scope="col">Document</th>
            <th scope="col">Submitted by</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const style = STATE_STYLES[job.state];
            return (
              <tr key={job.jobId}>
                <td className="job-id">#{job.jobId}</td>
                <td className="job-name">{job.name}</td>
                <td>{job.user}</td>
                <td>
                  <span className="status-pill" style={{ backgroundColor: style.color }}>
                    {style.label}
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
