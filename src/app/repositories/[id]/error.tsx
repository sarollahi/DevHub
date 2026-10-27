"use client";
import { useEffect } from "react";
export default function RepositoryError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("Repository page failed", error.digest || error.message); }, [error]);
  return <main className="repo-error-page" role="alert">
    <h1>Repository view unavailable</h1>
    <p>The requested source-control records could not be loaded. No repository data was changed.</p>
    <button type="button" onClick={reset}>Try again</button>
    <a href="/repositories">Return to repositories</a>
  </main>;
}
