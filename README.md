# ChainGuard
### Real-time smart contract security.

## Ì∫Ä Project Overview
**ChainGuard** is a production-grade Web3 security platform designed to detect threats in the mempool and pause smart contracts before malicious transactions are confirmed.

## Ìøó Tech Stack

### Ì¥ó On-Chain (Smart Contracts)
- **Language:** Solidity (EVM), Vyper (Optional)
- **Security:** OpenZeppelin Pausable, Rate Limiting, Timelocks
- **Tooling:** Foundry (Tests), Hardhat, Slither (Static Analysis), Echidna (Fuzzing)

### Ì≥° Monitoring & Detection
- **Core:** Node.js / TypeScript
- **Chain Interaction:** ethers.js / viem / Erigon Nodes
- **Data Streaming:** Kafka / Redpanda (Event streaming)
- **Indexing:** The Graph / Custom Indexers
- **Detection:** Python (ML Anomaly Detection), Scikit-learn

### Ì≤æ Data Layer
- **Relational:** PostgreSQL
- **Time-Series:** TimescaleDB (High volume metrics)
- **Caching:** Redis (Rate limiting & queues)

### Ì∂•Ô∏è Frontend & Product
- **Framework:** Next.js (React + TypeScript)
- **Styling:** Tailwind CSS
- **Real-time:** WebSockets / SSE for alerts

### ‚òÅÔ∏è Infrastructure
- **Containerization:** Docker
- **Orchestration:** Kubernetes (K8s)
- **IaC:** Terraform
- **Observability:** Prometheus, Grafana, OpenTelemetry

## Ì≥Ç Repository Structure
- `/frontend` - Next.js Dashboard for security alerts
- `/backend` - Node.js monitoring services & Python detection engine
- `/ai-data` - Anomaly detection models & datasets
- `/infrastructure` - Terraform scripts & K8s manifests
- `/docs` - Threat models and architectural diagrams

## Ì∫¶ Getting Started
1. Navigate to `/frontend` to start the dashboard.
2. Navigate to `/backend` to configure your RPC provider URL.
