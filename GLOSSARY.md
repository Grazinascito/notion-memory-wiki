# Notion Memory Wiki

Domain vocabulary for Notion Memory Wiki, defining the core product concepts for shared human and AI agent context over Notion.

## Language

**Context System**:
A central, structured space in Notion where humans and AI agents read, save, and route practical knowledge so context compounds across sessions and agents over time.
_Avoid_: Memory graph, local memory database, isolated chat memory

**Agent Operating Guide**:
A recommended set of initial orientation pages inside the Notion Wiki describing the user, work guidelines, processes, and agent roles, delivered to connected agents through `Progressive Disclosure` with a concise startup summary and longer pages opened on demand. Optional for new workspaces, with a starter template offered during setup.
_Avoid_: Giant static system prompt, loose local rule files, mandatory setup blocker

**Ontology**:
An explicit model of the object types inside a Notion workspace, including core databases, Wiki pages, properties, valid options, optional user-declared required fields, and permitted relationships, enabling humans and agents to navigate and maintain the Context System accurately using fewer tokens.
_Avoid_: Loose document folder, implicit map, flat page list

**Knowledge Graph**:
The live network of actual Notion pages, database records, and native relation links organized according to the workspace `Ontology`, allowing agents to traverse connected entities inside their permitted `Agent Scope` without pasted links.
_Avoid_: Parallel LLM-rebuilt memory graph outside Notion

**Fractal Structure**:
A layered layout where local or one-off databases live inside individual database records or deep sub-pages, loaded on demand at Level 2 so they cost zero tokens until an agent opens that specific record or page.
_Avoid_: Flat database list, single-level hierarchy, top-level hub pages

**Context Sync**:
Synchronization maintained by Notion Memory Wiki between the workspace map, `Agent Operating Guide` index, and learned Level 2 fractal pointers with Notion as the single source of truth, where Notion always wins on schema or content drift.
_Avoid_: Business workflow automation, heavy background transcript extraction

**Context Maintenance**:
An optional, off-peak scheduled routine over Notion pages inside the `Root Page` and notes deposited into the designated `Capture Inbox`, applying only validated additive updates autonomously while holding proposed `Destructive Actions` in a concise run summary for user approval.
_Avoid_: Real-time all-chat surveillance, local chat log scraping, burst extraction on every session end

**Capture Inbox**:
A user-designated Notion page or database where the user or any connected agent can explicitly deposit quick notes or session takeaways during active chat for later off-peak processing by `Context Maintenance`.
_Avoid_: Hidden platform-specific chat log scraper

**External Sync**:
Continuous or periodic ingestion of data from external applications such as calendar, email, or Slack into Notion, delegated to Notion's native Syncs or separate external tools rather than built inside Notion Memory Wiki.
_Avoid_: Direct per-agent integrations to dozens of separate tools

**Root Page**:
The top-level Notion page or native Notion Wiki database (`wiki: true`) chosen by the user during setup that defines the workspace boundary, including top-level hub pages and user-approved linked views.
_Avoid_: Unbounded full workspace crawl, loose list of manual links

**Taxonomy**:
The hierarchical classification of areas, sections, and categories that organizes pages and documents inside the Context System, such as `Agents Operating Guide`, `Second brain`, and `Carreira`.
_Avoid_: Database schema, flat ungrouped list

**Validation**:
Deterministic verification executed with zero LLM calls before writing to Notion to reject structurally invalid inputs against Notion's native schema (title, types, valid select, multi-select, and status options, read-only guards, and relation targets), `Agent Scope`, and any user-declared required fields in the `Ontology`.
_Avoid_: Unchecked freeform writes, LLM-dependent write validation

**Destructive Action**:
Any write that deletes or archives a Notion page or database record, moves a page (`POST /v1/pages/{id}/move`), clears a populated property, drops existing items via full array replacement on `relation` or `multi_select`, or overwrites existing non-empty user prose (including page body Markdown and populated `title` or `rich_text` properties), always requiring explicit user approval before execution. Additive writes (`POST /v1/pages`, Markdown append, `--add` on `relation` or `multi_select`) and routine non-empty scalar workflow updates (changing `status`, `select`, `date`, `checkbox`, or removing a single tag or relation while leaving the property non-empty) are non-destructive.
_Avoid_: Additive append, creating a new record, routine status update

**Autonomous External Action**:
Any side effect outside the authorized Notion workspace and the active user conversation initiated independently by the memory layer, such as sending emails, messaging third parties, or modifying external SaaS tools, always blocked by Notion Memory Wiki.
_Avoid_: Authorized Notion read or write, user-configured actions run by an external agent platform

**Factory**:
A specialized, repeatable, and monitored AI workflow built on top of the Context System to handle a specific domain responsibility, whether across a team or across a personal set of specialist agents such as dedicated project, research, or wellbeing agents.
_Avoid_: Generic one-off chat, hardcoded business workflow embedded inside the memory layer

**Specialist Agent**:
An agent configured by the user on any agent platform with a clear responsibility documented in the `Team Directory` and its own `Agent Scope` over Notion Memory Wiki, collaborating with other specialists on the same `Knowledge Graph`.
_Avoid_: Unrestricted general bot accessing the entire Wiki

**Agent Scope**:
An application-level per-agent operational boundary defining which areas, databases, and relation traversals of the workspace `Ontology` appear at Level 0 and can be read or edited by that `Specialist Agent` inside the `Root Page`. Hard credential-level isolation remains enforced via Notion's native sharing permissions.
_Avoid_: Hardcoded private topic categories, enterprise multi-human RBAC

**Progressive Disclosure**:
Three-level context loading (Level 0 startup context under 1,500 tokens total including tool definitions, Level 1 single-destination details and ID resolution on demand outside the LLM prompt, and Level 2 per-record `Fractal Structure` branches loaded only when that record or page is opened) designed to prevent context rot.
_Avoid_: Full workspace dump in the initial prompt, upfront loading of all schemas and pages
