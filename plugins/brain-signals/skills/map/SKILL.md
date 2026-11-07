---
name: map
description: Birds-eye architecture map of the current repository, with a rendered ASCII diagram and a component table. Use when the user asks for the big picture, the grand scheme or an architecture overview of a codebase.
context: fork
agent: brain-signals:cartographer
allowed-tools: Bash(gh:*), Bash(git:*), Bash(printf:*), Bash(mermaid-ascii:*), Read, Grep, Glob
---
Produce a birds-eye map of this repository, in the cartographer's order:
1. BLUF (bottom line up front): what this system is and does, in 1-3 lines.
2. Rendered ASCII architecture diagram of the main components (`mermaid-ascii -p 0 -x 1 -y 2`,
   <=80 columns).
3. Table: component | path | responsibility.
4. Key data/control flows as short numbered steps.
5. Where to start reading, and the 3 riskiest areas.
