/**
 * Shown once the ten-minute session budget runs out.
 *
 * Unlike the prototype this does not try to close the tab — it just stops
 * polling and waits for a deliberate click.
 */
export function SyncPausedScreen({ onResume }: { onResume: () => void }) {
  return (
    <div className="paused-screen">
      <h2>Live sync paused</h2>
      <p>
        Auto-refresh stopped after 10 minutes so idle dashboards don&apos;t keep
        querying the plotter. The readings below are no longer updating.
      </p>
      <button type="button" className="btn-primary" onClick={onResume}>
        Resume live sync
      </button>
    </div>
  );
}
