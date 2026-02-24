---
name: documentation-guide
description: Use this skill when the user asks about "documentation research", "Context7", "how to look up official docs", "MCP Context7", or mentions "resolve-library-id", "query-docs", "WebSearch vs Context7", "official documentation lookup".
---

# Documentation Research Guide

Complete guide for researching official documentation using Context7 and other tools.

## Context7 Priority Policy

**CRITICAL**: When researching any public, official, or open-source documentation, **ALWAYS use MCP Context7 FIRST** before using web search or web fetch.

## When to Use Context7

Context7 should be your **PRIMARY tool** for:

✅ **Official Documentation**
- Framework docs (Fastify, Next.js, React, TypeScript, etc.)
- Library APIs (pg, ioredis, zod, etc.)
- Language references (JavaScript, TypeScript, SQL, etc.)
- Platform guides (Node.js, PostgreSQL, Redis, Hasura, etc.)

✅ **Package Documentation**
- NPM packages
- GitHub repositories
- Open source projects

✅ **Technology Standards**
- HTTP/REST APIs
- SQL standards
- Authentication protocols (OAuth, JWT, etc.)
- Data formats (JSON, YAML, etc.)

## Context7 Workflow

### Step 1: Resolve Library ID
```typescript
// Example: Looking up Fastify documentation
mcp__plugin_context7_context7__resolve-library-id({
  libraryName: "fastify",
  query: "user's original question about Fastify"
})

// Returns library ID like: /fastify/fastify
```

### Step 2: Query Documentation
```typescript
// Use the library ID from Step 1
mcp__plugin_context7_context7__query-docs({
  libraryId: "/fastify/fastify",
  query: "specific question about feature"
})
```

## Technology Stack Mapping

| Technology | Library Name | Typical Queries |
|------------|-------------|-----------------|
| **Fastify** | `fastify` | Routes, plugins, hooks, validation |
| **Hasura** | `hasura` | Permissions, actions, subscriptions |
| **PostgreSQL** | `postgresql` | SQL syntax, indexes, schemas |
| **Redis** | `redis` | Commands, data types, pub/sub |
| **TypeScript** | `typescript` | Types, generics, config |
| **Zod** | `zod` | Schema validation, parsing |
| **pg** | `node-postgres` | Pool, queries, transactions |

## When NOT to Use Context7

Use WebSearch or WebFetch instead for:

❌ **Proprietary/Internal Documentation**
- Company-specific APIs
- Internal tools
- Private repositories

❌ **Breaking News**
- Security vulnerabilities (CVEs)
- Package announcements
- Recent incidents

❌ **Community Content**
- Blog posts
- Tutorial articles
- Stack Overflow answers

## Fallback Chain

**Always follow this priority order**:

```
1. Context7 (for official docs)
   ↓ (if not available)
2. WebFetch (for specific URLs)
   ↓ (if not accessible)
3. WebSearch (for general queries)
   ↓ (if restricted)
4. Internal knowledge (use with caution)
```

## Call Limit Awareness

**Context7 has usage limits**. Follow these rules:

- ⚠️ **Maximum 3 calls per question**
- ✅ Combine related queries into one
- ✅ Use specific, focused queries

## User Communication

### Always Inform User
When using Context7, briefly mention it:

```markdown
✅ GOOD:
"According to the official Fastify documentation (via Context7),
you should use..."

✅ GOOD:
"I've checked the Hasura official docs and found that..."

❌ BAD:
"Based on web search results..." (when Context7 was available)
```

## Best Practices Summary

**Golden Rule**: 🌟

> **When in doubt, Context7 first!**
>
> If it's documented anywhere publicly, Context7 probably has it.
> Use it before any other research tool.

### Quick Checklist

Before answering any documentation-related question:

- [ ] Is this about public/official documentation?
- [ ] Did I try Context7 first?
- [ ] Did I use the correct library ID?
- [ ] Did I stay within the 3-call limit?
- [ ] Did I inform the user about the source?
