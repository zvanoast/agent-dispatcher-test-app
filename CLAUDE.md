# Agent Instructions

## Guidance Signal Protocol

When you encounter a blocker — an ambiguous requirement, a decision that needs human input,
missing information, or anything you cannot confidently resolve on your own — you MUST:

1. **Stop working** and create a file called `GUIDANCE_NEEDED.md` in the project root
2. Use this exact format:

```markdown
## Blocker
<Describe what you're blocked on — be specific and concise>

## Options
- Option A: <first approach and its tradeoffs>
- Option B: <second approach and its tradeoffs>
- Option C: <etc., if applicable>
```

3. After writing the file, **stop immediately**. Do not continue working.
   A human will read your question, reply, and the system will resume your session
   with their answer in `GUIDANCE_RESPONSE.md`.

## When to ask for guidance
- Requirements are ambiguous or contradictory
- Multiple valid architectural approaches exist and you're unsure which to pick
- You need credentials, API keys, or external access you don't have
- The task scope is unclear (too broad or too narrow)
- You discover a problem that changes the task significantly

## When NOT to ask
- Standard implementation decisions (naming, file structure, etc.)
- Things you can figure out from the codebase
- Minor style choices
