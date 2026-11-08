## 🤝 Ceasefire collision forecast

**Verdict: ⚠️ Advisory** — 1 potential collision across 2 open PRs (1 draft). Forecast for `1111111`. · [workflow run](https://example.invalid/run/1)
<sub>example/repo</sub>

> Ceasefire is **advisory in v1** — nothing here blocks a merge automatically. Treat 🔴 rows as “talk before merging”.

### Collision matrix

| PRs | Severity | Files at risk |
|-----|----------|---------------|
| agent-a/feat/login (1f0c9a2e) ↔ agent-b/fix/session (8c1d77e0) | 🟡 Intent | `src/auth/` |

### What this means

#### 🟡 Intent

Two agents are working the **same area at the same time**. The file lists differ, but the changes may overlap logically — renames, refactors, or API changes the other side assumes.

- **agent-a/feat/login (1f0c9a2e)** ↔ **agent-b/fix/session (8c1d77e0)**: `src/auth/`

**Next step:** Skim the other PR’s diff before merging. If it touches the same functions, coordinate in the PR thread first.

---
**Re-run:** push new commits and ceasefire re-forecasts automatically. Or comment `/ceasefire rerun` on this PR (needs the `issue_comment` trigger in `.github/workflows/ceasefire.yml`).

<sub>Posted by ceasefire — collision forecasting for parallel agents. Forecasts are heuristic; always review before merging.</sub>
<!-- ceasefire-collision-matrix -->