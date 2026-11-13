# Task 8: Automated Blue-Green Deployment using Jenkins, Kubernetes and Docker

The MediTrack healthcare app runs as **two environments side by side, BLUE and GREEN**.
Only one is live. Jenkins deploys every new release to the **idle** environment, tests it there,
and then switches all traffic in one step. There's no downtime, and the old version keeps running, so
**rollback is instant**.

Runs on its own **AWS EC2 t3.micro** (separate from Task 7), with Jenkins and k3s Kubernetes.

```
                         Kubernetes namespace: pbl3-bg
                   ┌────────────────────────────────────────────┐
  Users ──:30090──►│ Service meditrack-live  ──selector color=──┼──► Deployment meditrack-blue  (v1)
                   │                                            │
  Tester ─:30091──►│ Service meditrack-preview ─selector color=─┼──► Deployment meditrack-green (v2)
                   └────────────────────────────────────────────┘
          Jenkins switches traffic by patching the Services' "color" selector
```

### Pipeline (`Jenkinsfile`)
| # | Stage | What happens |
|---|---|---|
| 1 | Checkout | Pull the latest commit from GitHub (polled every 2 minutes) |
| 2 | Prepare Cluster | Create the namespace and the live/preview Services (first run only) |
| 3 | Detect Live Color | Read which color the live Service points to; the **other** color is idle |
| 4 | Unit Tests | `docker build --target test` runs the test suite in a container |
| 5 | Build Docker Image | `meditrack-bg:<build#>` |
| 6 | Deploy to Idle Color | Apply the Deployment for the idle color with the new image; wait for it to be ready |
| 7 | Test Idle Color (Preview) | Point the preview Service (30091) at the new color and check its version, color, health and API, while users are untouched |
| 8 | Approval: Switch Traffic? | Manual **"Switch traffic"** button in Jenkins (can be turned off with `REQUIRE_APPROVAL`) |
| 9 | Switch Traffic | Patch the live Service selector to the new color: an instant cut-over |
| 10 | Verify Live | Check that the live port serves the new version; **if it fails, switch back automatically** |

**Rollback:** run the job with **Build with Parameters → ACTION = rollback**. This switches live traffic
back to the other color immediately, with no rebuild.

### Files
| Path | Purpose |
|---|---|
| `app/` | MediTrack app; the page shows a **blue or green banner** with the version |
| `Dockerfile` | Multi-stage build (test → runtime, non-root user) |
| `k8s/deployment.yaml` | One template; the pipeline turns it into `meditrack-blue` or `meditrack-green` |
| `k8s/services.yaml` | `meditrack-live` (NodePort 30090) and `meditrack-preview` (NodePort 30091) |
| `Jenkinsfile` | The blue-green pipeline above |
| `infra/setup-ec2.sh` | EC2 setup: swap, Docker, k3s, Jenkins and the `task8-blue-green` job |

### Setup
1. Launch an Ubuntu EC2 t3.micro. In its security group, allow inbound **22**, **8080**, **30090** and **30091**.
2. On the instance:
   ```bash
   git clone <this repo> && cd <repo>
   sudo JENKINS_ADMIN_PASSWORD='<password>' bash TASK2/infra/setup-ec2.sh <this repo's https URL>
   ```
3. Jenkins: `http://<EC2-IP>:8080` → job **task8-blue-green**

### Demo flow
1. Run the job: v1 goes live on **BLUE** → `http://<EC2-IP>:30090` shows a blue banner.
2. Change something in `TASK2/app/`, then commit and push. Jenkins deploys v2 to **GREEN**.
   `http://<EC2-IP>:30091` shows green v2 while 30090 is still blue v1.
3. In Jenkins, click **Switch traffic**. Refresh 30090: it is now **GREEN v2**.
4. Run with **ACTION = rollback**. 30090 is back to **BLUE v1** instantly.
