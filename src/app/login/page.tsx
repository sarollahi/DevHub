import { redirect } from "next/navigation";
import Icon from "@/components/icons";
import { isAdminRequest } from "@/lib/auth";
export default async function Login() {
  if (await isAdminRequest()) redirect("/inbox");
  return <main className="login-shell">
    <aside className="login-aside"><div className="login-brand"><div className="brand-mark"><Icon name="layers" size={20}/></div>DevHub</div><div className="login-message"><h2>Build at machine speed.<br/>Review with human judgment.</h2><p>One organized workspace for code changes, review decisions, and contributions from people and automated agents.</p></div><div className="login-aside-footer">An engineering-first contribution platform</div></aside>
    <section className="login-main"><div className="login-panel"><p className="page-kicker">WORKSPACE SIGN IN</p><h1>Welcome to DevHub</h1><p className="login-description">Sign in to manage contributions and review activity in your workspace.</p><form className="login-form" action="/api/auth/login" method="post"><label htmlFor="token">Administrator access token</label><input type="password" autoComplete="off" id="token" name="token" minLength={32} required placeholder="Enter your workspace token"/><button className="primary-button" type="submit">Continue to workspace <Icon name="arrow-right" size={16}/></button></form><p className="login-hint">Use the <code>ADMIN_TOKEN</code> defined in your environment configuration.</p></div></section>
  </main>;
}
