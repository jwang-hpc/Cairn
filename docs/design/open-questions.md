# Open questions

1. Minimum macOS for the prototype: macOS 26 only (Apple container) vs. macOS 15 with Docker fallback.
   Default until decided: macOS 26 primary, Docker fallback implemented in launcher.
2. Project name.
3. Facility policy for agents/commercial model services on LCRC and other DOE systems (blocks Tier 1 only).
4. University IT policy on self-hosted GitHub runners / pollers on the workstation (blocks async trigger only).
5. MCP: pi-mono now ships `@earendil-works/pi-mcp`; M0 verifies it against our executor (Streamable HTTP + bearer token).
6. Does pi-ai subscription auth work on the Claude Team seat? (M0 spike; API fallback otherwise.)
7. Google access path: Gemini API key vs. Vertex AI.
8. Microsoft MAI access path: Microsoft Foundry vs. OpenRouter / Fireworks / Baseten (availability may differ).
9. Per-provider data-class permissions (which providers may receive unpublished or DOE-restricted project data).
