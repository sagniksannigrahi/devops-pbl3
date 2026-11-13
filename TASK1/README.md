# DevOps PBL-III

## Task 7: CI/CD pipeline to deploy a Dockerized application on Kubernetes using Jenkins

A small healthcare app (**MediTrack**, a patient-records service) is built, tested and deployed
automatically. Every push to `main` goes through Jenkins, which builds a Docker image and deploys it
to Kubernetes, all on a single **AWS EC2 t3.micro** instance.

```
 Developer ──git push──► GitHub ──(poll every 2 min)──► Jenkins (EC2)
                                                         │
                     ┌───────────────────────────────────┤
                     ▼                                   ▼
          docker build --target test       docker build --target runtime
          (unit tests in a container)        image  meditrack:<build#>
                                                         │
                                                         ▼
                                       kubectl apply → k3s Kubernetes (same EC2)
                                       Deployment (2 replicas, rolling update)
                                       Service NodePort 30080
                                                         │
                                                         ▼
                                       Smoke test /health  → success
                                       (on failure: kubectl rollout undo)
```

### Folder layout (inside `TASK1/`)
| Path | Purpose |
|---|---|
| `app/` | Node.js app (no npm dependencies), its tests, and the web page |
| `Dockerfile` | Multi-stage build: `test` stage runs unit tests, `runtime` stage is the deployed image (runs as a non-root user) |
| `k8s/` | Namespace, Deployment (2 replicas, probes, resource limits) and NodePort Service |
| `Jenkinsfile` | Pipeline: Checkout → Unit Tests → Build Image → (optional) Push to Docker Hub → Deploy to Kubernetes → Smoke Test, with automatic rollback on failure |
| `infra/setup-ec2.sh` | One-shot EC2 setup: swap, Docker, k3s, Jenkins, plugins and the pipeline job |

### Running on a t3.micro (1 GB RAM)
- **2 GB swap file** so Jenkins and Kubernetes fit in memory
- **k3s** instead of full Kubernetes, with Traefik, metrics-server and ServiceLB disabled
- k3s uses the **Docker runtime** (`--docker`), so images Jenkins builds are available to Kubernetes directly: no registry, and only one container runtime using RAM
- Jenkins heap capped at 384 MB, with 1 executor
- The pipeline deletes old images so the 8 GB disk doesn't fill up

### Setup
1. Launch an Ubuntu EC2 instance. In its security group, allow inbound **22**, **8080** (Jenkins) and **30080** (app).
2. SSH in and run:
   ```bash
   git clone <this repo> && cd <repo>
   sudo JENKINS_ADMIN_PASSWORD='<password>' bash TASK1/infra/setup-ec2.sh <this repo's https URL>
   ```
3. Open `http://<EC2-IP>:8080`, log in as `admin`, and run the **task7-cicd-k8s** job.
4. Open the app at `http://<EC2-IP>:30080`.

### Endpoints
| Endpoint | Description |
|---|---|
| `GET /` | Web page showing the version, the pod serving the request, and the patient list |
| `GET /health` | Health check used by Kubernetes probes and the smoke test |
| `GET /api/info` | App version and pod name |
| `GET /api/patients`, `POST /api/patients` | Demo patient records (fictional data) |
