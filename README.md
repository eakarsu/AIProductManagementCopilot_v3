# AI Product Management Copilot v3

This repository now contains a deliberately small, dependency-free local application boundary. It was restored from an empty repository after inspecting the earlier Product Management Copilot where applicable; no sibling implementation was copied wholesale.

Implemented:

- a static UI with explicit loading and connection-error states;
- a health endpoint;
- a validated local draft endpoint at `/api/decisions`;
- a smoke test that uses an isolated ephemeral port.

Not implemented: durable storage, user authentication/authorization, third-party providers, AI inference, production execution, deployment, or compliance controls. Records returned by the draft endpoint are process-local examples and disappear immediately; they must not be treated as system-of-record data.

Use Node.js 18 or newer. Run `npm test` for the isolated smoke test. Run `npm start` only when you intentionally want the local server on `127.0.0.1:3000`.

