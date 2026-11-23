# Pre-Commitment Guard Record (Notion Memory Wiki)

> Date: 2026-11-22
> Inputs reviewed: [PRD.md](../PRD.md), [GLOSSARY.md](../GLOSSARY.md), [docs/research-decisions.md](./research-decisions.md) Section 6.
> Missing input noted: `docs/api-spike-results.md` does not exist yet.
> Verdict: **adjust** (1 active flag, 1 drafted follow-up action; user approved proceeding to `DESIGN-DOC.md`).

## Locked Architectural Decisions (Subject to Final Call)

| Decision Area | Chosen Option | Key Rejected Alternatives |
|---|---|---|
| **Ontology model** | Option 1A: Layered Declarative Semantic-Kinetic model (machine-synced Notion snapshot separate from human-editable `ontology.yaml`, plus optional 6-database starter kit for blank workspaces). | Full Semantic Web triple store (RDF/OWL/SHACL); flat `workspace.json` registry. |
| **Language and runtime** | TypeScript on Node 22+ (built-in `fetch`, `npx` distribution, TypeScript discriminated unions for Notion JSON, alignment with Notion reference repos and official `@modelcontextprotocol/sdk` for v1.1). | Go (strong single binary, but no official Notion SDK and manual translation of TS references); Python 3.12+ (slower CLI cold start and virtual environment friction without `uv`). |
| **Integration surface and Level 0 delivery** | Option 2C scoped to v1.0: AXI CLI + runtime `SKILL.md` + `wiki render` (or `SessionStart` hook, one canonical mode per profile verified by `wiki doctor`). Optional thin 4-tool MCP adapter deferred to v1.1. | Dual CLI + MCP in v1.0; MCP-only surface. |
| **Local storage and sync** | Option 3B for v1.0: Atomic JSON files behind a `MetadataStore` interface (`ontology.yaml`, atomic `cache.json`, `fractal-pointers.json`, `rate-limit-state.json`, and one file per pending proposal). Upgrade to disposable SQLite WAL only if record-stub caching is added later. | Disposable SQLite WAL in v1.0 (avoided to prevent database driver friction and Node 22 `node:sqlite` stderr warnings); zero local cache. |
| **Notion HTTP client** | Raw built-in `fetch` (~200-line typed client with `Notion-Version: 2026-03-11`, direct `Retry-After` and `additional_data.rate_limit_reason` handling, and strict `api.notion.com` host allowlist). | Thin wrapper over `@notionhq/client` (lags behind `2026-03-11` and Views API); wrapping external `ntn` CLI (subprocess overhead, broken 429 handling, full-user permissions). |
| **Setup and maintenance packaging** | Option 4A: Single CLI package + `agentskills.io` bundle (runtime `SKILL.md` and removable setup `SKILL.md`) + `wiki render` + zero-LLM terminal fallback (`wiki setup`), deterministic lint as maintenance default. | Host-specific MCP auto-installers; prompt-only scripts with no runtime enforcement. |

## 7-Question Pre-Commitment Gate Answers

1. **Framing (v1.0 scope and verifiable done criteria):**
   Lock v1.0 to the CLI, runtime `SKILL.md`, and `wiki render` (deferring the optional thin 4-tool MCP adapter to v1.1). Verifiable done criteria are initial setup under 5 minutes on both the author's Wiki and a minimal blank workspace, total Level 0 startup context under 1,500 tokens, zero HTTP 429 rate-limit errors caused by Notion Memory Wiki during active chats, and 90% or higher link-free Notion task accuracy measured over 30 days.
2. **Why this option (2+ alternatives per choice):**
   All six architectural decisions above were compared against at least two concrete alternatives (TypeScript vs Go vs Python; atomic JSON vs disposable SQLite WAL vs no cache; raw `fetch` vs `@notionhq/client` vs `ntn`; v1.0 CLI-only vs dual CLI+MCP vs MCP-only; Layered Semantic-Kinetic ontology vs RDF/OWL vs flat JSON; single CLI + `agentskills.io` bundle vs host-specific MCP installers vs prompt-only scripts).
3. **Pre-mortem (top failure mode and early-detection check):**
   Live Notion API surprises on native Wiki roots (`wiki: true`) or the Views API (`GET /v1/views?data_source_id=...`) break two-level setup. Selected early-detection check: run the 5-call live API spike before implementation starts.
4. **Devil's advocate (contradicting evidence and Guard Input 3):**
   User chose to skip the live Notion API spike for now and rely on static `2026-03-11` documentation until integration tests run. (Logged as Flag 1 because it conflicts with the prevention check chosen in Question 3.)
5. **Blind spot (Guard Inputs 5 and 6, security reality, overflow, and exclusions):**
   Lock three design guardrails: enforce one canonical Level 0 injection mode per profile (verified by `wiki doctor`); state clearly what is platform-enforced (Notion internal integration page sharing, out-of-band human `wiki approve`, host command `ask` rules) vs application-level operational governance (`WIKI_AGENT_PROFILE`); and switch the Level 0 catalog to area-grouped summaries whenever confirmed databases exceed 30. Accepted exclusion: shell-less MCP-only clients wait for v1.1.
6. **Real cost and opportunity cost:**
   USD 0 extra money beyond existing Notion and LLM plans, plus 15 to 30 hours of focused work over 2 to 4 weeks. Opportunity cost: delays other personal side projects until daily multi-agent Notion workflows are stable.
7. **Second opinion:**
   No external human review completed yet. Plan: once minimal setup works, ask 1 to 2 technical tester friends with different Notion layouts (including a workspace with no `Agent Operating Guide`) to review setup and run 3 real tasks. (Logged as Flag 2 because no external perspective has checked the design before lock.)

## Verdict and Named Flags

- **Verdict:** `adjust` (1 active flag; user makes the final decision).
- **Flag 1 (Unverified live Notion API contract and Q3 vs Q4 tension):** In Question 3, you named live Notion API surprises on native Wiki roots (`wiki: true`) and `GET /v1/views?data_source_id=...` as the top failure mode, while in Question 4 you chose to defer live API verification until implementation and integration testing (`docs/api-spike-results.md` is absent). Adjustment written into `DESIGN-DOC.md`: include an explicit fallback discovery path (`POST /v1/search` for `data_source` plus interactive hub placement) if `GET /v1/views` or native Wiki root responses differ from static docs.
- **Follow-up action (Question 7, not a blocking flag):** No peer or tester friend has reviewed the design yet; a short review ask is drafted below to send once `DESIGN-DOC.md` or initial `wiki setup` is ready.

## Drafted Second-Opinion Ask (Question 7 Action)

Send this short ask to 1 or 2 technical tester friends who use Notion with Claude Code, Cursor, Codex, or Hermes:

> I am designing an open-source CLI (`Notion Memory Wiki`) so AI agents can query and update your Notion databases without pasted links and using under 1,500 startup tokens. Setup scans 2 levels from one Notion Root Page without reading rows, writes a small human-editable `ontology.yaml` file, and works even if you have zero guide pages. Would you spend 10 minutes reading the 4-section `DESIGN-DOC.md` (or trying the initial `wiki setup` command on your own workspace) and tell me what looks awkward or specific to my Notion layout?

## User Final Call

- **Decision (2026-11-22):** Proceed directly to writing the lean 4-section `DESIGN-DOC.md` with all confirmed choices and verify live Notion API behavior during implementation and integration testing.
