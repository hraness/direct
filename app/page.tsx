import { SiteFooter, SiteHeader } from "./site-shell";

export const dynamic = "force-static";

const installCommand =
  "bun add --dev github:hraness/direct#v0.4.0";

const capabilities = [
  {
    title: "Named app states",
    description:
      "Open signed-out, empty, populated, slow, or failing states from a stable URL.",
  },
  {
    title: "Fast reset",
    description:
      "Return to the same validated starting world without rebuilding accounts or cloud data.",
  },
  {
    title: "A real readiness signal",
    description:
      "Wait for tracked work to settle instead of guessing with a fixed delay.",
  },
  {
    title: "Honest evidence",
    description:
      "Record which checks used deterministic replacements and which still need the live system.",
  },
] as const;

const choices = [
  {
    title: "Use agent-browser by itself",
    description:
      "Choose this when the state you need is already quick and reliable to reach, or when the live backend and browser assembly are part of the check.",
    label: "Page control",
  },
  {
    title: "Use Direct with agent-browser",
    description:
      "Choose this when login, seed data, devices, permissions, models, or failure states consume more time than the interface work.",
    label: "App-state control",
  },
] as const;

export default function HomePage() {
  return (
    <>
      <a className="direct-skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader activeRoute="home" />

      <main id="main">
        <section className="direct-shell direct-hero">
          <p className="direct-kicker">Deterministic app states for browser agents</p>
          <h1>Give your frontend agent the exact state it needs.</h1>
          <p className="direct-hero__dek">
            Browser tools control the page. Direct controls the state behind it,
            so agents can work on the real interface without waiting on accounts,
            cloud data, devices, permissions, or models.
          </p>
          <div className="direct-hero__actions">
            <a className="direct-primary-link" href="/docs/overview">
              Read the overview
            </a>
            <a className="direct-secondary-link" href="https://github.com/hraness/direct">
              View on GitHub
            </a>
          </div>

          <div className="direct-install" aria-labelledby="install-title">
            <div>
              <p className="direct-install__label" id="install-title">
                Install
              </p>
              <p className="direct-install__note">
                Keep Direct in development dependencies.
              </p>
            </div>
            <pre tabIndex={0}><code>{installCommand}</code></pre>
            <p className="direct-install__skills">
              Then load <code>skills/direct-setup</code> from the installed
              package in your coding agent.
            </p>
          </div>
        </section>

        <section className="direct-section direct-problem">
          <div className="direct-shell direct-two-column">
            <div>
              <p className="direct-section__label">The problem</p>
              <h2>Opening the page is often the easy part.</h2>
            </div>
            <div className="direct-prose">
              <p>
                An agent can click, type, and take a screenshot. It can still
                spend most of its time signing in, creating data, waiting for a
                service, or trying to reproduce an error.
              </p>
              <p>
                Direct gives the product a separate development composition.
                The real interface and feature logic stay in place. Small
                product-owned interfaces connect them to deterministic
                replacements for the slow external systems.
              </p>
            </div>
          </div>
        </section>

        <section className="direct-shell direct-section">
          <div className="direct-section-heading">
            <p className="direct-section__label">What you get</p>
            <h2>Repeatable states without a second frontend.</h2>
          </div>
          <div className="direct-capability-grid">
            {capabilities.map((capability) => (
              <article key={capability.title}>
                <h3>{capability.title}</h3>
                <p>{capability.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="direct-section direct-decision">
          <div className="direct-shell">
            <div className="direct-section-heading">
              <p className="direct-section__label">Which setup fits?</p>
              <h2>Start with the smallest tool that covers the risk.</h2>
              <p>
                Direct works with agent-browser, Playwright, or another browser
                driver. It does not replace them.
              </p>
            </div>
            <div className="direct-choice-grid">
              {choices.map((choice) => (
                <article key={choice.title}>
                  <p className="direct-choice-grid__label">{choice.label}</p>
                  <h3>{choice.title}</h3>
                  <p>{choice.description}</p>
                </article>
              ))}
            </div>
            <p className="direct-decision__boundary">
              Keep unit and component tests for isolated logic. Keep live
              integration and end-to-end tests when the backend, native host,
              browser assembly, operating system, or device is the subject.
            </p>
          </div>
        </section>

        <section className="direct-shell direct-section direct-how">
          <div className="direct-section-heading">
            <p className="direct-section__label">How it fits</p>
            <h2>The browser drives the interface. Direct supplies the world.</h2>
          </div>
          <ol className="direct-steps">
            <li>
              <span>1</span>
              <div>
                <h3>Name the states</h3>
                <p>Define the starting data, route, and evidence claim.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h3>Keep the real interface</h3>
                <p>
                  Put the external system behind a product-owned interface, not
                  behind a copied UI.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <h3>Drive it with your browser tool</h3>
                <p>
                  Open a named state, perform the task, wait for settled work,
                  and assert the result.
                </p>
              </div>
            </li>
          </ol>
          <div className="direct-next">
            <p>
              The Overview explains the architecture, the proof boundary, and
              when Direct is worth adding.
            </p>
            <a href="/docs/overview">Read the Overview</a>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
