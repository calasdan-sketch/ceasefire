## 🤝 Ceasefire collision forecast

**Verdict: 🛑 Blocked** — 2 potential collisions across 2 open PRs (1 draft). Forecast for `1111111`. · [workflow run](https://example.invalid/run/1)
<sub>example/repo</sub>

> Ceasefire is **advisory in v1** — nothing here blocks a merge automatically. Treat 🔴 rows as “talk before merging”.

### Collision matrix

| PRs | Severity | Files at risk |
|-----|----------|---------------|
| #12 feat/login ↔ #13 fix/session | 🔴 Textual | `src/auth/session.ts`, `src/auth/login.ts` |
| #12 feat/login ↔ #13 fix/session | 🔴 Textual | `package-lock.json` |

### What this means

#### 🔴 Textual

Git predicts a **real merge conflict** here — merging either branch will stop at these files until someone resolves it by hand.

- **#12 feat/login** ↔ **#13 fix/session**: `src/auth/session.ts`, `src/auth/login.ts`
- **#12 feat/login** ↔ **#13 fix/session**: `package-lock.json`

**Next step:** Rebase one branch onto the other and resolve locally, or get the two authors to agree on a merge order in the PR thread.

---
**Re-run:** push new commits and ceasefire re-forecasts automatically. Or comment `/ceasefire rerun` on this PR (needs the `issue_comment` trigger in `.github/workflows/ceasefire.yml`).

<sub>Posted by ceasefire — collision forecasting for parallel agents. Forecasts are heuristic; always review before merging.</sub>
<!-- ceasefire-collision-matrix -->