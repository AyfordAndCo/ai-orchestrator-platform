# AI Orchestrator Platform Specification

## Purpose

The AI Orchestrator Platform coordinates controlled software-development
workflows across repositories.

The platform manages execution. It does not allow AI agents to bypass
engineering, security, QA, or deployment gates.

## Core Principles

1. Agents operate in isolated workspaces.
2. One issue maps to one feature branch and one pull request.
3. AI providers are replaceable.
4. Workflow gates are provider-independent.
5. Implementation and review are independently executed.
6. GitHub CI is an authoritative technical validation gate.
7. Human approval remains required for controlled production actions.
8. Production repositories and agent workspaces remain separate.

## Applications

### orchestrator-api

Responsible for:

- orchestration commands
- run queries
- administrative APIs
- validation of external requests

The API does not directly execute coding workloads.

### orchestrator-worker

Responsible for:

- workspace provisioning
- agent execution
- validation execution
- Git operations
- integration workflow execution

### dashboard-web

Responsible for:

- run visibility
- workflow status
- validation results
- review findings
- QA approval actions

## Packages

### domain

Contains provider-independent domain models, rules, state transitions,
and contracts.

### integrations

Contains adapters for external services and AI providers.

### observability

Contains logging, metrics, tracing, and operational telemetry.

## Initial Workflow

QUEUED
→ PREPARING_WORKSPACE
→ READY
→ VALIDATING
→ COMPLETED

Future phases will introduce:

IMPLEMENTING
→ COMMITTING
→ PUSHING
→ PR_CREATED
→ CI_RUNNING
→ REVIEWING
→ WAITING_FOR_QA
→ READY_TO_MERGE
→ MERGED
→ DONE

## Security Boundaries

Agent workloads must not receive unrestricted host access.

Agent workloads must not have direct production deployment authority.

Secrets must not be stored in repositories, workspaces, prompts, or logs.

Permissions must follow least privilege.

## Non-Goals for Foundation Phase

The foundation phase does not implement:

- Linear integration
- AI provider integration
- automatic pull request creation
- automatic merge
- production deployment
- dashboard functionality
- database persistence

These are introduced in later roadmap phases.
