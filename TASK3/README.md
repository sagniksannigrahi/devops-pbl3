# Task 9: Secure DevOps (DevSecOps) Implementation in a Healthcare System

**MediTrack Secure** is a patient-records service. Patient data is **Protected Health Information (PHI)**,
so security is built into every step: the code, the pipeline, the container, the cluster and the running app.
Every pipeline stage is a **security gate**: if a scan finds a problem, the build stops and the vulnerable
version never reaches Kubernetes.

Runs on its own **AWS EC2 t3.micro** (separate from Tasks 7 and 8) with Jenkins and k3s Kubernetes.

```
 git push ─► Jenkins (EC2)
   │
   ├─ 1 Secret scan ........ Gitleaks: whole git history          ┐
   ├─ 2 SAST ............... ESLint + eslint-plugin-security      │  CODE
   ├─ 3 SCA ................ Trivy fs: dependency CVEs            ┘
   ├─ 4 IaC scan ........... Trivy config: Dockerfile + K8s YAML     INFRA
   ├─ 5 Unit + security tests (18 tests)                         ┐
   ├─ 6 Build hardened image                                     │  BUILD
   ├─ 7 Image scan ......... Trivy image: OS + app CVEs, secrets ┘
   ├─ 8 Secure deploy ...... Secret, NetworkPolicy, Pod Security "restricted"   DEPLOY
   ├─ 9 DAST ............... 27 attacks against the running app  ┐  RUNTIME
   └─10 Runtime policy ..... PSA rejects root pod, egress blocked,┘
                             read-only filesystem
   reports/ ─► archived on every build (audit evidence)
```

## Security controls by layer

| Layer | Control | Where |
|---|---|---|
| **Application** | Authentication with Bearer tokens, compared in constant time | `app/src/server.js` |
| | **Role-based access**: *doctor* sees the full record; *staff* sees masked name and phone, and the diagnosis is `[REDACTED]` (minimum necessary) | `view()` |
| | **Encryption at rest**: name, phone and diagnosis are encrypted with AES-256-GCM (tamper-evident) | `app/src/phi-crypto.js` |
| | **Audit log**: every PHI access, denial and failed login is logged as JSON (who, what, when, result), **never with PHI values** | `audit()` |
| | Brute-force lockout (HTTP 429), strict input validation, 4 KB body limit, JSON only, generic error messages | |
| | Security headers: strict CSP (no inline scripts), nosniff, frame DENY, no-referrer, HSTS, `Cache-Control: no-store` | `SECURITY_HEADERS` |
| | Fails closed: refuses to start without tokens or a valid 256-bit key | `createServer()` |
| | Zero third-party runtime dependencies, so no dependency CVEs | `package.json` |
| **Container** | Multi-stage build; runtime image has **npm, yarn and corepack removed** and OS packages patched | `Dockerfile` |
| | Runs as non-root UID 10001; app files owned by root (cannot be modified) | |
| **Kubernetes** | Namespace enforces **Pod Security Standard "restricted"** | `k8s/namespace.yaml` |
| | `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, drop **ALL** capabilities, seccomp `RuntimeDefault`, no service-account token, CPU and memory limits | `k8s/deployment.yaml` |
| | **NetworkPolicy**: deny all by default; only inbound HTTP allowed; **no egress**, so a compromised pod cannot exfiltrate data | `k8s/networkpolicy.yaml` |
| | Secrets generated on the cluster, never in git or Jenkins logs (`set +x`) | `Jenkinsfile` stage 8 |
| **Pipeline** | Scanner versions pinned, with SHA-256 verification of the Trivy and Gitleaks downloads | `infra/setup-ec2.sh` |
| | All scan reports archived per build as compliance evidence | `reports/` |

## HIPAA-style mapping (illustrative)

| Safeguard | Implemented by |
|---|---|
| Access control: unique user identification, RBAC | Tokens per role, doctor/staff permissions |
| Minimum necessary | Staff view masks PHI and redacts the diagnosis |
| Audit controls | JSON audit log of every PHI access |
| Integrity | AES-GCM authentication tag detects tampering |
| Transmission security | HSTS header; TLS would be terminated at an ingress or load balancer in production |
| Encryption at rest | AES-256-GCM field-level encryption, key in a Kubernetes Secret |
| Risk analysis and management | Automated SAST, SCA, IaC, image and DAST scans on every commit |

## Files
| Path | Purpose |
|---|---|
| `app/` | Secure app, UI (no inline JS) and 18 functional and security tests |
| `Dockerfile` | test stage → hardened runtime stage |
| `k8s/` | Namespace (PSA restricted), Deployment, Service (NodePort 30100), NetworkPolicies |
| `security/eslint.config.cjs` | SAST rules: high-confidence rules fail the build, noisy ones warn |
| `security/dast-baseline.sh` | DAST: 27 black-box checks against the live app |
| `Jenkinsfile` | The 10-gate DevSecOps pipeline |
| `infra/setup-ec2.sh` | EC2 setup: disk growth, swap, Docker, k3s, Jenkins, Trivy, Gitleaks |

## Setup
1. Launch an Ubuntu EC2 t3.micro and **enlarge the root volume to 20 GB** (the Trivy DB is about 1.6 GB).
   In its security group, allow inbound **22**, **8080** and **30100**.
2. On the instance:
   ```bash
   git clone <this repo> && cd <repo>
   sudo JENKINS_ADMIN_PASSWORD='<password>' bash TASK3/infra/setup-ec2.sh <this repo's https URL>
   ```
3. Jenkins: `http://<EC2-IP>:8080` → job **task9-devsecops** → Build Now
4. Get the demo tokens on the server (they're never printed by the pipeline):
   ```bash
   kubectl -n pbl3-sec get secret meditrack-secrets -o jsonpath='{.data.doctor-token}' | base64 -d; echo
   kubectl -n pbl3-sec get secret meditrack-secrets -o jsonpath='{.data.staff-token}' | base64 -d; echo
   ```
5. App: `http://<EC2-IP>:30100`. Sign in with the staff token (masked) and then the doctor token (full).

## Demo: a security gate blocking a bad commit
Add a hard-coded secret, e.g. `const AWS_KEY = "AKIA…"` in `app/src/server.js`, then commit and push.
Gitleaks fails **stage 1** and nothing is deployed. Revert the commit and the pipeline turns green again.
