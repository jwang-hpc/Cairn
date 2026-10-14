# DR-0009: Context and memory management
Status: Accepted (2026-10-13)

Effective context is far shorter than advertised; long sessions rot. Therefore:
- Disposable sessions. Each starts from PAPER.md plus the files the task references (progressive disclosure).
- Orchestrator keeps a clean main context; subagents return compact, structured results (report.json).
- Tool outputs go through deterministic parsers before reaching a model. Long logs are summarized by code
  (tail, grep, counts), not pasted.
- Old tool outputs beyond a window are masked (try this simple baseline before any learned summarizer).
- Literature: one structured note per paper (problem, method, setup, key numbers, limitations, artifact
  link); PDFs never enter working context whole. Check code/appendix, not only the narrative.
- Memory writes are gated (DR-0007). Dead ends live in trace/exploration_tree.yaml so new sessions do not
  re-propose ruled-out ideas.
- For API-billed calls: keep stable prompt prefixes (system + skills + manifest first) to benefit from caching.
- Study PiPilot's context-compaction design (wiki: Context Compaction) before implementing ours.
