export default function LoadingRepository() {
  return <div className="repo-loading" role="status" aria-live="polite" aria-busy="true">
    <div className="repo-loading-heading" />
    <div className="repo-loading-bar" />
    <div className="repo-loading-content">
      {Array.from({length:8},(_,i)=><div key={i} className="repo-loading-row" />)}
    </div>
    <span className="repo-loading-label">Loading repository records…</span>
  </div>;
}
