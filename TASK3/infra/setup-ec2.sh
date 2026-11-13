#!/usr/bin/env bash
# One-shot setup for a single Ubuntu EC2 t3.micro (1 GB RAM):
#   swap + Docker + k3s (Kubernetes) + Jenkins + security scanners (Gitleaks, Trivy, OSV-Scanner),
#   with the Task 9 DevSecOps pipeline job pre-created.
#   Fits the default 8 GB disk: vulnerability lookups use OSV-Scanner (online OSV.dev database)
#   instead of Trivy's ~1.6 GB local DB; Trivy is used for IaC, secret scanning and SBOMs.
#
# Usage (on the EC2 instance):
#   sudo JENKINS_ADMIN_PASSWORD='choose-a-password' bash TASK3/infra/setup-ec2.sh https://github.com/<user>/<repo>.git
set -euo pipefail

REPO_URL="${1:?usage: setup-ec2.sh <git repo url>}"
ADMIN_PASS="${JENKINS_ADMIN_PASSWORD:?set JENKINS_ADMIN_PASSWORD}"
JOB_NAME="task9-devsecops"
JENKINS_HOME=/var/lib/jenkins
export DEBIAN_FRONTEND=noninteractive

# pinned scanner versions + SHA-256 checksums (supply-chain protection: a tampered download is rejected)
TRIVY_VERSION=0.76.2
TRIVY_SHA256=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
OSV_VERSION=2.7.1
OSV_SHA256=fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8

echo "==> 0/7 Grow root filesystem (if the EBS volume was enlarged)"
ROOT_SRC=$(findmnt -n -o SOURCE /)
ROOT_DISK=/dev/$(lsblk -no PKNAME "$ROOT_SRC")
ROOT_PART=$(echo "$ROOT_SRC" | grep -o '[0-9]*$')
growpart "$ROOT_DISK" "$ROOT_PART" || true   # "NOCHANGE" if already full size
resize2fs "$ROOT_SRC" || true
df -h /

echo "==> 1/7 Swap (1.5 GB) - required, t3.micro only has 1 GB RAM"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1536M /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> 2/7 Packages: Docker, Git, Java"
apt-get update -y
apt-get install -y docker.io git curl fontconfig
apt-get install -y openjdk-21-jre-headless || apt-get install -y openjdk-25-jre-headless
systemctl enable --now docker
apt-get clean   # free disk space (8 GB root volume)

echo "==> 3/7 k3s (lightweight Kubernetes) using Docker as its container runtime"
# --docker: k3s runs pods with the same Docker daemon Jenkins builds images with,
#           so images are available to Kubernetes without a registry and only one runtime uses RAM.
# disable traefik / metrics-server / servicelb / helm-controller to save memory and disk (we use NodePort services).
if ! command -v k3s >/dev/null; then
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --docker --disable traefik --disable metrics-server --disable servicelb --disable-helm-controller --write-kubeconfig-mode 644" sh -
fi
until kubectl get nodes 2>/dev/null | grep -q ' Ready'; do echo "   waiting for k3s node..."; sleep 5; done
kubectl get nodes

echo "==> 4/7 Security scanners: Gitleaks ${GITLEAKS_VERSION}, Trivy ${TRIVY_VERSION}, OSV-Scanner ${OSV_VERSION} (checksum verified)"
TMPD=$(mktemp -d)
if ! trivy --version 2>/dev/null | grep -q "$TRIVY_VERSION"; then
  curl -fsSL -o "$TMPD/trivy.tgz" "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
  echo "${TRIVY_SHA256}  $TMPD/trivy.tgz" | sha256sum -c -
  tar -xzf "$TMPD/trivy.tgz" -C "$TMPD" trivy && install -m 755 "$TMPD/trivy" /usr/local/bin/trivy
fi
if ! gitleaks version 2>/dev/null | grep -q "$GITLEAKS_VERSION"; then
  curl -fsSL -o "$TMPD/gitleaks.tgz" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  echo "${GITLEAKS_SHA256}  $TMPD/gitleaks.tgz" | sha256sum -c -
  tar -xzf "$TMPD/gitleaks.tgz" -C "$TMPD" gitleaks && install -m 755 "$TMPD/gitleaks" /usr/local/bin/gitleaks
fi
if ! osv-scanner --version 2>/dev/null | grep -q "$OSV_VERSION"; then
  curl -fsSL -o "$TMPD/osv-scanner" "https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}/osv-scanner_linux_amd64"
  echo "${OSV_SHA256}  $TMPD/osv-scanner" | sha256sum -c -
  install -m 755 "$TMPD/osv-scanner" /usr/local/bin/osv-scanner
fi
rm -rf "$TMPD"
trivy --version | head -1; gitleaks version; osv-scanner --version | head -1

echo "==> 5/7 Jenkins (war + systemd, heap capped for the small instance)"
id jenkins >/dev/null 2>&1 || useradd -r -m -d "$JENKINS_HOME" -s /bin/bash jenkins
usermod -aG docker jenkins
mkdir -p /opt/jenkins "$JENKINS_HOME/.kube" "$JENKINS_HOME/init.groovy.d" "$JENKINS_HOME/plugins"
[ -f /opt/jenkins/jenkins.war ] || curl -fsSL -o /opt/jenkins/jenkins.war https://get.jenkins.io/war-stable/latest/jenkins.war
cp /etc/rancher/k3s/k3s.yaml "$JENKINS_HOME/.kube/config"

mkdir -p "$JENKINS_HOME/.cache/trivy" && chown -R jenkins:jenkins "$JENKINS_HOME/.cache"
docker pull -q node:22-alpine   # base image, also scanned for the before/after comparison

echo "==> 6/7 Jenkins plugins"
if [ ! -f /opt/jenkins/plugin-manager.jar ]; then
  PM_URL=$(curl -fsSL https://api.github.com/repos/jenkinsci/plugin-installation-manager-tool/releases/latest \
    | grep -o 'https://[^"]*jenkins-plugin-manager-[^"]*\.jar' | head -1)
  curl -fsSL -o /opt/jenkins/plugin-manager.jar "$PM_URL"
fi
java -Xmx256m -jar /opt/jenkins/plugin-manager.jar \
  --war /opt/jenkins/jenkins.war \
  --plugin-download-directory "$JENKINS_HOME/plugins" \
  --plugins workflow-aggregator git pipeline-stage-view timestamper credentials-binding

# First-boot script: create the admin user and the pipeline job (deleted after Jenkins starts)
cat > "$JENKINS_HOME/init.groovy.d/01-setup.groovy" <<GROOVY
import jenkins.model.*
import hudson.security.*
import hudson.plugins.git.*
import org.jenkinsci.plugins.workflow.job.WorkflowJob
import org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition
import hudson.node_monitors.*

def j = Jenkins.get()
def realm = j.getSecurityRealm()
if (!(realm instanceof HudsonPrivateSecurityRealm)) {
  realm = new HudsonPrivateSecurityRealm(false)
  j.setSecurityRealm(realm)
}
if (realm.getUser('admin') == null) {
  realm.createAccount('admin', '${ADMIN_PASS}')
}
def auth = new FullControlOnceLoggedInAuthorizationStrategy()
auth.setAllowAnonymousRead(false)
j.setAuthorizationStrategy(auth)
j.setNumExecutors(1)
// the 8 GB root disk has ~1 GB free; the default 1 GB limit would take the build node offline
hudson.model.ComputerSet.getMonitors().replace(new DiskSpaceMonitor('300MB'))
hudson.model.ComputerSet.getMonitors().replace(new TemporarySpaceMonitor('300MB'))

if (j.getItem('${JOB_NAME}') == null) {
  def scm = new GitSCM(GitSCM.createRepoList('${REPO_URL}', null),
                       [new BranchSpec('*/main')], null, null, [])
  def job = j.createProject(WorkflowJob, '${JOB_NAME}')
  job.setDescription('Task 9: DevSecOps pipeline for the MediTrack healthcare app: Gitleaks, ESLint SAST, Trivy SCA/IaC/image scans, DAST and runtime policy checks, deployed to hardened Kubernetes (k3s) on AWS EC2')
  job.setDefinition(new CpsScmFlowDefinition(scm, 'TASK3/Jenkinsfile'))
  job.save()
}
j.save()
GROOVY
chown -R jenkins:jenkins "$JENKINS_HOME"

cat > /etc/systemd/system/jenkins.service <<UNIT
[Unit]
Description=Jenkins
After=network.target docker.service k3s.service

[Service]
User=jenkins
Group=jenkins
Environment=JENKINS_HOME=$JENKINS_HOME
ExecStart=/usr/bin/java -Xms128m -Xmx384m -XX:+UseSerialGC -Djava.awt.headless=true -Djenkins.install.runSetupWizard=false -jar /opt/jenkins/jenkins.war --httpPort=8080
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable jenkins
systemctl restart jenkins

echo "==> 7/7 Waiting for Jenkins to come up (2-4 minutes on a t3.micro)..."
until curl -fs -o /dev/null http://localhost:8080/login; do sleep 10; done
rm -f "$JENKINS_HOME/init.groovy.d/01-setup.groovy"   # contains the password - remove after first boot

PUBLIC_IP=$(TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'); \
  curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
echo
echo "Setup complete."
echo "  Jenkins : http://${PUBLIC_IP}:8080   (user: admin)"
echo "  App     : http://${PUBLIC_IP}:30100  (after the first pipeline run)"
free -m
df -h /
