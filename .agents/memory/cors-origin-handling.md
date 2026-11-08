---
name: CORS behind the artifact proxy
description: CORS behavior for the API when the web app and API share a proxied public origin.
---

For browser requests to the same proxied public origin, derive the request origin from forwarded protocol and host and allow that exact origin. Keep cross-origin access on the explicit allowlist. A denied CORS origin should omit CORS permission headers rather than throw an application error.

**Why:** The proxy's public origin may not be present in the API process's static environment allowlist. Throwing from the CORS callback turns otherwise normal browser requests into HTTP 500 responses.

**How to apply:** When changing API CORS policy, preserve exact same-origin requests through the artifact proxy, retain explicit allowlisting for cross-origin clients, and verify rejected origins do not produce 5xx responses.
