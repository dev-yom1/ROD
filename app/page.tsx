const checks = [
  "Missing environment variables",
  "Incomplete install instructions",
  "Broken README commands",
  "Node.js / Python runtime requirements",
  "Observed startup URL and port",
  "Documentation drift",
];

export default function HomePage() {
  return (
    <main style={{ maxWidth: 840, margin: "0 auto", padding: "72px 24px" }}>
      <div style={{ fontSize: 56, marginBottom: 20 }}>🩺</div>
      <p style={{ letterSpacing: ".12em", textTransform: "uppercase", opacity: 0.65, fontSize: 13 }}>Repo Onboarding Doctor</p>
      <h1 style={{ fontSize: "clamp(42px, 8vw, 72px)", lineHeight: 1, margin: "12px 0 24px" }}>Does the README actually work?</h1>
      <p style={{ fontSize: 21, lineHeight: 1.6, color: "#bcc5d1", maxWidth: 720 }}>
        ROD checks pull requests from a fresh isolated environment, follows the documented setup path, and posts actionable onboarding findings back to GitHub.
      </p>
      <section style={{ marginTop: 48, padding: 28, border: "1px solid #252a31", borderRadius: 20, background: "#11151a" }}>
        <h2 style={{ marginTop: 0 }}>What ROD checks</h2>
        <ul style={{ lineHeight: 2, color: "#d8dee8" }}>
          {checks.map((check) => <li key={check}>{check}</li>)}
        </ul>
      </section>
      <p style={{ marginTop: 32, color: "#7f8a99" }}>Webhook endpoint: <code>/api/github/webhook</code></p>
    </main>
  );
}
