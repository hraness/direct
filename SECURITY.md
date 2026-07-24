# Security

Report suspected vulnerabilities through GitHub's private vulnerability reporting for this repository. Do not include sensitive details in a public issue.

Security fixes target the latest version tag. Maintainers will coordinate disclosure and publish a new immutable tag when a fix is ready.

Direct's browser fetch firewall is a development containment aid, not a production security boundary. It does not intercept WebSockets, EventSource, navigation, asset loading, native calls, or traffic outside the JavaScript realm where it is installed.
