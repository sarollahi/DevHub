import Link from "next/link";
export default function RepositoryNotFound() {
  return <main className="repo-error-page"><h1>Repository or file unavailable</h1>
    <p>The requested resource may not exist, or your account does not have permission to view it.</p>
    <Link href="/repositories">Return to repositories</Link>
  </main>;
}
