/**
 * Guidance prepended to each memory tool's description, so any agent that
 * sees one of these tools also gets the policy in its prompt.
 */
export const MEMORY_GUIDANCE = `
Memory is typed and persistent. Five types:
- user — durable facts about the human (role, preferences, context).
- feedback — rules they want you to keep applying. Include WHY.
- project — workspace facts ("we use pnpm"). Decay if not re-confirmed in 30d.
- reference — pointers to external sources (Linear project, dashboard URL).
- working — notes for the current session tree only; dies with the run.

When to write:
- User says "remember this" or corrects you.
- You learn a load-bearing fact that's not in the code.
- You confirm a non-obvious approach worked.

When NOT to write:
- Today's task list (use create_task).
- Today's conversation (it's already in your history).
- Things easily re-derived from the code or git log.
- Secrets, unless the user explicitly asked you to keep them.

Search before you write — if a near-duplicate exists, memory_update it instead.
Edits are by id (memory_update). Soft-delete with memory_archive.
`.trim();
