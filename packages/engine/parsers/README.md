# Parsers

Parsers turn raw evidence (`evidence/raw/<EXP>/<job>/`) into tables (`evidence/tables/<EXP>/<job>/`). Only parsers and
the executor write `evidence/` (DR-0007), so a number a claim derives (a ratio, a mean) is computed here, by code, and
the claim cites the table line (`re claim check`).

Contract, for every parser:
- `python3 -I <parser>.py <input file> <output dir>`: write tables into the output dir, print one JSON manifest line on
  stdout: `{"parser", "version", "outputs": [{"path", "rows", "description"}], "notes": []}`. The manifest must list
  exactly the files written.
- Standard library only. Python >= 3.11 in production (it runs in the agent image, no network, no model, with only its
  input and its own code mounted); keep it 3.9-compatible so host-side tests run with macOS's python3.
- Deterministic: same input, same output. Bump `version` when the output changes.
- Register it in `registry.json` with a file-name `match` glob (and `skip` globs for files it must not re-read).

`re evidence parse EXP-001 [--job <id>]` runs every matching parser over the experiment's committed raw evidence and
commits the outputs with a `PARSED.json` record (input path and sha256, parser, version, outputs). The tables carry the
provenance of the evidence they derive from.
