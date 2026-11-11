# Issue tracker: Linear

Issues and specs for this repo live in **Linear**: workspace `spiritledsoftware`, team **SPI** (Spirit-Led Software), project **Pi Extensions**. The team also holds other repos' projects (Commissary, cloudpid, lspctl, Neopane, …), so create every issue for this repo in project `Pi Extensions`, and scope every read to it.

**GitHub Issues are the public intake.** Outside users open issues on GitHub. A one-way sync (GitHub → Linear) copies each new one into team SPI, carrying its GitHub URL as an attachment. Comments in its synced thread sync both ways (**Comment on an issue**), and closing it in Linear closes it on GitHub. The sync puts the copy in no project; the workflow `linear project` (`.github/workflows/linear-project.yml`, `scripts/linear-project.sh`) moves it into Pi Extensions once it appears. It reads the repository secret `LINEAR_API_KEY`, a Linear API key that may edit SPI's issues. Dispatch that workflow with an issue number to retry one whose run failed (an issue opened before the sync existed has no copy to move). Work every issue in Linear and refer to it by its Linear identifier (`SPI-123`). Never create issues with `gh issue create`. A GitHub number (`#519`) resolves to the Linear issue that carries its URL (**Read an issue** below).

## How to reach Linear

1. **Executor (default).** Executor's Linear app, through its MCP tools `call` / `execute`, under `tools.linear.*` with account `acc_0c3d8286-c8a7-491e-ae0c-e433e1367c79`.
   - Every tool takes `{ accountId, input: { arguments: { … }, select: "<GraphQL selection>" } }`.
   - Issue ids accept identifiers (`SPI-123`).
   - A call may pause for the user's approval. Show the request and resume it; never repeat the call.
2. **The `linear` CLI (fallback)**, `@schpet/linear-cli`, installed globally through mise and signed in with `linear auth login`. Use it when:
   - Executor's tools aren't available in the session;
   - its Linear app fails;
   - the user declines an approval.

   With the CLI:
   - Pass `--team SPI` to every query (no repo default is configured).
   - Pass `--no-input` to writes.
   - Pass markdown through `--description-file` / `--body-file`.
   - Use `linear api` (GraphQL on stdin) for anything without a dedicated command.

Both reach the same API, so the GraphQL selections below work in either.

| Thing                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team `SPI`              | `86ad747a-262a-4ab8-a716-3a7b3cd5a6af`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Project `Pi Extensions` | `3595e88d-3e8b-4919-9260-f6c9c44bd989`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| States (name: type)     | Backlog: backlog `0b2345bf-8a16-4fd5-8150-ab08e0d74a26` · Todo: unstarted `ad8f9e8b-f89d-4623-8571-68607c315057` · Blocked: unstarted `e417759b-5003-44fd-bfdd-fc6159afb145` · In Progress: started `a52ed858-c23e-4098-8fd1-a313fb0f2204` · In Review: started `62d08185-be69-4fe5-873a-1710a52fb9aa` · Done: completed `d8e326e4-cff3-4cca-a760-5b19efccf264` · Canceled: canceled `9bff72eb-c2dc-4f1a-a6a5-c7522d98fc15` · Duplicate: duplicate `1c1bf170-8bc4-4e7a-b7d8-d18a2d31e3a9` |

Label ids are in `docs/agents/triage-labels.md`. For any other label: `tools.linear.query_issueLabels` with `filter: { name: { eq: "<name>" }, team: { key: { eq: "SPI" } } }`, or `linear label list --team SPI --json`.

## Conventions

- **Create an issue**:
  - Executor: `tools.linear.mutation_issueCreate`, `arguments: { input: { teamId, projectId, title, description, labelIds?, parentId? } }`, `select: "identifier url"`.
  - CLI: `linear issue create --team SPI --project "Pi Extensions" --title "…" --description-file body.md [--label <name>] [--parent SPI-1] --no-input`.
- **Read an issue**:
  - Executor: `tools.linear.query_issue`, `arguments: { id: "SPI-123" }`, `select: "identifier title description url state { name type } labels { nodes { name } } assignee { name } parent { identifier } children { nodes { identifier title state { type } } } comments { nodes { body createdAt user { name } } } attachments { nodes { url } }"`.
  - CLI: `linear issue view SPI-123 --json`.
  - From a GitHub number: Executor `tools.linear.query_attachmentsForURL`, `arguments: { url: "https://github.com/ian-pascoe/pi-extensions/issues/<n>" }`, `select: "nodes { sourceType issue { identifier } }"`; take the node whose `sourceType` is `github` (the sync's; another issue may link the same URL by hand). The CLI uses the same query through `linear api`.
- **List issues**:
  - Executor: `tools.linear.query_issues`, `arguments: { first: 100, filter: { project: { id: { eq: "<Pi Extensions>" } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } }, labels: { name: { eq: "<label>" } } } }`, `select: "nodes { identifier title state { name } labels { nodes { name } } assignee { name } }"`.
  - CLI: `linear issue query --team SPI --project "Pi Extensions" [--label <name>] [--state backlog --state unstarted --state started] --json`.
- **Make an issue a sub-issue of a parent**:
  - Executor: `parentId: "SPI-1"` at creation, or `tools.linear.mutation_issueUpdate` with `arguments: { id, input: { parentId } }`.
  - CLI: `--parent SPI-1` on `issue create` / `issue update`.
- **Comment on an issue**:
  - Executor: `tools.linear.mutation_commentCreate`, `arguments: { input: { issueId: "SPI-123", body } }`.
  - CLI: `linear issue comment add SPI-123 --body-file comment.md`.
  - A plain comment stays in Linear. To reach the reporter of a synced GitHub issue (a `needs-info` question, a won't-fix reason), reply in its **synced thread**: the root comment whose body starts "This comment thread is synced to a corresponding GitHub issue" (read the issue's `comments { nodes { id body parent { id } } }`, or `linear issue comment list SPI-123 --json`). Executor: add `parentId: "<root comment id>"`; CLI: `--reply-to <root comment id>`. A reply there shows on GitHub.
- **Apply / remove labels**:
  - Executor: `tools.linear.mutation_issueAddLabel` / `mutation_issueRemoveLabel`, `arguments: { id: "SPI-123", labelId }`.
  - CLI: `linear issue update SPI-123 --add-label <name>` / `--remove-label <name>`.
- **Close**:
  - Comment first, then set the state to Done, or Canceled for won't-do: Executor `tools.linear.mutation_issueUpdate`, `arguments: { id, input: { stateId } }`; CLI `linear issue update SPI-123 --state Done`.
  - A duplicate is a relation: `mutation_issueRelationCreate` with `type: "duplicate"`, or `linear issue relation add SPI-2 duplicate SPI-1`; then set SPI-2's state to Duplicate.

## Pull requests

Code and PRs stay on GitHub (`gh`, the `code-host` skill). To close an issue from a PR, put `Fixes SPI-123` in the PR body (Linear's magic words). Linear's GitHub integration links the PR and moves the issue to Done when it merges. Use the Linear identifier for synced GitHub issues too.

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_ When `yes`, read and act on external PRs with `gh` (`gh pr view <n> --comments`, `gh pr diff <n>`, `gh pr comment`, `gh pr edit --add-label`, `gh pr close`), and list them with `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, labels: [.labels[].name]}'`.

## When a skill says "publish to the issue tracker"

Create a Linear issue in team SPI, project Pi Extensions.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above; a GitHub number resolves through its URL.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: an issue labelled `wayfinder:map` in project Pi Extensions, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a sub-issue of the map (**Make an issue a sub-issue of a parent**), labelled `wayfinder:<type>` (`research` / `prototype` / `grilling` / `task`). Once claimed, it is assigned to the driving dev.
- **Blocking**: Linear's `blocks` relation, from the blocker to the blocked ticket.
  - Executor: `tools.linear.mutation_issueRelationCreate`, `arguments: { input: { type: "blocks", issueId: "<blocker>", relatedIssueId: "<child>" } }`.
  - CLI: `linear issue relation add <child> blocked-by <blocker>`.
  - A ticket is unblocked when every blocker is completed, canceled or a duplicate.
- **Frontier query**: one query lists every child with its state, labels, assignee and blockers.
  - Executor: `tools.linear.query_issue` with `arguments: { id: "<map>" }` and the block below as its `select`.
  - CLI: `linear api --variable id=<map>` with `query($id: String!) { issue(id: $id) { … } }` on stdin, the block below in place of `…`.

  ```graphql
  children(first: 250) { nodes { identifier title state { type } labels { nodes { name } } assignee { name }
    inverseRelations { nodes { type issue { identifier state { type } } } } } }
  ```

  A child's `blocks` entries in `inverseRelations` are its blockers. Keep the children whose state type is not `completed` / `canceled` / `duplicate`, that have no assignee, and whose blockers are all `completed` / `canceled` / `duplicate`; the first one wins.

- **Claim**, the session's first write:
  - Executor: `tools.linear.mutation_issueUpdate`, `arguments: { id, input: { assigneeId: "<viewer id>" } }` (`tools.linear.query_viewer`, `select: "id"`).
  - CLI: `linear issue update <n> --assignee @me`.
- **Resolve**: comment the answer, set the state to Done (**Close**), then append a context pointer (gist + link) to the map's Decisions-so-far. Read the map's description first: `issueUpdate`'s `description` replaces it whole, and the CLI's `--description-file` does the same.
