# Druvia MCP Server

> Experimental prototype. Do not use this package in production.

This package explores exposing Druvia capabilities to MCP-compatible AI clients. It runs as a local stdio process: the MCP client invokes tools, and this process forwards those operations to the Druvia API.

## Current Status

The prototype registers tools and resources for inspecting tables, querying data, inserting rows, and executing read-only SQL. Registration does not mean those capabilities currently have a supported end-to-end contract.

The current implementation authenticates with a project API key while calling routes that require a platform management identity. Its request headers, route identity, scopes, error mapping, and real API contract tests have not been aligned. It must therefore remain experimental and unpublished.

No supported startup configuration is provided while that identity contract is unresolved.

## Runtime Boundary

The MCP Server is not part of:

- the Druvia Admin or application SDK request path;
- the official local, production, or release Compose deployments;
- release container images or OTA manifests;
- the optional centralized logging deployment.

Changes to this package do not affect a normal Druvia deployment unless an operator separately starts the MCP process.

## Reopening Development

Future work must first choose one explicit identity model:

- a management MCP with a platform or dedicated management credential; or
- a project MCP limited to project-scoped data capabilities.

Before publication or production documentation, every tool must match a real API route, credential scope, request header, response envelope, audit contract, and automated API contract test.
